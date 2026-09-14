import { closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DurableHandover, Handover, Manifest, OperatorMessage, RunEvent, RunSnapshot, WorkControl } from "./contracts.js";
import { HANDOVER_FIELDS } from "./contracts.js";

export class SeptError extends Error {}
export class QueueCapacityError extends SeptError {}

export const MAX_PENDING_MESSAGES = 64;
export const MAX_PENDING_MESSAGE_BYTES = 512 * 1024;
const MAX_JSONL_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_CONTROL_BYTES = 512 * 1024;
const MAX_CONTROL_STRING_CHARS = 65_536;
const MAX_CONTROL_ARRAY_ITEMS = 64;
const PROCESS_IDENTITY = Object.freeze({
  pid: process.pid,
  hostname: hostname(),
  processStartedAt: Date.now() - Math.floor(process.uptime() * 1000),
});

export function now(): string {
  return new Date().toISOString();
}

function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureDirectory(path: string): void {
  if (existsSync(path)) return;
  const parent = dirname(path);
  if (parent === path) throw new SeptError(`Cannot create durable directory ${path}`);
  ensureDirectory(parent);
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  syncDir(parent);
}

export function atomicWrite(path: string, value: unknown): void {
  ensureDirectory(dirname(path));
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const body = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeSync(fd, body.endsWith("\n") ? body : `${body}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  syncDir(dirname(path));
}

export function atomicCreate(path: string, value: unknown): boolean {
  const directory = dirname(path);
  ensureDirectory(directory);
  const temp = join(directory, `.${randomUUID()}.tmp`);
  const body = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeSync(fd, body.endsWith("\n") ? body : `${body}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    linkSync(temp, path);
    syncDir(dirname(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

function appendSynced(path: string, value: unknown): void {
  ensureDirectory(dirname(path));
  const created = !existsSync(path);
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > MAX_JSONL_RECORD_BYTES) throw new SeptError(`Durable JSONL record exceeds ${MAX_JSONL_RECORD_BYTES} bytes in ${path}`);
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  if (created) syncDir(dirname(path));
}

function jsonFile<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { throw new SeptError(`Invalid durable JSON ${path}`); }
}

function scanJsonLines<T>(path: string, visit: (value: T, line: number) => boolean | void): void {
  if (!existsSync(path)) return;
  const fd = openSync(path, constants.O_RDONLY);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let buffered = Buffer.alloc(0);
  let line = 0;
  try {
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      buffered = Buffer.concat([buffered, chunk.subarray(0, count)]);
      if (buffered.length > MAX_JSONL_RECORD_BYTES && buffered.indexOf(10) < 0) throw new SeptError(`Durable JSONL record exceeds ${MAX_JSONL_RECORD_BYTES} bytes in ${path}`);
      let newline = buffered.indexOf(10);
      while (newline >= 0) {
        const record = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        line++;
        if (record.length > MAX_JSONL_RECORD_BYTES) throw new SeptError(`Durable JSONL record exceeds ${MAX_JSONL_RECORD_BYTES} bytes in ${path}:${line}`);
        if (record.length) {
          let value: T;
          try { value = JSON.parse(record.toString("utf8")) as T; }
          catch { throw new SeptError(`Invalid durable JSONL ${path}:${line}`); }
          if (visit(value, line) === false) return;
        }
        newline = buffered.indexOf(10);
      }
    }
    if (buffered.length) {
      line++;
      if (buffered.length > MAX_JSONL_RECORD_BYTES) throw new SeptError(`Durable JSONL record exceeds ${MAX_JSONL_RECORD_BYTES} bytes in ${path}:${line}`);
      try { visit(JSON.parse(buffered.toString("utf8")) as T, line); }
      catch (error) {
        if (error instanceof SeptError) throw error;
        throw new SeptError(`Invalid durable JSONL ${path}:${line}`);
      }
    }
  } finally { closeSync(fd); }
}

function jsonLines<T>(path: string): T[] {
  const values: T[] = [];
  scanJsonLines<T>(path, (value) => { values.push(value); });
  return values;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeptError(`Invalid durable ${name}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], name: string): void {
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) throw new SeptError(`Invalid durable ${name} fields`);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new SeptError(`Invalid durable ${name}`);
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, name: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new SeptError(`Invalid durable ${name}`);
  return value;
}

function isoDate(value: unknown, name: string): string {
  const result = boundedString(value, 1, 128, name);
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== result) throw new SeptError(`Invalid durable ${name}`);
  return result;
}

function validateManifest(value: unknown, expectedRunId?: string): Manifest {
  const input = object(value, "manifest");
  const keys = ["createdAt", "formatVersion", "handoverReserveTokens", "maxEpochs", "maxInvocations", "model", "piVersion", "provider", "role", "runId", "task", "thinking", "thresholdPercent", "timeoutSeconds", "workspace"];
  exactKeys(input, keys, [], "manifest");
  if (input.formatVersion !== 2) throw new SeptError("Invalid durable manifest formatVersion");
  const runId = boundedString(input.runId, 1, 128, "manifest runId");
  if (!/^[A-Za-z0-9_-]+$/.test(runId) || (expectedRunId !== undefined && runId !== expectedRunId)) throw new SeptError("Invalid durable manifest runId");
  const workspace = boundedString(input.workspace, 1, 4096, "manifest workspace");
  if (!isAbsolute(workspace) || workspace !== workspace.trim()) throw new SeptError("Invalid durable manifest workspace");
  const thinking = input.thinking;
  if (!(thinking === "off" || thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh" || thinking === "max")) throw new SeptError("Invalid durable manifest thinking");
  const task = boundedString(input.task, 1, 32_768, "manifest task");
  const provider = boundedString(input.provider, 1, 4096, "manifest provider");
  const model = boundedString(input.model, 1, 4096, "manifest model");
  const piVersion = boundedString(input.piVersion, 1, 128, "manifest piVersion");
  if (!task.trim() || provider !== provider.trim() || model !== model.trim() || piVersion !== piVersion.trim()) throw new SeptError("Invalid durable manifest string value");
  return {
    formatVersion: 2,
    runId,
    createdAt: isoDate(input.createdAt, "manifest createdAt"),
    task,
    role: boundedString(input.role, 0, 4096, "manifest role"),
    workspace,
    provider,
    model,
    thinking,
    thresholdPercent: boundedInteger(input.thresholdPercent, 1, 95, "manifest thresholdPercent"),
    handoverReserveTokens: boundedInteger(input.handoverReserveTokens, 1000, 1_000_000, "manifest handoverReserveTokens"),
    maxInvocations: boundedInteger(input.maxInvocations, 1, 10_000, "manifest maxInvocations"),
    maxEpochs: boundedInteger(input.maxEpochs, 1, 1000, "manifest maxEpochs"),
    timeoutSeconds: boundedInteger(input.timeoutSeconds, 1, 604_800, "manifest timeoutSeconds"),
    piVersion,
  };
}

function validateSnapshot(value: unknown): RunSnapshot {
  const input = object(value, "snapshot");
  const required = ["activeMilliseconds", "epoch", "invocations", "phase", "startedAt", "status", "updatedAt"];
  const optional = ["activeSessionFile", "activeSessionId", "handoverEpoch", "predecessorSessionFile", "predecessorSessionId", "reason", "terminalCause"];
  exactKeys(input, required, optional, "snapshot");
  const status = input.status;
  if (!(status === "active" || status === "waiting" || status === "complete" || status === "blocked" || status === "failed")) throw new SeptError("Invalid durable snapshot status");
  const phase = input.phase;
  if (!(phase === "ready" || phase === "running" || phase === "waiting" || phase === "handover_durable" || phase === "replacing" || phase === "terminal")) throw new SeptError("Invalid durable snapshot phase");
  const result: RunSnapshot = {
    status,
    phase,
    epoch: boundedInteger(input.epoch, 1, 1000, "snapshot epoch"),
    invocations: boundedInteger(input.invocations, 0, 10_000, "snapshot invocations"),
    activeMilliseconds: boundedInteger(input.activeMilliseconds, 0, Number.MAX_SAFE_INTEGER, "snapshot activeMilliseconds"),
    startedAt: isoDate(input.startedAt, "snapshot startedAt"),
    updatedAt: isoDate(input.updatedAt, "snapshot updatedAt"),
  };
  for (const field of ["activeSessionFile", "activeSessionId", "predecessorSessionFile", "predecessorSessionId", "reason"] as const) {
    if (input[field] !== undefined) result[field] = boundedString(input[field], 1, field === "reason" ? 65_536 : 4096, `snapshot ${field}`);
  }
  if (input.handoverEpoch !== undefined) result.handoverEpoch = boundedInteger(input.handoverEpoch, 1, 1000, "snapshot handoverEpoch");
  if (input.terminalCause !== undefined) {
    if (!(input.terminalCause === "agent_blocked" || input.terminalCause === "invocation_limit" || input.terminalCause === "epoch_limit" || input.terminalCause === "timeout" || input.terminalCause === "controller_failure")) throw new SeptError("Invalid durable snapshot terminalCause");
    result.terminalCause = input.terminalCause;
  }
  const activePhase = phase === "ready" || phase === "running" || phase === "handover_durable" || phase === "replacing";
  if ((status === "active" && !activePhase) || (status === "waiting" && phase !== "waiting") || ((status === "complete" || status === "blocked" || status === "failed") && phase !== "terminal")) throw new SeptError("Invalid durable snapshot status/phase combination");
  if ((phase === "handover_durable" || phase === "replacing") && (result.predecessorSessionId === undefined || result.handoverEpoch !== result.epoch)) throw new SeptError("Invalid durable snapshot handover state");
  if (result.terminalCause !== undefined && !((status === "blocked" && result.terminalCause !== "controller_failure") || (status === "failed" && result.terminalCause === "controller_failure"))) throw new SeptError("Invalid durable snapshot terminal cause state");
  return result;
}

export class RunStore {
  readonly manifestPath: string;
  readonly snapshotPath: string;
  readonly eventsPath: string;
  readonly messagesPath: string;
  readonly logPath: string;
  readonly leasePath: string;
  private sequence: number;

  constructor(readonly runDir: string) {
    this.manifestPath = join(runDir, "manifest.json");
    this.snapshotPath = join(runDir, "state.json");
    this.eventsPath = join(runDir, "events.jsonl");
    this.messagesPath = join(runDir, "operator-messages.jsonl");
    this.logPath = join(runDir, "agent.log");
    this.leasePath = join(runDir, "controller.lease");
    let sequence = 0;
    scanJsonLines<RunEvent>(this.eventsPath, (event) => { if (typeof event.seq === "number") sequence = event.seq; });
    this.sequence = sequence;
  }

  static create(root: string, manifest: Omit<Manifest, "runId" | "createdAt">, fixedRunId?: string): RunStore {
    ensureDirectory(root);
    const runId = fixedRunId ?? `${new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new SeptError("Run ID is invalid");
    const runDir = join(root, runId);
    if (existsSync(runDir)) throw new SeptError(`Run ${runId} already exists`);
    const temporaryRunDir = join(root, `.creating-${randomUUID()}`);
    mkdirSync(temporaryRunDir, { mode: 0o700 });
    const temporaryStore = new RunStore(temporaryRunDir);
    const createdAt = now();
    const durableManifest = validateManifest({ ...manifest, runId, createdAt }, runId);
    atomicWrite(temporaryStore.manifestPath, durableManifest);
    atomicWrite(temporaryStore.snapshotPath, { status: "active", phase: "ready", epoch: 1, invocations: 0, activeMilliseconds: 0, startedAt: createdAt, updatedAt: createdAt } satisfies RunSnapshot);
    temporaryStore.event("run_started");
    if (existsSync(runDir)) throw new SeptError(`Run ${runId} already exists`);
    renameSync(temporaryRunDir, runDir);
    syncDir(root);
    return new RunStore(runDir);
  }

  get runId(): string { return this.manifest().runId; }
  manifest(): Manifest { return validateManifest(jsonFile<unknown>(this.manifestPath), basename(this.runDir)); }
  snapshot(): RunSnapshot { return validateSnapshot(jsonFile<unknown>(this.snapshotPath)); }

  update(patch: Partial<RunSnapshot>): RunSnapshot {
    const next = validateSnapshot({ ...this.snapshot(), ...patch, updatedAt: now() });
    atomicWrite(this.snapshotPath, next);
    return next;
  }

  event(type: string, fields: Record<string, unknown> = {}): RunEvent {
    const event = { seq: ++this.sequence, type, at: now(), ...fields } as RunEvent;
    appendSynced(this.eventsPath, event);
    return event;
  }

  events(after = 0, limit = 250): RunEvent[] {
    const events: RunEvent[] = [];
    const boundedLimit = Math.min(Math.max(limit, 1), 1000);
    scanJsonLines<RunEvent>(this.eventsPath, (event) => {
      if (typeof event.seq === "number" && event.seq > after) events.push(event);
      return events.length < boundedLimit;
    });
    return events;
  }

  operatorMessage(id: string): OperatorMessage | undefined {
    let found: OperatorMessage | undefined;
    scanJsonLines<OperatorMessage>(this.messagesPath, (message) => {
      if (message.id === id) { found = message; return false; }
    });
    if (found) return found;
    scanJsonLines<RunEvent>(this.eventsPath, (event) => {
      if (!Array.isArray(event.operatorMessages)) return;
      const match = event.operatorMessages.find((message): message is OperatorMessage => !!message && typeof message === "object" && (message as { id?: unknown }).id === id && typeof (message as { text?: unknown }).text === "string" && typeof (message as { createdAt?: unknown }).createdAt === "string");
      if (match) { found = match; return false; }
    });
    return found;
  }

  enqueueMessage(text: string, fixedId?: string): OperatorMessage {
    if (!text.trim() || text.length > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new SeptError("Operator message must contain 1-32768 characters without unsafe control characters");
    if (fixedId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(fixedId)) throw new SeptError("Operator message ID is invalid");
    if (fixedId !== undefined) {
      const existing = this.operatorMessage(fixedId);
      if (existing) {
        if (existing.text !== text) throw new SeptError("Operator message ID collision");
        return existing;
      }
    }
    const pending = this.pendingMessages();
    const pendingBytes = pending.reduce((total, message) => total + Buffer.byteLength(message.text), 0);
    if (pending.length >= MAX_PENDING_MESSAGES || pendingBytes + Buffer.byteLength(text) > MAX_PENDING_MESSAGE_BYTES) throw new QueueCapacityError("Operator message queue capacity exceeded");
    const message = { id: fixedId ?? `${Date.now()}-${randomUUID()}`, createdAt: now(), text };
    appendSynced(this.messagesPath, message);
    this.event("operator_message_queued", { messageId: message.id });
    return message;
  }

  pendingMessages(): OperatorMessage[] {
    const messages = jsonLines<OperatorMessage>(this.messagesPath);
    const byId = new Map(messages.map((message) => [message.id, message]));
    scanJsonLines<RunEvent>(this.eventsPath, (event) => {
      if (event.type !== "operator_messages_consumed" || !Array.isArray(event.messageIds)) return;
      for (const id of event.messageIds) if (typeof id === "string") byId.delete(id);
    });
    const pending = [...byId.values()];
    if (pending.length > MAX_PENDING_MESSAGES || pending.reduce((total, message) => total + Buffer.byteLength(message.text), 0) > MAX_PENDING_MESSAGE_BYTES) throw new QueueCapacityError("Durable operator message queue exceeds configured capacity; operator resolution is required");
    return pending;
  }

  deliveryAttempt(messages: OperatorMessage[], sessionId: string): void {
    if (messages.length) this.event("operator_delivery_attempt", { sessionId, messages });
  }

  consumeMessages(messages: OperatorMessage[], proofType: "work_checkpoint" | "handover_written"): void {
    if (!messages.length) return;
    const ids = messages.map((message) => message.id);
    let proof: RunEvent | undefined;
    scanJsonLines<RunEvent>(this.eventsPath, (event) => {
      if (event.type !== proofType || !Array.isArray(event.messageIds) || !Array.isArray(event.operatorMessages)) return;
      const evidenceIds = event.messageIds as unknown[];
      const evidence = event.operatorMessages as unknown[];
      if (messages.every((message) => evidenceIds.includes(message.id) && evidence.some((item) => !!item && typeof item === "object" && (item as OperatorMessage).id === message.id && (item as OperatorMessage).createdAt === message.createdAt && (item as OperatorMessage).text === message.text))) proof = event;
    });
    if (!proof) throw new SeptError(`Cannot acknowledge operator input before durable ${proofType} proof`);
    this.event("operator_messages_consumed", { messageIds: ids, proofSeq: proof.seq });
    const remaining = this.pendingMessages();
    atomicWrite(this.messagesPath, remaining.map((message) => JSON.stringify(message)).join("\n"));
  }

  persistHandover(epoch: number, predecessorSessionId: string, predecessorSessionFile: string | undefined, handover: Handover, messages: OperatorMessage[]): DurableHandover {
    const dir = join(this.runDir, "handovers");
    const value: DurableHandover = { formatVersion: 1, runId: this.runId, epoch, predecessorSessionId, predecessorSessionFile, operatorMessages: messages, handover, writtenAt: now() };
    const stem = `epoch-${String(epoch).padStart(4, "0")}`;
    atomicWrite(join(dir, `${stem}.json`), value);
    atomicWrite(join(dir, `${stem}.md`), renderHandover(value));
    this.event("handover_written", { epoch, predecessorSessionId, json: `handovers/${stem}.json`, markdown: `handovers/${stem}.md`, messageIds: messages.map((message) => message.id), operatorMessages: messages });
    this.update({ phase: "handover_durable", predecessorSessionId, predecessorSessionFile, handoverEpoch: epoch });
    this.consumeMessages(messages, "handover_written");
    return value;
  }

  latestHandover(): DurableHandover | undefined {
    let path: string | undefined;
    scanJsonLines<RunEvent>(this.eventsPath, (event) => { if (event.type === "handover_written" && typeof event.json === "string") path = event.json; });
    return path ? jsonFile<DurableHandover>(join(this.runDir, path)) : undefined;
  }

  checkpoint(control: WorkControl, messages: OperatorMessage[], sessionId: string): void {
    this.event("work_checkpoint", { control, sessionId, messageIds: messages.map((message) => message.id), operatorMessages: messages });
    this.consumeMessages(messages, "work_checkpoint");
  }

  recoveryContext(): string {
    const handover = this.latestHandover();
    let checkpoint: RunEvent | undefined;
    scanJsonLines<RunEvent>(this.eventsPath, (event) => { if (event.type === "work_checkpoint" && event.control && typeof event.control === "object") checkpoint = event; });
    return JSON.stringify({
      handover: handover ?? null,
      latestWorkControl: checkpoint?.control ?? null,
      note: "The controller restarted. Trust this durable state and the workspace; do not assume an interrupted, uncheckpointed action completed.",
    }, null, 2);
  }

  log(record: Record<string, unknown>, maxBytes = 5 * 1024 * 1024): void {
    appendSynced(this.logPath, { at: now(), ...record });
    if (statSync(this.logPath).size <= maxBytes) return;
    const content = readFileSync(this.logPath);
    const tail = content.subarray(Math.max(0, content.length - Math.floor(maxBytes * 0.8)));
    const firstNewline = tail.indexOf(10);
    atomicWrite(this.logPath, tail.subarray(firstNewline < 0 ? 0 : firstNewline + 1).toString("utf8"));
  }

  logTail(maxBytes = 512 * 1024): string {
    if (!existsSync(this.logPath)) return "";
    const content = readFileSync(this.logPath);
    return content.subarray(Math.max(0, content.length - Math.min(maxBytes, 1024 * 1024))).toString("utf8");
  }

  acquireLease(): () => void {
    const owner = { ownerId: randomUUID(), ...PROCESS_IDENTITY, heartbeatAt: now() };
    try { writeFileSync(this.leasePath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      let current: typeof owner | undefined;
      try { current = JSON.parse(readFileSync(this.leasePath, "utf8")) as typeof owner; } catch {}
      const age = Date.now() - statSync(this.leasePath).mtimeMs;
      if (current?.hostname === owner.hostname && current.processStartedAt === owner.processStartedAt) {
        throw new SeptError(`Run ${this.runId} is already controlled by this process`);
      }
      if (current?.hostname === owner.hostname && Number.isInteger(current.pid) && current.pid !== owner.pid) {
        try { process.kill(current.pid, 0); }
        catch (inner) {
          if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw new SeptError(`Cannot verify the owner of run ${this.runId}; refusing lease takeover`);
          current = undefined;
        }
        if (current) throw new SeptError(`Run ${this.runId} is already controlled by pid ${current.pid}`);
      }
      if (age < 5_000) throw new SeptError(`Run ${this.runId} has a recent controller lease; retry adoption shortly`);
      unlinkSync(this.leasePath);
      return this.acquireLease();
    }
    syncDir(this.runDir);
    const heartbeat = setInterval(() => {
      try {
        const current = jsonFile<typeof owner>(this.leasePath);
        if (current.ownerId === owner.ownerId) writeFileSync(this.leasePath, `${JSON.stringify({ ...owner, heartbeatAt: now() })}\n`, { mode: 0o600 });
      } catch {}
    }, 1_000);
    heartbeat.unref();
    return () => {
      clearInterval(heartbeat);
      try {
        const current = jsonFile<typeof owner>(this.leasePath);
        if (current.ownerId === owner.ownerId) { unlinkSync(this.leasePath); syncDir(this.runDir); }
      } catch {}
    };
  }
}

export function acquireStateRootLease(root: string): () => void {
  ensureDirectory(root);
  const path = join(root, "worker.lease");
  const acquire = (): (() => void) => {
    const owner = { ownerId: randomUUID(), ...PROCESS_IDENTITY, heartbeatAt: now() };
    try { writeFileSync(path, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: typeof owner | undefined;
      try { current = JSON.parse(readFileSync(path, "utf8")) as typeof owner; }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") return acquire();
      }
      let age: number;
      try { age = Date.now() - statSync(path).mtimeMs; }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code === "ENOENT") return acquire(); throw statError; }
      if (current?.hostname === owner.hostname && current.processStartedAt === owner.processStartedAt) throw new SeptError("Worker state root is already owned by this process");
      if (current?.hostname === owner.hostname && Number.isInteger(current.pid) && current.pid !== owner.pid) {
        try { process.kill(current.pid, 0); }
        catch (inner) {
          if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw new SeptError("Cannot verify the worker state-root owner; refusing lease takeover");
          current = undefined;
        }
        if (current) throw new SeptError(`Worker state root is already owned by pid ${current.pid}`);
      }
      if (age < 5_000) throw new SeptError("Worker state root has a recent ownership lease; retry shortly");
      try { unlinkSync(path); }
      catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError; }
      return acquire();
    }
    syncDir(root);
    const heartbeat = setInterval(() => {
      try {
        const current = jsonFile<typeof owner>(path);
        if (current.ownerId === owner.ownerId) writeFileSync(path, `${JSON.stringify({ ...owner, heartbeatAt: now() })}\n`, { mode: 0o600 });
      } catch {}
    }, 1_000);
    heartbeat.unref();
    return () => {
      clearInterval(heartbeat);
      try {
        const current = jsonFile<typeof owner>(path);
        if (current.ownerId === owner.ownerId) { unlinkSync(path); syncDir(root); }
      } catch {}
    };
  };
  return acquire();
}

export function listRuns(root: string): RunStore[] {
  if (!existsSync(root)) return [];
  const stores: RunStore[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "webhook-receipts") continue;
    const runDir = resolve(root, entry.name);
    const manifestPath = join(runDir, "manifest.json");
    const snapshotPath = join(runDir, "state.json");
    const hasManifest = existsSync(manifestPath);
    const hasSnapshot = existsSync(snapshotPath);
    if (!hasManifest) {
      if (hasSnapshot) throw new SeptError(`Partial durable v2 run ${entry.name} is missing manifest.json`);
      continue;
    }
    const manifest = jsonFile<unknown>(manifestPath);
    const formatVersion = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? (manifest as { formatVersion?: unknown }).formatVersion : undefined;
    if (formatVersion !== 2) {
      if (!hasSnapshot) continue;
      throw new SeptError(`Unsupported or partial durable run ${entry.name}`);
    }
    if (!hasSnapshot) throw new SeptError(`Partial durable v2 run ${entry.name} is missing state.json`);
    const store = new RunStore(runDir);
    store.manifest();
    store.snapshot();
    stores.push(store);
  }
  return stores;
}

