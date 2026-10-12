/** Bridges native submissions/finalized responses to SEPT policy; native tasks own tool execution. */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  GenerationTask,
  ToolTask,
  hook,
  type Conversation,
  type HookRegistration,
  type Harness,
  type Submission,
  type EntryId,
} from "@earendil-works/pi-durable";
import {
  SeptError,
  type Manifest,
  type OperatorMessage,
  type RunStore,
  type WorkResponse,
} from "../durable/index.js";
import { NOOP_TELEMETRY, type Observability } from "../observability/index.js";
import type {
  SessionRunResult,
  SessionResponseValidator,
  ValidatedSessionResponse,
} from "./contracts.js";
import { ROTATION_RECOVERY_PROMPT, ROTATION_STEER } from "./prompts.js";
import { readInvocationAdmission } from "./durable-admission.js";
import { DurableSubmission } from "./durable-submission.js";
import { DurableGuard } from "./durable-guard.js";
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
  private readonly guard = new DurableGuard();
  private readonly submissions: DurableSubmission;
  private validate: SessionResponseValidator | undefined;
  private validated: { text: string; response: ValidatedSessionResponse } | undefined;
  private preRotationResponse: WorkResponse | undefined;

  public constructor(
    private readonly manifest: Manifest,
    private readonly store: RunStore,
    private readonly contextWindow: number,
    private readonly telemetry: Observability = NOOP_TELEMETRY,
  ) {
    this.submissions = new DurableSubmission(store);
  }

  /** Bind restored/fresh identity before allowing the native scheduler to dispatch. */
  public bind(conversation: Conversation): void {
    this.conversation = conversation;
    this.submissions.bind(conversation);
    this.evidence = loadRolloverEvidence(
      this.store,
      this.manifest.provider,
      this.manifest.model,
      String(conversation.id),
      this.contextWindow,
    );
    this.steer = undefined;
    this.preRotationText = undefined;
    this.preRotationResponse = undefined;
  }

  /** Native hooks contain errors explicitly because ordinary Harness hook throws are advisory. */
  public hooks(): HookRegistration[] {
    return [
      hook(GenerationTask, {
        beforeRequest: () => {
          this.guard.assertHealthy();
          return undefined;
        },
        afterResponse: (message) => this.observe(message),
      }),
      hook(ToolTask, {
        beforeTool: () => {
          this.guard.assertHealthy();
          return undefined;
        },
      }),
    ];
  }

  /** Attach the supported native stop seam before any submission can enable scheduling. */
  public bindHarness(harness: Harness): void {
    this.guard.bind(harness);
  }

  /** Original uncheckpointed request count, including already-settled native work. */
  public get recoveryInvocation(): number | undefined {
    return this.submissions.recoveryInvocation;
  }

  /** Release the bounded invocation identity only after the domain transition is durable. */
  public acknowledge(result: SessionRunResult): void {
    if (result.requestId !== undefined) {
      this.submissions.acknowledge(result.requestId);
    }
  }

  /** Hold a native advisory failure for explicit settlement by the installed controller. */
  public report(error: unknown): void {
    this.guard.report(error);
  }

  private async observe(message: AssistantMessage): Promise<void> {
    try {
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return;
      }
      const evidence = this.requireEvidence();
      if (evidence.rotationRequired) {
        this.validateFinal(message, "handover");
        return;
      }
      this.recordSample(evidence, providerContextTokens(message.usage));
      this.validateFinal(message, "control");
      if (this.requireEvidence().rotationRequired) {
        this.preRotationText = sessionMessageText(message) || undefined;
        this.preRotationResponse =
          this.validated?.response.kind === "control"
            ? this.validated.response.response
            : undefined;
        await this.queueSteer();
      }
    } catch (error: unknown) {
      this.report(error);
    }
  }

  private validateFinal(message: AssistantMessage, kind: "control" | "handover"): void {
    const calls = message.content.some((entry) => entry.type === "toolCall");
    if (this.validate !== undefined && !calls) {
      const text = sessionMessageText(message);
      this.validated = { text, response: this.validate(text, kind) };
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
    if (this.requireEvidence().unusableSamples >= MAX_UNUSABLE_USAGE_SAMPLES) {
      throw new SeptError("Provider usage is incompatible with safe autonomous rollover");
    }
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

  /** Invoke or reattach native durable work and return the existing bounded SEPT result contract. */
  public async run(
    harness: Harness,
    prompt: string,
    messages: readonly OperatorMessage[] = [],
    validate?: SessionResponseValidator,
  ): Promise<SessionRunResult> {
    this.validate = validate;
    this.validated = undefined;
    try {
      return await this.invoke(harness, prompt, messages);
    } finally {
      await this.guard.settle();
    }
  }

  private async invoke(
    harness: Harness,
    prompt: string,
    messages: readonly OperatorMessage[],
  ): Promise<SessionRunResult> {
    if (this.requireEvidence().unusableSamples >= MAX_UNUSABLE_USAGE_SAMPLES) {
      throw new SeptError("Provider usage is incompatible with safe autonomous rollover");
    }
    if (this.requireEvidence().rotationRequired) {
      const answer = await this.recoverRotation();
      const admission = readInvocationAdmission(this.store);
      return this.result(answer, admission?.requestId, []);
    }
    const submitted = await this.submissions.run(harness, prompt, messages);
    let answer = submitted.answer;
    if (this.requireEvidence().rotationRequired) {
      answer = await this.submissions.wait(await this.queueSteer());
    }
    return this.result(answer, submitted.requestId, submitted.deliveredMessageIds);
  }

  private async recoverRotation(): Promise<EntryId> {
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
    return this.submissions.wait(submission);
  }

  private async result(
    answer: EntryId,
    requestId: string | undefined,
    deliveredMessageIds: readonly string[],
  ): Promise<SessionRunResult> {
    const evidence = this.requireEvidence();
    const text = await this.submissions.text(answer);
    const validatedResponse =
      this.validated?.text === text
        ? this.validated.response
        : this.validate?.(text, evidence.rotationRequired ? "handover" : "control");
    return {
      text,
      ...(this.preRotationText === undefined ? {} : { preRotationText: this.preRotationText }),
      steered: evidence.rotationRequired,
      contextTokens: evidence.lastTokens ?? null,
      contextWindow: this.contextWindow,
      ...(requestId === undefined ? {} : { requestId }),
      deliveredMessageIds,
      responseId: `assistant-native-${String(this.requireConversation().id)}-${String(answer)}`,
      preRotationResponseId: `assistant-native-rotation-${String(this.requireConversation().id)}`,
      ...(validatedResponse === undefined ? {} : { validatedResponse }),
      ...(this.preRotationResponse === undefined
        ? {}
        : { preRotationResponse: this.preRotationResponse }),
    };
  }
}
