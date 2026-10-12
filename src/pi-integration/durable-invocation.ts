/** Bridges native submissions/finalized responses to SEPT policy; native tasks own tool execution. */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  GenerationTask,
  hook,
  type Conversation,
  type HookRegistration,
  type Harness,
  type Submission,
} from "@earendil-works/pi-durable";
import { SeptError, type Manifest, type OperatorMessage, type RunStore } from "../durable/index.js";
import { NOOP_TELEMETRY, type Observability } from "../observability/index.js";
import type { SessionRunResult } from "./contracts.js";
import { operatorBlock, ROTATION_RECOVERY_PROMPT, ROTATION_STEER } from "./prompts.js";
import { readDurableAdmission, writeDurableAdmission } from "./durable-admission.js";
import {
  loadRolloverEvidence,
  MAX_UNUSABLE_USAGE_SAMPLES,
  recordUnusableSample,
  recordUsableSample,
  saveRolloverEvidence,
  type RolloverEvidence,
} from "./rollover-evidence.js";
import { providerContextTokens } from "./rollover.js";
import { sessionMessageText } from "./message-text.js";

/** Owns finalized usage and native steering for one currently bound durable conversation. */
export class DurableInvocation {
  private conversation: Conversation | undefined;
  private evidence: RolloverEvidence | undefined;
  private steer: Promise<Submission> | undefined;
  private preRotationText: string | undefined;
  private violation: unknown;
  private recoveredMessages: Submission[] = [];

  public constructor(
    private readonly manifest: Manifest,
    private readonly store: RunStore,
    private readonly contextWindow: number,
    private readonly telemetry: Observability = NOOP_TELEMETRY,
  ) {}

  /** Bind restored/fresh identity before allowing the native scheduler to dispatch. */
  public bind(conversation: Conversation): void {
    this.conversation = conversation;
    this.evidence = loadRolloverEvidence(
      this.store,
      this.manifest.provider,
      this.manifest.model,
      String(conversation.id),
      this.contextWindow,
    );
    this.steer = undefined;
    this.preRotationText = undefined;
  }

  /** Native hooks contain errors explicitly because ordinary Harness hook throws are advisory. */
  public hooks(): HookRegistration[] {
    return [hook(GenerationTask, { afterResponse: (message) => this.observe(message) })];
  }

  /** Hold a native advisory failure for explicit settlement by the installed controller. */
  public report(error: unknown): void {
    this.violation ??= error;
  }