export function parseJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].at(-1)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return JSON.parse(candidate.trim()); } catch { throw new SeptError("Assistant did not return valid terminal JSON"); }
}

function controlString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > MAX_CONTROL_STRING_CHARS) throw new SeptError(`${field} must be a string of at most ${MAX_CONTROL_STRING_CHARS} characters`);
  return value;
}
function controlStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONTROL_ARRAY_ITEMS || value.some((item) => typeof item !== "string" || item.length > MAX_CONTROL_STRING_CHARS)) throw new SeptError(`${field} must be an array of at most ${MAX_CONTROL_ARRAY_ITEMS} strings of at most ${MAX_CONTROL_STRING_CHARS} characters`);
  return value;
}
function boundedControl<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTROL_BYTES) throw new SeptError(`Assistant control exceeds ${MAX_CONTROL_BYTES} bytes`);
  return value;
}

export function validateWork(value: unknown): WorkControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeptError("Work control must be an object");
  const input = value as Record<string, unknown>;
  const expected = ["next_action", "status", "summary", "verification"];
  if (Object.keys(input).sort().join() !== expected.join()) throw new SeptError("Work control has unexpected fields");
  if (!(["continue", "waiting", "complete", "blocked"] as unknown[]).includes(input.status)) throw new SeptError("Work control status is invalid");
  const result = { status: input.status, summary: controlString(input.summary, "summary"), verification: controlStrings(input.verification, "verification"), next_action: controlString(input.next_action, "next_action") } as WorkControl;
  if ((result.status === "continue" || result.status === "waiting") && !result.next_action.trim()) throw new SeptError(`${result.status} work requires next_action`);
  return boundedControl(result);
}

