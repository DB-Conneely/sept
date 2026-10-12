/**
 * Drives repeated prompts within one already-reconciled native Pi session. It owns prompt selection,
 * invocation counters/deadlines, delivery-attempt evidence, and invocation telemetry; durable
 * lifecycle outcomes and fresh-session replacement are delegated to RuntimeTransitions.
 */

import {
  type DurableHandover,
  type Manifest,
  type OperatorMessage,
  type RunSnapshot,
  type RunStore,
  type WorkControl,
} from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError } from "../observability/index.js";
import {
  continuationPrompt,
  initialPrompt,
  successorPrompt,
  type SessionHost,
  type SessionRunResult,
} from "../pi-integration/index.js";
import {
  enforceInvocationLimits,
  runWithActiveDeadline,
  RuntimeLimitError,
  updateRuntimeSnapshot,
} from "./runtime-state.js";
import { RuntimeTransitions, type RuntimeTransition } from "./transitions.js";

/** Executes active invocations until durable state, shutdown, or cancellation ends the cycle. */
export class RuntimeInvocationLoop {
  private control: WorkControl | undefined;
  private successorHandover: DurableHandover | undefined;
  private first = true;

  public constructor(
    private readonly store: RunStore,
    private readonly manifest: Manifest,
    private readonly telemetry: Observability,
    private readonly transitions: RuntimeTransitions,
    private readonly shouldStop: () => boolean,
    private readonly cancellationRequested: () => boolean,
  ) {}

  /** Run the active loop, beginning with any durable predecessor handover recovered at startup. */
  public async run(
    host: SessionHost,
    successorHandover: DurableHandover | undefined,
  ): Promise<void> {
    this.successorHandover = successorHandover;
    while (this.store.snapshot().status === "active") {
      if (this.shouldStop()) {
        return;
      }
      const transition = await this.step(host);
      if (transition.kind === "stop") {
        return;
      }
      this.control = transition.control;
      this.successorHandover = transition.successorHandover;
    }
  }

  private async step(host: SessionHost): Promise<RuntimeTransition> {
    const snapshot = this.store.snapshot();
    enforceInvocationLimits(this.manifest, snapshot);
    const messages = this.store.pendingMessages();
    this.recordDelivery(host, snapshot, messages);
    const prompt = this.prompt(snapshot, messages);
    const invocation = snapshot.invocations + 1;
    this.recordInvocationStart(host, snapshot, invocation, messages);
    const result = await this.invoke(host, prompt, snapshot, invocation, messages);
    if (result === undefined) {
      return { kind: "stop" };
    }
    this.store.log({
      type: "assistant_terminal",
      sessionId: host.sessionId,
      steered: result.steered,
      textBytes: Math.min(Buffer.byteLength(result.text), 64_001),
    });
    return result.steered
      ? this.transitions.rotate(host, result, snapshot, invocation, messages)
      : this.transitions.control(host, result, snapshot, invocation, messages);
  }

  private recordDelivery(
    host: SessionHost,
    snapshot: RunSnapshot,
    messages: OperatorMessage[],
  ): void {
    this.telemetry.setRunState(
      snapshot.status,
      snapshot.epoch,
      snapshot.invocations,
      messages.length,
    );
    this.store.deliveryAttempt(messages, host.sessionId);
    if (messages.length > 0) {
      this.telemetry.event("sept.operator.delivery", {
        "sept.queue.depth": messages.length,
        "sept.epoch": snapshot.epoch,
        "sept.invocation": snapshot.invocations + 1,
      });
    }
  }

  private prompt(snapshot: RunSnapshot, messages: OperatorMessage[]): string {
    let prompt: string;
    if (this.successorHandover !== undefined) {
      prompt = successorPrompt(this.manifest, this.successorHandover, messages);
      this.successorHandover = undefined;
    } else if (this.control !== undefined) {
      prompt = continuationPrompt(this.control, messages);
    } else {
      const continuity =
        this.first && snapshot.invocations > 0 ? this.store.recoveryContext() : undefined;
      prompt = initialPrompt(this.manifest, continuity);
      if (messages.length > 0) {
        prompt += `\n\n${JSON.stringify({ operatorMessages: messages }, null, 2)}`;
      }
    }
    this.first = false;
    return prompt;
  }

