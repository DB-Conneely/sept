/**
 * Applies assistant-authored control and rotation outcomes to durable run state. Invocation transport
 * is upstream and Pi session replacement is delegated to RuntimeSessionLifecycle; this module owns
 * fsync-before-transition ordering, late-message deferral, and terminal/waiting publication.
 */

import {
  parseJsonObject,
  validateHandover,
  validateWorkResponse,
  type DurableHandover,
  type Manifest,
  type OperatorMessage,
  type RunSnapshot,
  type RunStore,
  type WorkControl,
} from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import type { SessionHost, SessionRunResult } from "../pi-integration/index.js";
import { enforceEpochLimit, updateRuntimeSnapshot } from "./runtime-state.js";
import { RuntimeSessionLifecycle } from "./session-lifecycle.js";

/** State carried into the next invocation, or a stop decision at a safe durable boundary. */
export type RuntimeTransition =
  | {
      kind: "continue";
      control: WorkControl | undefined;
      successorHandover: DurableHandover | undefined;
    }
  | { kind: "stop" };

/** Persists and publishes assistant lifecycle outcomes without owning Pi execution. */
export class RuntimeTransitions {
  public constructor(
    private readonly store: RunStore,
    private readonly manifest: Manifest,
    private readonly telemetry: Observability,
    private readonly sessions: RuntimeSessionLifecycle,
    private readonly shouldStop: () => boolean,
  ) {}

  /** Persist a rollover handover before replacing the native predecessor session. */
  public async rotate(
    host: SessionHost,
    result: SessionRunResult,
    snapshot: RunSnapshot,
    invocation: number,
    messages: OperatorMessage[],
  ): Promise<RuntimeTransition> {
    this.telemetry.event("sept.rotation.requested", {
      "sept.epoch": snapshot.epoch,
      "sept.invocation": invocation,
    });
    this.telemetry.log("pi.rotation.requested", {
      "sept.run.id": this.store.runId,
      "sept.epoch": snapshot.epoch,
      "sept.invocation": invocation,
    });
    this.recordPreRotationMessage(result.preRotationText, snapshot, invocation);
    const handover = validateHandover(parseJsonObject(result.text));
    const durable = this.store.persistHandover(
      snapshot.epoch,
      host.sessionId,
      host.sessionFile,
      handover,
      messages,
    );
    this.recordDurableHandover(snapshot, invocation, messages.length);
    enforceEpochLimit(this.manifest, this.store.snapshot());
    if (this.shouldStop()) {
      return { kind: "stop" };
    }
    const replaced = await this.sessions.replace(host, this.manifest, snapshot);
    return replaced
      ? { kind: "continue", control: undefined, successorHandover: durable }
      : { kind: "stop" };
  }

  private recordPreRotationMessage(
    text: string | undefined,
    snapshot: RunSnapshot,
    invocation: number,
  ): void {
    if (text === undefined) {
      return;
    }
    try {
      const response = validateWorkResponse(parseJsonObject(text));
      if (response.message !== undefined) {
        this.store.conversationMessage(
          `assistant-${String(snapshot.epoch)}-${String(invocation)}`,
          "assistant",
          response.message,
        );
      }
    } catch {
      this.store.event("conversation_message_deferred", {
        epoch: snapshot.epoch,
        invocation,
        reason: "invalid_pre_rotation_response",
      });
    }
  }

  private recordDurableHandover(
    snapshot: RunSnapshot,
    invocation: number,
    queueDepth: number,
  ): void {
    this.telemetry.setQueueDepth(this.store.pendingMessages().length);
    this.telemetry.event("sept.handover.durable", {
      "sept.epoch": snapshot.epoch,
      "sept.queue.depth": queueDepth,
    });
    this.telemetry.log("handover.durable", {
      "sept.run.id": this.store.runId,
      "sept.epoch": snapshot.epoch,
      "sept.invocation": invocation,
      "sept.queue.depth": queueDepth,
    });
  }

  /** Validate, checkpoint, and publish one ordinary assistant control response. */
  public control(
    host: SessionHost,
    result: SessionRunResult,
    snapshot: RunSnapshot,
    invocation: number,
    messages: OperatorMessage[],
  ): RuntimeTransition {
    const response = validateWorkResponse(parseJsonObject(result.text));
    const control = response.control;
    if (response.message !== undefined) {
      this.store.conversationMessage(
        `assistant-${String(snapshot.epoch)}-${String(invocation)}`,
        "assistant",
        response.message,
      );
    }
    this.store.checkpoint(control, messages, host.sessionId);
    this.recordCheckpoint(control, snapshot, invocation, messages.length);
    const deferred = this.deferForLateMessages(control);
    if (deferred !== undefined) {
      return { kind: "continue", control: deferred, successorHandover: undefined };
    }
    this.publishStatus(control, host, snapshot, invocation);
    return this.shouldStop()
      ? { kind: "stop" }
      : { kind: "continue", control, successorHandover: undefined };
  }

