/**
 * Owns the native Pi session runtime and exposes its narrow lifecycle handle to SEPT runtime. Model
 * access supplies authenticated Pi authority, invocation owns rollover policy, and this host alone
 * binds event logging, disables compaction, replaces sessions, aborts work, and disposes resources.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
} from "@earendil-works/pi-coding-agent";
import { SeptError, type Manifest, type RunStore } from "../durable/index.js";
import { assertModelMetadata, createPodModelRuntime } from "../model-access/index.js";
import type { Observability } from "../observability/index.js";
import { NOOP_TELEMETRY } from "../observability/index.js";
import type { PiSessionHostDependencies, SessionHost, SessionRunResult } from "./contracts.js";
import { runPiInvocation } from "./invocation.js";

async function authenticateProvider(runtime: ModelRuntime, provider: string): Promise<void> {
  let authentication;
  try {
    authentication = await runtime.getAuth(provider, { signal: AbortSignal.timeout(15_000) });
  } catch (error: unknown) {
    throw new SeptError(
      `Pi provider ${provider} authentication could not be resolved. Run sept auth status, then log in again if required.`,
      { cause: error },
    );
  }
  if (authentication === undefined) {
    throw new SeptError(
      `Pi provider ${provider} is not authenticated. Run sept auth login --provider ${provider}.`,
    );
  }
}

function sessionOptions(
  services: Awaited<ReturnType<typeof createAgentSessionServices>>,
  sessionManager: SessionManager,
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
  manifest: Manifest,
  dependencies: PiSessionHostDependencies,
  sessionStartEvent: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"],
): CreateAgentSessionFromServicesOptions {
  return {
    services,
    sessionManager,
    model,
    thinkingLevel: manifest.thinking,
    ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
    ...(dependencies.customTools === undefined ? {} : { customTools: dependencies.customTools }),
    ...(dependencies.tools === undefined ? {} : { tools: dependencies.tools }),
  };
}

function runtimeFactory(
  manifest: Manifest,
  modelRuntime: ModelRuntime,
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
  dependencies: PiSessionHostDependencies,
) {
  return async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }: Parameters<Parameters<typeof createAgentSessionRuntime>[0]>[0]) => {
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
    const result = await createAgentSessionFromServices(
      sessionOptions(services, sessionManager, model, manifest, dependencies, sessionStartEvent),
    );
    result.session.setAutoCompactionEnabled(false);
    return { ...result, services, diagnostics: services.diagnostics };
  };
}

async function createRuntime(
  manifest: Manifest,
  store: RunStore,
  agentDir: string,
  existingSessionFile: string | undefined,
  dependencies: PiSessionHostDependencies,
): Promise<AgentSessionRuntime> {
  const modelRuntime = dependencies.modelRuntime ?? (await createPodModelRuntime(agentDir));
  const model = modelRuntime.getModel(manifest.provider, manifest.model);
  if (model === undefined) {
    throw new SeptError(`Pi model not found: ${manifest.provider}/${manifest.model}`);
  }
  assertModelMetadata(model);
  await authenticateProvider(modelRuntime, manifest.provider);
  const sessionDir = join(store.runDir, "pi-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const manager =
    existingSessionFile === undefined
      ? SessionManager.create(manifest.workspace, sessionDir)
      : SessionManager.open(existingSessionFile, sessionDir, manifest.workspace);
  const runtime = await createAgentSessionRuntime(
    runtimeFactory(manifest, modelRuntime, model, dependencies),
    { cwd: manifest.workspace, agentDir, sessionManager: manager },
  );
  runtime.setRebindSession((session) => {
    session.setAutoCompactionEnabled(false);
    return Promise.resolve();
  });
  return runtime;
}

function recordSessionStart(session: AgentSession, store: RunStore): void {
  if (session.sessionFile !== undefined && !existsSync(session.sessionFile)) {
    session.sessionManager.appendCustomEntry("sept_session_started", {
      runId: store.manifest().runId,
      epoch: store.snapshot().epoch,
    });
  }
}

/** Native Pi-backed implementation of one resident SEPT execution slot. */
export class PiSessionHost implements SessionHost {
  private unsubscribe: (() => void) | undefined;

