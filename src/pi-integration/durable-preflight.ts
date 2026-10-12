/** Read-only format fencing precedes leases, reconciliation, wake, and external mutation authority. */

import {
  closeSync,
  existsSync,
  openSync,
  opendirSync,
  readSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { listRuns, SeptError, type RunStore, type RunSnapshot } from "../durable/index.js";
import { readInvocationAdmission, type DurableAdmission } from "./durable-admission.js";
import { readDurableLocator } from "./durable-session-files.js";
import type { DurableSessionLocator } from "./durable-session-files.js";
import { assertDurableDatabase } from "./durable-database-preflight.js";
import { readDurableInitialization } from "./durable-initialization.js";
import { NOOP_TELEMETRY, type Observability } from "../observability/index.js";

interface SessionFormats {
  native: boolean;
  legacy: boolean;
  locators: DurableSessionLocator[];
}

function engineRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SeptError("Pi Durable engine evidence is malformed");
  }
  // CAST: JSON objects have string keys; this boundary rejected null and arrays above.
  return value as Record<string, unknown>;
}

function validateEngine(path: string): void {
  if (!statSync(path).isFile() || statSync(path).size > 1024) {
    throw new SeptError("Pi Durable engine evidence is invalid or oversized");
  }
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  const engine = engineRecord(input);
  if (engine.engine !== "pi-durable") {
    throw new SeptError("Pi Durable engine evidence is incompatible");
  }
  if (engine.version !== "1.1.0") {
    throw new SeptError("Pi Durable engine evidence is incompatible");
  }
  if (engine.synchronous !== "FULL" || Object.keys(engine).length !== 3) {
    throw new SeptError("Pi Durable engine evidence is incompatible");
  }
}

function validateDatabase(path: string): void {
  const header = Buffer.alloc(16);
  const descriptor = openSync(path, "r");
  try {
    if (
      readSync(descriptor, header, 0, header.length, 0) !== 16 ||
      header.toString("utf8") !== "SQLite format 3\u0000"
    ) {
      throw new SeptError("Pi Durable database format is incompatible");
    }
  } finally {
    closeSync(descriptor);
  }
}

function sessionFormats(store: RunStore): SessionFormats {
  const directory = join(store.runDir, "pi-sessions");
  const snapshot = store.snapshot();
  let native = false;
  let legacy = false;
  const locators: DurableSessionLocator[] = [];
  for (const [path, sessionId] of [
    [snapshot.activeSessionFile, snapshot.activeSessionId],
    [snapshot.predecessorSessionFile, snapshot.predecessorSessionId],
  ]) {
    if (path === undefined) {
      continue;
    }
    if (path.endsWith(".jsonl")) {
      legacy = true;
    } else {
      const locator = readDurableLocator(path);
      if (sessionId !== undefined && String(locator.conversationId) !== sessionId) {
        throw new SeptError("Pi Durable snapshot identity does not match its native locator");
      }
      locators.push(locator);
      native = true;
    }
  }
  return directoryFormats(directory, { native, legacy, locators });
}

function directoryFormats(directory: string, formats: SessionFormats): SessionFormats {
  let { native, legacy } = formats;
  const { locators } = formats;
  if (!existsSync(directory)) {
    return { native, legacy, locators };
  }
  const handle = opendirSync(directory);
  let count = 0;
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      count += 1;
      if (count > 1001) {
        throw new SeptError("Pi Durable session discovery exceeds the epoch bound");
      }
      if (entry.name.endsWith(".durable.json")) {
        locators.push(readDurableLocator(join(directory, entry.name)));
        native = true;
      }
      legacy ||= entry.name.endsWith(".jsonl");
    }
  } finally {
    handle.closeSync();
  }
  return { native, legacy, locators };
}

function classifyRun(store: RunStore, telemetry: Observability): boolean {
  const engine = join(store.runDir, "pi-durable-engine.json");
  const database = join(store.runDir, "pi-durable.sqlite");
  const sessions = sessionFormats(store);
  const admission = readInvocationAdmission(store);
  assertAdmissionBinding(store.snapshot(), admission);
  const initializing = readDurableInitialization(store, telemetry);
  const nativeEvidence =
    existsSync(engine) || sessions.native || admission !== undefined || initializing !== undefined;
  if (existsSync(engine)) {
    validateEngine(engine);
  }
  validateNativeArtifacts(database, engine, sessions, admission, initializing, telemetry);
  if (sessions.legacy && nativeEvidence) {
    throw new SeptError("Pi Durable and legacy session evidence are mixed");
  }
  if (!sessions.legacy) {
    assertPublishedIdentity(store, nativeEvidence);
  }
  return sessions.legacy;
}

