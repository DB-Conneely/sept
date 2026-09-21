import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionFromServicesOptions,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  calculateContextTokens,
} from "@earendil-works/pi-coding-agent";
import { SeptError, type Manifest, type RunStore } from "../durable/index.js";
import { assertModelMetadata, createPodModelRuntime } from "../model-access/index.js";
import type { Observability } from "../observability/index.js";
import { NOOP_TELEMETRY } from "../observability/index.js";
import { ROTATION_RECOVERY_PROMPT, ROTATION_STEER } from "./prompts.js";
import {
  MAX_UNUSABLE_USAGE_SAMPLES,
  loadRolloverEvidence,
  providerContextTokens,
  recordUnusableSample,
  recordUsableSample,
  saveRolloverEvidence,
} from "./rollover.js";

export interface SessionRunResult {
  text: string;
  preRotationText?: string;
  steered: boolean;
  contextTokens: number | null;
  contextWindow: number;
}

export interface PiSessionHostDependencies {
  modelRuntime?: ModelRuntime;
  customTools?: CreateAgentSessionFromServicesOptions["customTools"];
  tools?: CreateAgentSessionFromServicesOptions["tools"];
}

export interface SessionHost {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  run(prompt: string): Promise<SessionRunResult>;
  newSession(): Promise<{
    predecessorId: string;
    predecessorFile?: string;
    successorId: string;
    successorFile?: string;
  }>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export class PiSessionHost implements SessionHost {
  private unsubscribe?: () => void;
  private constructor(
    private readonly runtime: AgentSessionRuntime,
    private readonly store: RunStore,
    private readonly telemetry: Observability,
  ) {
    this.bind(runtime.session);
  }

  static async create(
    manifest: Manifest,
    store: RunStore,
    agentDir: string,
    existingSessionFile?: string,
    telemetry: Observability = NOOP_TELEMETRY,
    dependencies: PiSessionHostDependencies = {},
  ): Promise<PiSessionHost> {
    const modelRuntime = dependencies.modelRuntime ?? (await createPodModelRuntime(agentDir));
    const model = modelRuntime.getModel(manifest.provider, manifest.model);
    if (!model) throw new SeptError(`Pi model not found: ${manifest.provider}/${manifest.model}`);
    assertModelMetadata(model);
    let auth;
    try {
      auth = await modelRuntime.getAuth(manifest.provider, { signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new SeptError(
        `Pi provider ${manifest.provider} authentication could not be resolved. Run sept auth status, then log in again if required.`,
      );
    }
    if (!auth)
      throw new SeptError(
        `Pi provider ${manifest.provider} is not authenticated. Run sept auth login --provider ${manifest.provider}.`,
      );
    const sessionDir = join(store.runDir, "pi-sessions");
    mkdirSync(sessionDir, { recursive: true });
    const factory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }: {
      cwd: string;
      agentDir: string;
      sessionManager: SessionManager;
      sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"];
    }) => {
      const settingsManager = SettingsManager.inMemory(
        {
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
        },
        { projectTrusted: false },
      );
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        modelRuntime,
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel: manifest.thinking,
        customTools: dependencies.customTools,
        tools: dependencies.tools,
      });
      result.session.setAutoCompactionEnabled(false);
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const manager = existingSessionFile
      ? SessionManager.open(existingSessionFile, sessionDir, manifest.workspace)
      : SessionManager.create(manifest.workspace, sessionDir);
    const runtime = await createAgentSessionRuntime(factory, {
      cwd: manifest.workspace,
      agentDir,
      sessionManager: manager,
    });
    runtime.setRebindSession(async (session) => {
      session.setAutoCompactionEnabled(false);
    });
    if (runtime.session.sessionFile && !existsSync(runtime.session.sessionFile)) {
      runtime.session.sessionManager.appendCustomEntry("sept_session_started", {
        runId: manifest.runId,
        epoch: store.snapshot().epoch,
      });
    }
    return new PiSessionHost(runtime, store, telemetry);
  }

  get sessionId(): string {
    return this.runtime.session.sessionId;
  }
  get sessionFile(): string | undefined {
    return this.runtime.session.sessionFile;
  }

