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
import type { Observability } from "../observability/index.js";
import { NOOP_TELEMETRY } from "../observability/index.js";
import { ROTATION_STEER } from "./prompts.js";

export interface SessionRunResult {
  text: string;
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
  run(prompt: string, thresholdPercent: number, handoverReserveTokens: number): Promise<SessionRunResult>;
  newSession(): Promise<{ predecessorId: string; predecessorFile?: string; successorId: string; successorFile?: string }>;
  close(): Promise<void>;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text).join("");
}

export class PiSessionHost implements SessionHost {
  private unsubscribe?: () => void;
  private constructor(private readonly runtime: AgentSessionRuntime, private readonly store: RunStore, private readonly telemetry: Observability) {
    this.bind(runtime.session);
  }

  static async create(manifest: Manifest, store: RunStore, agentDir: string, existingSessionFile?: string, telemetry: Observability = NOOP_TELEMETRY, dependencies: PiSessionHostDependencies = {}): Promise<PiSessionHost> {
    const modelRuntime = dependencies.modelRuntime ?? await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json") });
    const model = modelRuntime.getModel(manifest.provider, manifest.model);
    if (!model) throw new SeptError(`Pi model not found: ${manifest.provider}/${manifest.model}`);
    if (!modelRuntime.hasConfiguredAuth(manifest.provider)) {
      throw new SeptError(`Pi provider ${manifest.provider} is not authenticated. Run pi, then /login and select ChatGPT Plus/Pro (Codex), using PI_CODING_AGENT_DIR=${agentDir}.`);
    }
    const sessionDir = join(store.runDir, "pi-sessions");
    mkdirSync(sessionDir, { recursive: true });
    const factory = async ({ cwd, sessionManager, sessionStartEvent }: { cwd: string; agentDir: string; sessionManager: SessionManager; sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"] }) => {
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
      }, { projectTrusted: false });
      const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: manifest.thinking, customTools: dependencies.customTools, tools: dependencies.tools });
      result.session.setAutoCompactionEnabled(false);
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const manager = existingSessionFile ? SessionManager.open(existingSessionFile, sessionDir, manifest.workspace) : SessionManager.create(manifest.workspace, sessionDir);
    const runtime = await createAgentSessionRuntime(factory, { cwd: manifest.workspace, agentDir, sessionManager: manager });
    runtime.setRebindSession(async (session) => { session.setAutoCompactionEnabled(false); });
    if (runtime.session.sessionFile && !existsSync(runtime.session.sessionFile)) {
      runtime.session.sessionManager.appendCustomEntry("sept_session_started", { runId: manifest.runId, epoch: store.snapshot().epoch });
    }
    return new PiSessionHost(runtime, store, telemetry);
  }

  get sessionId(): string { return this.runtime.session.sessionId; }
  get sessionFile(): string | undefined { return this.runtime.session.sessionFile; }

  private bind(session: AgentSession): void {
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => this.record(event));
  }

  private record(event: AgentSessionEvent): void {
    if (event.type === "message_update") return;
    if (event.type === "compaction_start") {
      this.store.event("pi_compaction_violation", { sessionId: this.sessionId, reason: event.reason });
      this.telemetry.event("sept.pi.compaction_violation", { "sept.outcome": "failure" });
      this.telemetry.log("pi.compaction_violation", { "sept.run.id": this.store.runId, "sept.outcome": "failure" }, "error");
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

  async run(prompt: string, thresholdPercent: number, handoverReserveTokens: number): Promise<SessionRunResult> {
    let steered = false;
    let steerPromise: Promise<void> | undefined;
    let latestTokens: number | null = null;
    let latestWindow = this.runtime.session.model?.contextWindow ?? 0;
    let violation: Error | undefined;
    const session = this.runtime.session;
    const off = session.subscribe((event) => {
      if (event.type === "compaction_start") violation = new SeptError("Pi attempted same-session compaction while SEPT cycling was active");
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      latestWindow = session.model?.contextWindow ?? 0;
      const reported = calculateContextTokens(event.message.usage);
      if (reported <= 0 || latestWindow <= 0 || event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        latestTokens = null;
        this.store.event("context_sample_deferred", { sessionId: session.sessionId, provenance: "provider_reported", reason: reported <= 0 ? "usage_unavailable" : latestWindow <= 0 ? "context_window_unavailable" : "unsuccessful_response" });
        this.telemetry.event("sept.context.deferred", { "sept.outcome": "deferred" });
        return;
      }
      latestTokens = reported;
      const percent = reported / latestWindow * 100;
      const reserve = Math.min(handoverReserveTokens, Math.max(1, Math.floor(latestWindow / 4)));
      const rotateAtTokens = Math.min(Math.floor(latestWindow * thresholdPercent / 100), latestWindow - reserve);
      this.store.event("context_sample", { sessionId: session.sessionId, provenance: "provider_reported", tokens: reported, contextWindow: latestWindow, percent, rotateAtTokens, handoverReserveTokens: reserve });
      this.telemetry.event("sept.context.sampled", { "sept.context.tokens": reported, "sept.context.window": latestWindow, "sept.context.pressure": percent / 100 });
      if (!steered && reported >= rotateAtTokens) {
        steered = true;
        this.store.event("rotation_steer_queued", { sessionId: session.sessionId, provenance: "provider_reported", tokens: reported, contextWindow: latestWindow, percent, rotateAtTokens });
        this.telemetry.event("sept.rotation.steer_queued", { "sept.context.tokens": reported, "sept.context.window": latestWindow, "sept.context.pressure": percent / 100, "sept.rotation": true });
        this.telemetry.log("pi.rotation.steer_queued", { "sept.run.id": this.store.runId, "sept.context.pressure": percent / 100, "sept.rotation": true });
        steerPromise = session.steer(ROTATION_STEER);
        void steerPromise.catch((error) => { violation = error instanceof Error ? error : new Error(String(error)); });
      }
    });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
      if (steerPromise) await steerPromise;
      if (violation) throw violation;
      const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
      if (!assistant) throw new SeptError("Pi session ended without an assistant response");
      return { text: messageText(assistant), steered, contextTokens: latestTokens, contextWindow: latestWindow };
    } finally { off(); }
  }

  async newSession(): Promise<{ predecessorId: string; predecessorFile?: string; successorId: string; successorFile?: string }> {
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.unsubscribe?.();
    const result = await this.runtime.newSession({ parentSession: predecessorFile });
    if (result.cancelled) throw new SeptError("Pi cancelled required fresh-session replacement");
    this.runtime.session.setAutoCompactionEnabled(false);
    this.runtime.session.sessionManager.appendCustomEntry("sept_session_started", { runId: this.store.runId, predecessorSessionId: predecessorId });
    this.bind(this.runtime.session);
    if (this.sessionId === predecessorId) throw new SeptError("Pi newSession() did not replace the session ID");
    return { predecessorId, predecessorFile, successorId: this.sessionId, successorFile: this.sessionFile };
  }

  async close(): Promise<void> { this.unsubscribe?.(); await this.runtime.dispose(); }
}

export function findSuccessorSession(sessionDir: string, predecessorFile: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined;
  const matches: string[] = [];
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(sessionDir, name);
    try {
      const header = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]) as { type?: string; parentSession?: string };
      if (header.type === "session" && header.parentSession === predecessorFile) matches.push(path);
    } catch {}
  }
  return matches.sort().at(-1);
}