function validateNativeArtifacts(
  database: string,
  engine: string,
  sessions: SessionFormats,
  admission: DurableAdmission | undefined,
  initializing: ReturnType<typeof readDurableInitialization>,
  telemetry: Observability,
): void {
  if (existsSync(database)) {
    if (!existsSync(engine) && initializing === undefined) {
      throw new SeptError(
        "Pi Durable engine evidence is missing; refusing partial native adoption",
      );
    }
    if (initializing === undefined) {
      validateDatabase(database);
    }
    assertDurableDatabase(
      database,
      sessions.locators,
      telemetry,
      initializing === undefined ? undefined : { initializing: true },
    );
  } else if (existsSync(engine) || sessions.native || admission !== undefined) {
    throw new SeptError("Pi Durable database evidence is missing");
  }
}

function assertPublishedIdentity(store: RunStore, nativeEvidence: boolean): void {
  const snapshot = store.snapshot();
  const published =
    snapshot.invocations > 0 ||
    snapshot.activeSessionId !== undefined ||
    snapshot.predecessorSessionId !== undefined;
  if (published && !nativeEvidence) {
    throw new SeptError(
      "Published Pi history is missing native engine evidence; refusing a fresh conversation",
    );
  }
  assertLocatorBindings(snapshot);
}

function assertAdmissionBinding(
  snapshot: RunSnapshot,
  admission: DurableAdmission | undefined,
): void {
  if (admission === undefined) {
    return;
  }
  if (snapshot.invocations === 0) {
    throw new SeptError("Pi Durable admission is missing its published runtime invocation");
  }
  if (admission.checkpointed || snapshot.activeSessionId === undefined) {
    return;
  }
  const current = String(admission.conversationId) === snapshot.activeSessionId;
  if (
    current &&
    snapshot.phase !== "ready" &&
    Number(admission.requestId.slice("sept-invocation-".length)) !== snapshot.invocations
  ) {
    throw new SeptError(
      "Pi Durable admission invocation identity does not match published history",
    );
  }
  if (!current && String(admission.conversationId) !== snapshot.predecessorSessionId) {
    throw new SeptError(
      "Pi Durable admission conversation identity does not match published history",
    );
  }
}

function assertLocatorBindings(snapshot: RunSnapshot): void {
  if (snapshot.activeSessionId !== undefined && snapshot.activeSessionFile === undefined) {
    throw new SeptError("Published Pi session is missing its native locator");
  }
  if (snapshot.invocations > 0 && snapshot.activeSessionFile === undefined) {
    throw new SeptError("Published Pi invocation is missing its native locator");
  }
  if (
    snapshot.predecessorSessionId !== undefined &&
    snapshot.predecessorSessionFile === undefined
  ) {
    throw new SeptError("Published Pi predecessor is missing its native locator");
  }
}

/** Validate all present native evidence; return legacy classification without repairing history. */
export function isLegacyRun(store: RunStore, telemetry: Observability = NOOP_TELEMETRY): boolean {
  try {
    return classifyRun(store, telemetry);
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Pi Durable engine evidence is unreadable or incompatible", {
      cause: error,
    });
  }
}

/** Reject any native mutation/adoption of legacy history before acquiring authority or writing. */
export function assertNativeRun(store: RunStore, telemetry: Observability = NOOP_TELEMETRY): void {
  if (isLegacyRun(store, telemetry)) {
    throw new SeptError(
      "Legacy Pi history requires the preserved old build and state root; Pi Durable cannot resume or mutate it",
    );
  }
}

/** Preflight the complete root before recovery repairs; terminal legacy runs remain read-only. */
export function assertCompatibleStateRoot(
  root: string,
  telemetry: Observability = NOOP_TELEMETRY,
): void {
  for (const store of listRuns(root)) {
    const legacy = isLegacyRun(store, telemetry);
    const status = store.snapshot().status;
    if (legacy && (status === "active" || status === "waiting" || status === "cancelling")) {
      assertNativeRun(store);
    }
  }
}