  private bind(session: AgentSession): void {
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => this.record(event));
  }

  private record(event: AgentSessionEvent): void {
    if (event.type === "message_update") return;
    if (event.type === "compaction_start") {
      this.store.event("pi_compaction_violation", {
        sessionId: this.sessionId,
        reason: event.reason,
      });
      this.telemetry.event("sept.pi.compaction_violation", { "sept.outcome": "failure" });
      this.telemetry.log(
        "pi.compaction_violation",
        { "sept.run.id": this.store.runId, "sept.outcome": "failure" },
        "error",
      );
      void this.runtime.session.abortCompaction();
    }
    const fields: Record<string, unknown> = { type: event.type, sessionId: this.sessionId };
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      fields.toolCallId = event.toolCallId;
      fields.toolName = event.toolName;
      if (event.type === "tool_execution_end") fields.isError = event.isError;
    }
    this.store.log(fields);
  }

  async run(prompt: string): Promise<SessionRunResult> {
    let steerPromise: Promise<void> | undefined;
    let latestTokens: number | null = null;
    const session = this.runtime.session;
    const model = session.model;
    if (!model) throw new SeptError("Pi session has no active model");
    assertModelMetadata(model);
    const latestWindow = model.contextWindow;
    let evidence = loadRolloverEvidence(
      this.store,
      model.provider,
      model.id,
      session.sessionId,
      latestWindow,
    );
    if (evidence.unusableSamples >= MAX_UNUSABLE_USAGE_SAMPLES)
      throw new SeptError(
        `Provider usage remained unusable for ${MAX_UNUSABLE_USAGE_SAMPLES} consecutive finalized assistant responses; this provider is incompatible with safe autonomous rollover`,
      );
    let steered = evidence.rotationRequired;
    const recoveredRotation = steered;
    const existingMessages = [...session.messages];
    const rotationMarker = existingMessages.findLastIndex(
      (message) => message.role === "user" && messageText(message) === ROTATION_STEER,
    );
    const recoveredPreRotationText =
      recoveredRotation && rotationMarker >= 0
        ? messageText(
            existingMessages
              .slice(0, rotationMarker)
              .findLast((message) => message.role === "assistant"),
          ) || undefined
        : undefined;
    if (recoveredRotation && rotationMarker >= 0) {
      const recoveredHandover = existingMessages.slice(rotationMarker + 1).findLast((message) => {
        if (message.role !== "assistant" || messageText(message).length === 0) return false;
        const stopReason = (message as { stopReason?: unknown }).stopReason;
        return stopReason !== "aborted" && stopReason !== "error";
      });
      if (recoveredHandover) {
        return {
          text: messageText(recoveredHandover),
          preRotationText: recoveredPreRotationText,
          steered: true,
          contextTokens: evidence.lastTokens ?? null,
          contextWindow: latestWindow,
        };
      }
    }
    const rotationSteerRecorded = recoveredRotation && rotationMarker >= 0;
    let preRotationText = recoveredPreRotationText;
    let violation: Error | undefined;
    let usageIncompatible = false;
    const queueSteer = (fields: Record<string, unknown>): void => {
      if (steerPromise) return;
      steered = true;
      this.store.event("rotation_steer_queued", {
        sessionId: session.sessionId,
        provenance: "provider_reported",
        ...fields,
      });
      this.telemetry.event("sept.rotation.steer_queued", {
        "sept.context.tokens": latestTokens ?? undefined,
        "sept.context.window": latestWindow,
        "sept.context.pressure": latestTokens === null ? undefined : latestTokens / latestWindow,
        "sept.rotation": true,
      });
      this.telemetry.log("pi.rotation.steer_queued", {
        "sept.run.id": this.store.runId,
        "sept.context.pressure": latestTokens === null ? undefined : latestTokens / latestWindow,
        "sept.rotation": true,
      });
      steerPromise = session.steer(ROTATION_STEER);
      void steerPromise.catch((error) => {
        violation = error instanceof Error ? error : new Error(String(error));
      });
    };
    const unusable = (reason: string): void => {
      evidence = recordUnusableSample(evidence);
      saveRolloverEvidence(this.store, evidence);
      latestTokens = null;
      this.store.event("context_sample_deferred", {
        sessionId: session.sessionId,
        provenance: "provider_reported",
        reason,
        consecutive: evidence.unusableSamples,
      });
      this.telemetry.event("sept.context.deferred", { "sept.outcome": "deferred" });
      usageIncompatible = evidence.unusableSamples >= MAX_UNUSABLE_USAGE_SAMPLES;
    };
    const off = session.subscribe((event) => {
      if (event.type === "compaction_start")
        violation = new SeptError(
          "Pi attempted same-session compaction while SEPT cycling was active",
        );
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
      if (steered) {
        if (recoveredRotation && !rotationSteerRecorded && preRotationText === undefined)
          preRotationText = messageText(event.message) || undefined;
        return;
      }
      const reported = providerContextTokens(event.message.usage, calculateContextTokens);
      if (reported === undefined || reported > latestWindow)
        return unusable(
          reported === undefined ? "usage_unavailable" : "usage_exceeds_context_window",
        );
      if (evidence.lastTokens !== undefined && reported < evidence.lastTokens)
        return unusable("usage_regressed");
      const recorded = recordUsableSample(evidence, reported);
      evidence = recorded.evidence;
      usageIncompatible = false;
      saveRolloverEvidence(this.store, evidence);
      latestTokens = reported;
      const percent = (reported / latestWindow) * 100;
      this.store.event("context_sample", {
        sessionId: session.sessionId,
        provenance: "provider_reported",
        tokens: reported,
        contextWindow: latestWindow,
        percent,
        rotateAtTokens: recorded.decision.rotateAtTokens,
        headroomTokens: recorded.decision.headroomTokens,
        handoverReserveTokens: recorded.decision.handoverReserveTokens,
        ordinaryTurnFloorTokens: recorded.decision.ordinaryTurnFloorTokens,
        nextTurnReserveTokens: recorded.decision.nextTurnReserveTokens,
        confidenceMarginTokens: recorded.decision.confidenceMarginTokens,
        recentGrowthTokens: recorded.decision.recentGrowthTokens,
        confidence: recorded.decision.confidence,
        reason: recorded.decision.reason,
      });
      this.telemetry.event("sept.context.sampled", {
        "sept.context.tokens": reported,
        "sept.context.window": latestWindow,
        "sept.context.pressure": percent / 100,
      });
      if (recorded.decision.rotate) {
        preRotationText = messageText(event.message) || undefined;
        queueSteer({
          tokens: reported,
          contextWindow: latestWindow,
          percent,
          rotateAtTokens: recorded.decision.rotateAtTokens,
          headroomTokens: recorded.decision.headroomTokens,
          confidence: recorded.decision.confidence,
          reason: recorded.decision.reason,
        });
      }
    });
    try {
      const promptPromise = session.prompt(
        rotationSteerRecorded ? ROTATION_RECOVERY_PROMPT : prompt,
        { expandPromptTemplates: false, source: "rpc" },
      );
      if (recoveredRotation && !rotationSteerRecorded)
        queueSteer({ reason: "durable_rotation_recovery", contextWindow: latestWindow });
      await promptPromise;
      if (steerPromise) await steerPromise;
      if (violation) throw violation;
      if (usageIncompatible)
        throw new SeptError(
          `Provider usage remained unusable for ${MAX_UNUSABLE_USAGE_SAMPLES} consecutive finalized assistant responses; this provider is incompatible with safe autonomous rollover`,
        );
      const assistant = [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (!assistant) throw new SeptError("Pi session ended without an assistant response");
      return {
        text: messageText(assistant),
        preRotationText,
        steered,
        contextTokens: latestTokens ?? evidence.lastTokens ?? null,
        contextWindow: latestWindow,
      };
    } finally {
      off();
    }
  }

  async newSession(): Promise<{
    predecessorId: string;
    predecessorFile?: string;
    successorId: string;
    successorFile?: string;
  }> {
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.unsubscribe?.();
    const result = await this.runtime.newSession({ parentSession: predecessorFile });
    if (result.cancelled) throw new SeptError("Pi cancelled required fresh-session replacement");
    this.runtime.session.setAutoCompactionEnabled(false);
    this.runtime.session.sessionManager.appendCustomEntry("sept_session_started", {
      runId: this.store.runId,
      predecessorSessionId: predecessorId,
    });
    this.bind(this.runtime.session);
    if (this.sessionId === predecessorId)
      throw new SeptError("Pi newSession() did not replace the session ID");
    return {
      predecessorId,
      predecessorFile,
      successorId: this.sessionId,
      successorFile: this.sessionFile,
    };
  }

  async abort(): Promise<void> {
    await this.runtime.session.abort();
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    await this.runtime.dispose();
  }
}

export function findSuccessorSession(
  sessionDir: string,
  predecessorFile: string,
): string | undefined {
  if (!existsSync(sessionDir)) return undefined;
  const matches: string[] = [];
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(sessionDir, name);
    try {
      const header = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]) as {
        type?: string;
        parentSession?: string;
      };
      if (header.type === "session" && header.parentSession === predecessorFile) matches.push(path);
    } catch {}
  }
  return matches.sort().at(-1);
}