  private recordInvocationStart(
    host: SessionHost,
    snapshot: RunSnapshot,
    invocation: number,
    messages: OperatorMessage[],
  ): void {
    updateRuntimeSnapshot(this.store, {
      invocations: invocation,
      activeSessionId: host.sessionId,
      activeSessionFile: host.sessionFile,
    });
    this.store.event("pi_invocation_started", {
      invocation,
      epoch: snapshot.epoch,
      sessionId: host.sessionId,
      messageIds: messages.map((message) => message.id),
    });
    this.telemetry.setRunState("active", snapshot.epoch, invocation, messages.length);
    this.telemetry.log("pi.invocation.started", {
      "sept.run.id": this.store.runId,
      "sept.epoch": snapshot.epoch,
      "sept.invocation": invocation,
      "sept.queue.depth": messages.length,
    });
  }

  private async invoke(
    host: SessionHost,
    prompt: string,
    snapshot: RunSnapshot,
    invocation: number,
    messages: readonly OperatorMessage[],
  ): Promise<SessionRunResult | undefined> {
    const started = Date.now();
    try {
      const result = await this.spanInvocation(host, prompt, snapshot, invocation, messages);
      if (this.cancellationRequested()) {
        return undefined;
      }
      this.recordInvocationSuccess(result, snapshot, invocation, messages.length, started);
      return result;
    } catch (error: unknown) {
      this.recordInvocationFailure(error, snapshot, invocation, started);
      throw error;
    }
  }

  private async spanInvocation(
    host: SessionHost,
    prompt: string,
    snapshot: RunSnapshot,
    invocation: number,
    messages: readonly OperatorMessage[],
  ): Promise<SessionRunResult> {
    return this.telemetry.span(
      "sept.pi.invoke",
      {
        "sept.run.id": this.store.runId,
        "sept.epoch": snapshot.epoch,
        "sept.invocation": invocation,
        "sept.queue.depth": messages.length,
      },
      async () => {
        const result = await runWithActiveDeadline(
          this.store,
          host,
          prompt,
          this.manifest,
          messages,
        );
        this.telemetry.contextSample(
          result.contextTokens,
          result.contextWindow,
          snapshot.epoch,
          invocation,
        );
        this.telemetry.setSpanFields({
          "sept.rotation": result.steered,
          "sept.outcome": "success",
        });
        return result;
      },
    );
  }

  private recordInvocationSuccess(
    result: SessionRunResult,
    snapshot: RunSnapshot,
    invocation: number,
    queueDepth: number,
    started: number,
  ): void {
    const duration = Date.now() - started;
    this.telemetry.invocationFinished(duration, "success", result.steered);
    this.telemetry.log("pi.invocation.finished", {
      "sept.run.id": this.store.runId,
      "sept.epoch": snapshot.epoch,
      "sept.invocation": invocation,
      "sept.outcome": "success",
      "sept.rotation": result.steered,
      "sept.queue.depth": queueDepth,
      duration_ms: duration,
    });
  }

  private recordInvocationFailure(
    error: unknown,
    snapshot: RunSnapshot,
    invocation: number,
    started: number,
  ): void {
    const duration = Date.now() - started;
    const timedOut = error instanceof RuntimeLimitError && error.cause === "timeout";
    this.telemetry.invocationFinished(duration, timedOut ? "timeout" : "failure");
    this.telemetry.log(
      "pi.invocation.finished",
      {
        "sept.run.id": this.store.runId,
        "sept.epoch": snapshot.epoch,
        "sept.invocation": invocation,
        "sept.outcome": timedOut ? "timeout" : "failure",
        "error.type": classifyError(error),
        duration_ms: duration,
      },
      "error",
    );
  }
}