  private async observe(message: AssistantMessage): Promise<void> {
    try {
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return;
      }
      const evidence = this.requireEvidence();
      if (evidence.rotationRequired) {
        return;
      }
      this.recordSample(evidence, providerContextTokens(message.usage));
      if (this.requireEvidence().rotationRequired) {
        this.preRotationText = sessionMessageText(message) || undefined;
        await this.queueSteer();
      }
    } catch (error: unknown) {
      this.report(error);
    }
  }

  private recordSample(evidence: RolloverEvidence, tokens: number | undefined): void {
    const invalid = tokens === undefined || tokens > this.contextWindow;
    const regressed =
      tokens !== undefined && evidence.lastTokens !== undefined && tokens < evidence.lastTokens;
    if (invalid || regressed) {
      this.evidence = recordUnusableSample(evidence);
      this.store.event("context_sample_deferred", {
        sessionId: String(this.requireConversation().id),
        provenance: "provider_reported",
        reason: regressed ? "usage_regressed" : "usage_unavailable",
        consecutive: this.evidence.unusableSamples,
      });
      this.telemetry.event("sept.context.deferred", { "sept.outcome": "deferred" });
    } else {
      const recorded = recordUsableSample(evidence, tokens);
      this.evidence = recorded.evidence;
      this.store.event("context_sample", {
        sessionId: String(this.requireConversation().id),
        provenance: "provider_reported",
        tokens,
        contextWindow: this.contextWindow,
        percent: (tokens / this.contextWindow) * 100,
        ...recorded.decision,
      });
      this.telemetry.event("sept.context.sampled", {
        "sept.context.tokens": tokens,
        "sept.context.window": this.contextWindow,
        "sept.context.pressure": tokens / this.contextWindow,
      });
    }
    saveRolloverEvidence(this.store, this.requireEvidence());
  }

  private queueSteer(): Promise<Submission> {
    this.steer ??= this.admitSteer();
    return this.steer;
  }

  private async admitSteer(): Promise<Submission> {
    const conversation = this.requireConversation();
    const requestId = `sept-rollover-${String(conversation.id)}`;
    const existing = await conversation.commit(
      (tx) => tx.submissionByRequest(conversation.id, requestId),
      BACKGROUND_CONTEXT,
    );
    if (existing === undefined) {
      this.store.event("rotation_steer_queued", {
        sessionId: String(this.requireConversation().id),
        engine: "pi-durable",
        provenance: "provider_reported",
      });
      this.telemetry.event("sept.rotation.steer_queued", { "sept.rotation": true });
    }
    return conversation.submit(
      {
        type: "input",
        content: ROTATION_STEER,
        requestId,
        whenBusy: "steer",
      },
      BACKGROUND_CONTEXT,
    );
  }

  private requireEvidence(): RolloverEvidence {
    if (this.evidence === undefined) {
      throw new SeptError("Pi Durable rollover owner is not bound");
    }
    return this.evidence;
  }

  private requireConversation(): Conversation {
    if (this.conversation === undefined) {
      throw new SeptError("Pi Durable conversation is not bound");
    }
    return this.conversation;
  }

  private async submission(
    harness: Harness,
    prompt: string,
    messages: readonly OperatorMessage[],
  ): Promise<Submission> {
    const conversation = this.requireConversation();
    const pending = (await harness.inspect(BACKGROUND_CONTEXT)).submissions.find(
      (entry) =>
        entry.conversationId === conversation.id &&
        entry.type === "input" &&
        entry.requestId?.startsWith("sept-invocation-"),
    );
    if (pending !== undefined) {
      const restored = await harness.submission(pending.id, BACKGROUND_CONTEXT);
      if (restored === undefined) {
        throw new SeptError("Pi Durable lost an admitted submission");
      }
      const admittedIds = readDurableAdmission(this.store, conversation.id, pending.requestId);
      await this.forwardRecoveredMessages(admittedIds);
      return restored;
    }
    const requestId = `sept-invocation-${String(this.store.snapshot().invocations)}`;
    writeDurableAdmission(this.store, conversation.id, requestId, messages);
    return conversation.submit(
      {
        type: "input",
        content: prompt,
        requestId,
      },
      BACKGROUND_CONTEXT,
    );
  }

  private async forwardRecoveredMessages(admittedIds: readonly string[]): Promise<void> {
    for (const message of this.store.pendingMessages()) {
      if (admittedIds.includes(message.id)) {
        continue;
      }
      this.recoveredMessages.push(
        await this.requireConversation().submit(
          {
            type: "input",
            content: operatorBlock([message]),
            requestId: `sept-operator-${message.id}`,
            whenBusy: "steer",
          },
          BACKGROUND_CONTEXT,
        ),
      );
    }
  }

  private async wait(submission: Submission): Promise<void> {
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.status !== "done") {
      throw new SeptError("Pi Durable submission did not finish successfully");
    }
  }

  /** Invoke or reattach native durable work and return the existing bounded SEPT result contract. */
  public async run(
    harness: Harness,
    prompt: string,
    messages: readonly OperatorMessage[] = [],
  ): Promise<SessionRunResult> {
    this.recoveredMessages = [];
    if (this.requireEvidence().unusableSamples >= MAX_UNUSABLE_USAGE_SAMPLES) {
      throw new SeptError("Provider usage is incompatible with safe autonomous rollover");
    }
    if (this.requireEvidence().rotationRequired) {
      await this.recoverRotation();
      return this.result();
    }
    await this.wait(await this.submission(harness, prompt, messages));
    for (const message of this.recoveredMessages) {
      await this.wait(message);
    }
    if (this.requireEvidence().rotationRequired) {
      await this.wait(await this.queueSteer());
    }
    return this.result();
  }

  private async recoverRotation(): Promise<void> {
    const conversation = this.requireConversation();
    const entries = await conversation.entries({}, 250, undefined, BACKGROUND_CONTEXT);
    const marker = entries.items.findIndex((entry) =>
      entry.model?.some(
        (message) => message.role === "user" && sessionMessageText(message) === ROTATION_STEER,
      ),
    );
    if (marker >= 0) {
      const predecessor = entries.items.slice(marker + 1).find((entry) => AssistantEntry.is(entry));
      this.preRotationText =
        sessionMessageText(predecessor?.model?.find((message) => message.role === "assistant")) ||
        undefined;
    }
    let submission = await this.queueSteer();
    const status = await submission.status(BACKGROUND_CONTEXT);
    if (status.status === "unanswered") {
      submission = await conversation.submit(
        {
          type: "input",
          content: ROTATION_RECOVERY_PROMPT,
          requestId: `sept-rollover-recovery-${String(conversation.id)}`,
        },
        BACKGROUND_CONTEXT,
      );
    }
    await this.wait(submission);
  }

  private async result(): Promise<SessionRunResult> {
    if (this.violation !== undefined) {
      throw new SeptError("Pi Durable reported an invocation failure", { cause: this.violation });
    }
    const evidence = this.requireEvidence();
    if (evidence.unusableSamples >= MAX_UNUSABLE_USAGE_SAMPLES) {
      throw new SeptError("Provider usage is incompatible with safe autonomous rollover");
    }
    const entries = await this.requireConversation().entries(
      {},
      250,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const assistant = entries.items.find((entry) => AssistantEntry.is(entry));
    const message = assistant?.model?.find((entry) => entry.role === "assistant");
    if (message === undefined) {
      throw new SeptError("Pi Durable ended without a finalized assistant response");
    }
    return {
      text: sessionMessageText(message),
      ...(this.preRotationText === undefined ? {} : { preRotationText: this.preRotationText }),
      steered: evidence.rotationRequired,
      contextTokens: evidence.lastTokens ?? null,
      contextWindow: this.contextWindow,
    };
  }
}