export function validateHandover(value: unknown): Handover {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeptError("Handover must be an object");
  const input = value as Record<string, unknown>;
  const expected = ["handover_summary", "entry_state_and_done", ...HANDOVER_FIELDS, "next_action"].sort();
  if (Object.keys(input).sort().join() !== expected.join()) throw new SeptError("Handover has unexpected fields");
  const result = { handover_summary: controlString(input.handover_summary, "handover_summary"), entry_state_and_done: controlString(input.entry_state_and_done, "entry_state_and_done"), next_action: controlString(input.next_action, "next_action") } as Handover;
  for (const field of HANDOVER_FIELDS) result[field] = controlStrings(input[field], field);
  if (!result.next_action.trim()) throw new SeptError("Handover requires next_action");
  return boundedControl(result);
}

function renderHandover(value: DurableHandover): string {
  const h = value.handover;
  const sections = [`# SEPT cycle handover`, `Predecessor Pi session: \`${value.predecessorSessionId}\``, h.handover_summary, `## Entry state and definition of done\n\n${h.entry_state_and_done}`];
  for (const field of HANDOVER_FIELDS) sections.push(`## ${field.replaceAll("_", " ")}\n\n${h[field].length ? h[field].map((item) => `- ${item}`).join("\n") : "- None recorded."}`);
  sections.push(`## Exact next action\n\n${h.next_action}`);
  if (value.operatorMessages.length) sections.push(`## Incorporated operator input\n\n\`\`\`json\n${JSON.stringify(value.operatorMessages, null, 2)}\n\`\`\``);
  return `${sections.join("\n\n")}\n`;
}