  private recordCheckpoint(
    control: WorkControl,
    snapshot: RunSnapshot,
    invocation: number,
    queueDepth: number,
  ): void {
    this.telemetry.setQueueDepth(this.store.pendingMessages().length);
    this.telemetry.event("sept.checkpoint.durable", {
      "sept.outcome": control.status,
      "sept.epoch": snapshot.epoch,
      "sept.invocation": invocation,
      "sept.queue.depth": queueDepth,
    });
    this.telemetry.log("checkpoint.durable", {
      "sept.run.id": this.store.runId,
      "sept.run.state": control.status,
      "sept.epoch": snapshot.epoch,
      "sept.invocation": invocation,
      "sept.queue.depth": queueDepth,
    });
  }

  private deferForLateMessages(control: WorkControl): WorkControl | undefined {
    if (control.status === "continue") {
      return undefined;
    }
    const messages = this.store.pendingMessages();
    this.telemetry.setQueueDepth(messages.length);
    if (messages.length === 0) {
      return undefined;
    }
    const event =
      control.status === "waiting" ? "waiting_status_deferred" : "terminal_status_deferred";
    this.store.event(event, {
      attemptedStatus: control.status,
      messageIds: messages.map((message) => message.id),
    });
    this.telemetry.event("sept.transition.deferred", {
      "sept.outcome": control.status,
      "sept.queue.depth": messages.length,
    });
    this.telemetry.log("run.transition.deferred", {
      "sept.run.id": this.store.runId,
      "sept.run.state": control.status,
      "sept.queue.depth": messages.length,
    });
    return {
      status: "continue",
      summary: `${control.status} status was deferred because operator input arrived during the invocation.`,
      verification: control.verification,
      next_action:
        "Apply the newly accepted operator messages before deciding the next lifecycle state.",
    };
  }

  private publishStatus(
    control: WorkControl,
    host: SessionHost,
    snapshot: RunSnapshot,
    invocation: number,
  ): void {
    switch (control.status) {
      case "complete":
        this.publishComplete(control, snapshot, invocation);
        return;
      case "blocked":
        this.publishBlocked(control, snapshot, invocation);
        return;
      case "waiting":
        this.publishWaiting(control, host, snapshot, invocation);
        return;
      case "continue":
        return;
    }
  }

  private publishComplete(control: WorkControl, snapshot: RunSnapshot, invocation: number): void {
    updateRuntimeSnapshot(this.store, {
      status: "complete",
      phase: "terminal",
      reason: control.summary,
      terminalCause: undefined,
    });
    this.store.event("run_completed", {
      summary: control.summary,
      verification: control.verification,
    });
    this.store.ensureTerminalConversation();
    this.telemetry.runOutcome("complete");
    this.recordPublished("complete", snapshot.epoch, invocation);
  }

  private publishBlocked(control: WorkControl, snapshot: RunSnapshot, invocation: number): void {
    updateRuntimeSnapshot(this.store, {
      status: "blocked",
      phase: "terminal",
      reason: control.summary,
      terminalCause: "agent_blocked",
    });
    this.store.event("run_blocked", {
      summary: control.summary,
      nextAction: control.next_action,
    });
    this.store.ensureTerminalConversation();
    this.telemetry.runOutcome("blocked");
    this.recordPublished("blocked", snapshot.epoch, invocation);
  }

  private publishWaiting(
    control: WorkControl,
    host: SessionHost,
    snapshot: RunSnapshot,
    invocation: number,
  ): void {
    updateRuntimeSnapshot(this.store, {
      status: "waiting",
      phase: "waiting",
      reason: control.summary,
      terminalCause: undefined,
    });
    this.store.event("run_waiting", {
      summary: control.summary,
      nextAction: control.next_action,
      sessionId: host.sessionId,
      sessionFile: host.sessionFile,
    });
    this.store.conversationState(
      `waiting-${String(snapshot.epoch)}-${String(invocation)}`,
      "waiting",
    );
    this.recordPublished("waiting", snapshot.epoch, invocation);
  }

  private recordPublished(
    status: "complete" | "blocked" | "waiting",
    epoch: number,
    invocation: number,
  ): void {
    this.telemetry.setRunState(status, epoch, invocation, 0);
    this.telemetry.log(`run.${status}`, {
      "sept.run.id": this.store.runId,
      "sept.run.state": status,
      "sept.epoch": epoch,
      "sept.invocation": invocation,
      "sept.outcome": status,
    });
  }
}