  private constructor(
    private readonly runtime: AgentSessionRuntime,
    private readonly store: RunStore,
    private readonly telemetry: Observability,
  ) {
    this.bind(runtime.session);
  }

  /** Construct an authenticated untrusted-project Pi runtime, optionally resuming a session file. */
  static async create(
    manifest: Manifest,
    store: RunStore,
    agentDir: string,
    existingSessionFile?: string,
    telemetry: Observability = NOOP_TELEMETRY,
    dependencies: PiSessionHostDependencies = {},
  ): Promise<PiSessionHost> {
    const runtime = await createRuntime(
      manifest,
      store,
      agentDir,
      existingSessionFile,
      dependencies,
    );
    recordSessionStart(runtime.session, store);
    return new PiSessionHost(runtime, store, telemetry);
  }

  /** Current native Pi session identity used by durable runtime state. */
  get sessionId(): string {
    return this.runtime.session.sessionId;
  }

  /** Current native Pi JSONL path, when persistence has materialized it. */
  get sessionFile(): string | undefined {
    return this.runtime.session.sessionFile;
  }

  private bind(session: AgentSession): void {
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      this.record(event);
    });
  }

  private recordCompactionViolation(
    event: Extract<AgentSessionEvent, { type: "compaction_start" }>,
  ): void {
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
    // Compaction would invalidate provider usage continuity; abort it while invocation fails closed.
    this.runtime.session.abortCompaction();
  }

  private record(event: AgentSessionEvent): void {
    if (event.type === "message_update") {
      return;
    }
    if (event.type === "compaction_start") {
      this.recordCompactionViolation(event);
    }
    const fields: Record<string, unknown> = { type: event.type, sessionId: this.sessionId };
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      fields.toolCallId = event.toolCallId;
      fields.toolName = event.toolName;
      if (event.type === "tool_execution_end") {
        fields.isError = event.isError;
      }
    }
    this.store.log(fields);
  }

  /** Run one native Pi prompt and return only finalized assistant and rollover evidence. */
  async run(prompt: string): Promise<SessionRunResult> {
    return runPiInvocation(this.runtime.session, this.store, this.telemetry, prompt);
  }

  /** Replace the predecessor through native `newSession`, preserving parentage and event binding. */
  async newSession(): Promise<{
    predecessorId: string;
    predecessorFile?: string;
    successorId: string;
    successorFile?: string;
  }> {
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.unsubscribe?.();
    const result = await this.runtime.newSession(
      predecessorFile === undefined ? undefined : { parentSession: predecessorFile },
    );
    if (result.cancelled) {
      throw new SeptError("Pi cancelled required fresh-session replacement");
    }
    this.runtime.session.setAutoCompactionEnabled(false);
    this.runtime.session.sessionManager.appendCustomEntry("sept_session_started", {
      runId: this.store.runId,
      predecessorSessionId: predecessorId,
    });
    this.bind(this.runtime.session);
    if (this.sessionId === predecessorId) {
      throw new SeptError("Pi newSession() did not replace the session ID");
    }
    return {
      predecessorId,
      ...(predecessorFile === undefined ? {} : { predecessorFile }),
      successorId: this.sessionId,
      ...(this.sessionFile === undefined ? {} : { successorFile: this.sessionFile }),
    };
  }

  /** Abort active model and tool work through Pi's native cancellation path. */
  async abort(): Promise<void> {
    await this.runtime.session.abort();
  }

  /** Detach SEPT event ownership and dispose the current native Pi runtime exactly once. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.runtime.dispose();
  }
}

function isSessionHeader(value: unknown, predecessorFile: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    "type" in value &&
    value.type === "session" &&
    "parentSession" in value &&
    value.parentSession === predecessorFile
  );
}

/** Find the newest persisted native successor whose header names the predecessor session file. */
export function findSuccessorSession(
  sessionDir: string,
  predecessorFile: string,
): string | undefined {
  if (!existsSync(sessionDir)) {
    return undefined;
  }
  const matches: string[] = [];
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const path = join(sessionDir, name);
    try {
      const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
      if (firstLine !== undefined && isSessionHeader(JSON.parse(firstLine), predecessorFile)) {
        matches.push(path);
      }
    } catch {
      // Discovery ignores malformed unrelated candidates; durable active-session state still fails closed.
    }
  }
  return matches.sort().at(-1);
}
