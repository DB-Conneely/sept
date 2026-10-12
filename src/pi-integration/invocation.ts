/**
 * Coordinates one prompt against an already-owned native Pi session. It alone observes finalized
 * assistant usage, persists rollover evidence before steering, and recovers interrupted steering;
 * the host retains session lifetime ownership and runtime controls fresh-session replacement.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SeptError, type RunStore } from "../durable/index.js";
import { assertModelMetadata } from "../model-access/index.js";
import type { Observability } from "../observability/index.js";
import { ROTATION_RECOVERY_PROMPT, ROTATION_STEER } from "./prompts.js";
import type { SessionRunResult } from "./contracts.js";
import {
  MAX_UNUSABLE_USAGE_SAMPLES,
  loadRolloverEvidence,
  recordUnusableSample,
  recordUsableSample,
  saveRolloverEvidence,
  type RolloverEvidence,
} from "./rollover-evidence.js";
import { providerContextTokens, type RolloverDecision } from "./rollover.js";
import {
  isFinalAssistantMessage,
  rotationRecovery,
  sessionMessageText,
  type RotationRecovery,
} from "./session-recovery.js";

type MessageEndEvent = Extract<AgentSessionEvent, { type: "message_end" }>;

function recoveredResult(
  session: AgentSession,
  recovery: RotationRecovery,
  evidence: RolloverEvidence,
  contextWindow: number,
): SessionRunResult | undefined {
  if (!recovery.recoveredRotation || recovery.rotationMarker < 0) {
    return undefined;
  }
  const handover = [...session.messages]
    .slice(recovery.rotationMarker + 1)
    .findLast(isFinalAssistantMessage);
  if (handover === undefined) {
    return undefined;
  }
  return {
    text: sessionMessageText(handover),
    ...(recovery.preRotationText === undefined
      ? {}
      : { preRotationText: recovery.preRotationText }),
    steered: true,
    contextTokens: evidence.lastTokens ?? null,
    contextWindow,
  };
}

function incompatibleUsageError(): SeptError {
  return new SeptError(
    `Provider usage remained unusable for ${String(MAX_UNUSABLE_USAGE_SAMPLES)} consecutive finalized assistant responses; this provider is incompatible with safe autonomous rollover`,
  );
}

class PiInvocation {
  private evidence: RolloverEvidence;
  private readonly recovery: RotationRecovery;
  private latestTokens: number | null = null;
  private steered: boolean;
  private steerPromise: Promise<void> | undefined;
  private violation: Error | undefined;
  private usageIncompatible = false;

  constructor(
    private readonly session: AgentSession,
    private readonly store: RunStore,
    private readonly telemetry: Observability,
    private readonly contextWindow: number,
    evidence: RolloverEvidence,
  ) {
    this.evidence = evidence;
    this.steered = evidence.rotationRequired;
    this.recovery = rotationRecovery(session, evidence.rotationRequired);
  }

  completedRecovery(): SessionRunResult | undefined {
    return recoveredResult(this.session, this.recovery, this.evidence, this.contextWindow);
  }

  private recordDeferred(reason: string): void {
    this.evidence = recordUnusableSample(this.evidence);
    saveRolloverEvidence(this.store, this.evidence);
    this.latestTokens = null;
    this.store.event("context_sample_deferred", {
      sessionId: this.session.sessionId,
      provenance: "provider_reported",
      reason,
      consecutive: this.evidence.unusableSamples,
    });
    this.telemetry.event("sept.context.deferred", { "sept.outcome": "deferred" });
    this.usageIncompatible = this.evidence.unusableSamples >= MAX_UNUSABLE_USAGE_SAMPLES;
  }

  private recordUsable(reported: number): RolloverDecision {
    const recorded = recordUsableSample(this.evidence, reported);
    this.evidence = recorded.evidence;
    this.usageIncompatible = false;
    saveRolloverEvidence(this.store, this.evidence);
    this.latestTokens = reported;
    return recorded.decision;
  }

  private emitSample(reported: number, decision: RolloverDecision): number {
    const percent = (reported / this.contextWindow) * 100;
    this.store.event("context_sample", {
      sessionId: this.session.sessionId,
      provenance: "provider_reported",
      tokens: reported,
      contextWindow: this.contextWindow,
      percent,
      rotateAtTokens: decision.rotateAtTokens,
      headroomTokens: decision.headroomTokens,
      handoverReserveTokens: decision.handoverReserveTokens,
      ordinaryTurnFloorTokens: decision.ordinaryTurnFloorTokens,
      nextTurnReserveTokens: decision.nextTurnReserveTokens,
      confidenceMarginTokens: decision.confidenceMarginTokens,
      recentGrowthTokens: decision.recentGrowthTokens,
      confidence: decision.confidence,
      reason: decision.reason,
    });
    this.telemetry.event("sept.context.sampled", {
      "sept.context.tokens": reported,
      "sept.context.window": this.contextWindow,
      "sept.context.pressure": percent / 100,
    });
    return percent;
  }

  private queueSteer(fields: Record<string, unknown>): void {
    if (this.steerPromise !== undefined) {
      return;
    }
    this.steered = true;
    this.store.event("rotation_steer_queued", {
      sessionId: this.session.sessionId,
      provenance: "provider_reported",
      ...fields,
    });
    this.telemetry.event("sept.rotation.steer_queued", {
      "sept.context.tokens": this.latestTokens ?? undefined,
      "sept.context.window": this.contextWindow,
      "sept.context.pressure":
        this.latestTokens === null ? undefined : this.latestTokens / this.contextWindow,
      "sept.rotation": true,
    });
    this.telemetry.log("pi.rotation.steer_queued", {
      "sept.run.id": this.store.runId,
      "sept.context.pressure":
        this.latestTokens === null ? undefined : this.latestTokens / this.contextWindow,
      "sept.rotation": true,
    });
    this.steerPromise = this.session.steer(ROTATION_STEER);
    this.steerPromise.catch((error: unknown) => {
      this.violation =
        error instanceof Error ? error : new SeptError("Native Pi rotation steer failed");
    });
  }

  private handleFinalAssistant(event: MessageEndEvent): void {
    if (event.message.role !== "assistant") {
      return;
    }
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      return;
    }
    if (this.steered) {
      const needsPreRotation =
        this.recovery.recoveredRotation &&
        !this.recovery.rotationSteerRecorded &&
        this.recovery.preRotationText === undefined;
      if (needsPreRotation) {
        this.recovery.preRotationText = sessionMessageText(event.message) || undefined;
      }
      return;
    }
    this.handleUsage(event);
  }

  private handleUsage(event: MessageEndEvent): void {
    const reported = providerContextTokens(
      "usage" in event.message ? event.message.usage : undefined,
    );
    if (reported === undefined || reported > this.contextWindow) {
      this.recordDeferred(
        reported === undefined ? "usage_unavailable" : "usage_exceeds_context_window",
      );
      return;
    }
    if (this.evidence.lastTokens !== undefined && reported < this.evidence.lastTokens) {
      this.recordDeferred("usage_regressed");
      return;
    }
    const decision = this.recordUsable(reported);
    const percent = this.emitSample(reported, decision);
    if (decision.rotate) {
      this.recovery.preRotationText = sessionMessageText(event.message) || undefined;
      this.queueSteer({
        tokens: reported,
        contextWindow: this.contextWindow,
        percent,
        rotateAtTokens: decision.rotateAtTokens,
        headroomTokens: decision.headroomTokens,
        confidence: decision.confidence,
        reason: decision.reason,
      });
    }
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (event.type === "compaction_start") {
      this.violation = new SeptError(
        "Pi attempted same-session compaction while SEPT cycling was active",
      );
      return;
    }
    if (event.type === "message_end") {
      this.handleFinalAssistant(event);
    }
  }

  private async prompt(prompt: string): Promise<void> {
    const effectivePrompt = this.recovery.rotationSteerRecorded ? ROTATION_RECOVERY_PROMPT : prompt;
    const promptPromise = this.session.prompt(effectivePrompt, {
      expandPromptTemplates: false,
      source: "rpc",
    });
    if (this.recovery.recoveredRotation && !this.recovery.rotationSteerRecorded) {
      this.queueSteer({
        reason: "durable_rotation_recovery",
        contextWindow: this.contextWindow,
      });
    }
    await promptPromise;
    await this.steerPromise;
  }

  private result(): SessionRunResult {
    if (this.violation !== undefined) {
      throw this.violation;
    }
    if (this.usageIncompatible) {
      throw incompatibleUsageError();
    }
    const assistant = [...this.session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (assistant === undefined) {
      throw new SeptError("Pi session ended without an assistant response");
    }
    const contextTokens = this.latestTokens ?? this.evidence.lastTokens ?? null;
    return {
      text: sessionMessageText(assistant),
      ...(this.recovery.preRotationText === undefined
        ? {}
        : { preRotationText: this.recovery.preRotationText }),
      steered: this.steered,
      contextTokens,
      contextWindow: this.contextWindow,
    };
  }

  async execute(prompt: string): Promise<SessionRunResult> {
    const recovered = this.completedRecovery();
    if (recovered !== undefined) {
      return recovered;
    }
    const unsubscribe = this.session.subscribe((event) => {
      this.handleEvent(event);
    });
    try {
      await this.prompt(prompt);
      return this.result();
    } finally {
      unsubscribe();
    }
  }
}

/** Execute one Pi prompt with durable, finalized-usage rollover and interruption recovery. */
export async function runPiInvocation(
  session: AgentSession,
  store: RunStore,
  telemetry: Observability,
  prompt: string,
): Promise<SessionRunResult> {
  const model = session.model;
  if (model === undefined) {
    throw new SeptError("Pi session has no active model");
  }
  assertModelMetadata(model);
  const evidence = loadRolloverEvidence(
    store,
    model.provider,
    model.id,
    session.sessionId,
    model.contextWindow,
  );
  if (evidence.unusableSamples >= MAX_UNUSABLE_USAGE_SAMPLES) {
    throw incompatibleUsageError();
  }
  const invocation = new PiInvocation(session, store, telemetry, model.contextWindow, evidence);
  return invocation.execute(prompt);
}
