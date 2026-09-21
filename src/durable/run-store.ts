import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ConversationEvent,
  DurableHandover,
  Handover,
  Manifest,
  OperatorMessage,
  RunEvent,
  RunSnapshot,
  WorkControl,
} from "./contracts.js";
import { ConversationStore } from "./conversation-store.js";
import { ContextTransferStore } from "./context-transfer-store.js";
import { SeptError } from "./errors.js";
import { atomicWrite, ensureDirectory, now, readJson, syncDirectory } from "./filesystem.js";
import { acquireRunLease } from "./lease.js";
import { OperatorQueue } from "./operator-queue.js";
import { RunEvidenceStore } from "./run-evidence.js";
import { validateManifest, validateSnapshot } from "./state-codecs.js";

interface ConversationPage {
  events: ConversationEvent[];
  nextCursor: number;
  retainedFrom: number;
}

function generatedRunId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function initialSnapshot(createdAt: string): RunSnapshot {
  return {
    status: "active",
    phase: "ready",
    epoch: 1,
    invocations: 0,
    activeMilliseconds: 0,
    startedAt: createdAt,
    updatedAt: createdAt,
  };
}

function terminalStatus(snapshot: RunSnapshot): boolean {
  return (
    snapshot.status === "cancelled" ||
    snapshot.status === "complete" ||
    snapshot.status === "blocked" ||
    snapshot.status === "failed"
  );
}

/** Durable facade for one run's lifecycle, evidence, queue, and conversation stores. */
export class RunStore {
  public readonly manifestPath: string;
  public readonly snapshotPath: string;
  public readonly eventsPath: string;
  public readonly messagesPath: string;
  public readonly conversationPath: string;
  public readonly logPath: string;
  public readonly leasePath: string;
  private readonly evidence: RunEvidenceStore;
  private readonly conversationStore: ConversationStore;
  private readonly operatorQueue: OperatorQueue;
  private readonly contextTransfer: ContextTransferStore;

  public constructor(public readonly runDir: string) {
    this.manifestPath = join(runDir, "manifest.json");
    this.snapshotPath = join(runDir, "state.json");
    this.eventsPath = join(runDir, "events.jsonl");
    this.messagesPath = join(runDir, "operator-messages.jsonl");
    this.conversationPath = join(runDir, "conversation.jsonl");
    this.logPath = join(runDir, "agent.log");
    this.leasePath = join(runDir, "controller.lease");
    this.evidence = new RunEvidenceStore(this.eventsPath, this.logPath);
    this.conversationStore = new ConversationStore(
      this.conversationPath,
      this.eventsPath,
      (type, fields) => {
        this.event(type, fields ?? {});
      },
    );
    this.operatorQueue = new OperatorQueue(
      { messages: this.messagesPath, events: this.eventsPath },
      this.conversationStore,
      (type, fields) => this.event(type, fields ?? {}),
    );
    this.contextTransfer = new ContextTransferStore({
      runDir,
      runId: basename(runDir),
      eventsPath: this.eventsPath,
      recordRunEvent: (type, fields) => this.event(type, fields ?? {}),
      updateSnapshot: (patch) => this.update(patch),
      consumeMessages: (messages, proofType) => {
        this.consumeMessages(messages, proofType);
      },
    });
  }

  /** Create and durably publish one complete run directory atomically. */
  public static create(
    root: string,
    manifest: Omit<Manifest, "runId" | "createdAt">,
    fixedRunId?: string,
  ): RunStore {
    ensureDirectory(root);
    const runId = fixedRunId ?? generatedRunId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
      throw new SeptError("Run ID is invalid");
    }
    const runDir = join(root, runId);
    if (existsSync(runDir)) {
      throw new SeptError(`Run ${runId} already exists`);
    }
    const temporaryRunDir = join(root, `.creating-${randomUUID()}`);
    mkdirSync(temporaryRunDir, { mode: 0o700 });
    const temporaryStore = new RunStore(temporaryRunDir);
    temporaryStore.initialize(manifest, runId);
    if (existsSync(runDir)) {
      throw new SeptError(`Run ${runId} already exists`);
    }
    renameSync(temporaryRunDir, runDir);
    syncDirectory(root);
    return new RunStore(runDir);
  }

  /** Return the validated run identity bound to its directory name. */
  public get runId(): string {
    return this.manifest().runId;
  }

  /** Read and validate the immutable run manifest. */
  public manifest(): Manifest {
    return validateManifest(readJson(this.manifestPath), basename(this.runDir));
  }

  /** Read and validate the latest authoritative lifecycle snapshot. */
  public snapshot(): RunSnapshot {
    return validateSnapshot(readJson(this.snapshotPath));
  }

  /** Atomically apply a validated lifecycle transition without revoking cancellation. */
  public update(patch: Partial<RunSnapshot>): RunSnapshot {
    const current = this.snapshot();
    const revokesCancelled =
      current.status === "cancelled" && patch.status !== undefined && patch.status !== "cancelled";
    if (revokesCancelled) {
      throw new SeptError("Cancelled run state is immutable");
    }
    const revokesIntent =
      current.status === "cancelling" &&
      patch.status !== undefined &&
      patch.status !== "cancelling" &&
      patch.status !== "cancelled";
    if (revokesIntent) {
      throw new SeptError("Cancellation intent is immutable");
    }
    const next = validateSnapshot({ ...current, ...patch, updatedAt: now() });
    atomicWrite(this.snapshotPath, next);
    return next;
  }

  /** Append one fsynced internal lifecycle event. */
  public event(type: string, fields: Record<string, unknown> = {}): RunEvent {
    return this.evidence.event(type, fields);
  }

  /** Return one bounded page of internal lifecycle events. */
  public events(after = 0, limit = 250): RunEvent[] {
    return this.evidence.events(after, limit);
  }

  /** Return one bounded page of client-facing conversation evidence. */
  public conversation(after = 0, limit = 100): ConversationPage {
    return this.conversationStore.page(after, limit);
  }

  /** Persist one exact user or validated assistant conversation message. */
  public conversationMessage(
    id: string,
    role: "user" | "assistant",
    text: string,
  ): ConversationEvent {
    return this.conversationStore.message(id, role, text);
  }

  /** Persist one active or waiting client-facing lifecycle event. */
  public conversationState(id: string, state: "active" | "waiting"): ConversationEvent {
    return this.conversationStore.state(id, state);
  }

  /** Recreate missing initial task conversation evidence after an interrupted seam. */
  public ensureInitialConversation(): void {
    this.conversationStore.ensureInitial(`task-${this.runId}`, this.manifest().task);
  }

  /** Recover accepted operator conversation records after an interrupted projection. */
  public reconcileOperatorConversation(): void {
    this.conversationStore.reconcileOperators(this.messagesPath);
  }

  /** Ensure the client-facing terminal event matches authoritative state. */
  public ensureTerminalConversation(snapshot = this.snapshot()): void {
    this.conversationStore.ensureTerminal(snapshot);
  }

  /** Persist cancellation intent before any native Pi abort is requested. */
  public requestCancellation(): RunSnapshot {
    const snapshot = this.snapshot();
    if (snapshot.status === "cancelling" || terminalStatus(snapshot)) {
      return snapshot;
    }
    const reason = "Cancelled by authenticated operator.";
    const cancelling = this.update({
      status: "cancelling",
      phase: "cancelling",
      reason,
      terminalCause: "operator_cancelled",
    });
    this.event("run_cancellation_requested", { reason: "operator_cancelled" });
    return cancelling;
  }

  /** Settle durable cancellation idempotently and prevent late controller output. */
  public finishCancellation(): RunSnapshot {
    const snapshot = this.snapshot();
    if (snapshot.status === "cancelled") {
      this.ensureTerminalConversation(snapshot);
      return snapshot;
    }
    if (snapshot.status !== "cancelling") {
      return snapshot;
    }
    const cancelled = this.update({
      status: "cancelled",
      phase: "terminal",
      reason: "Cancelled by authenticated operator.",
      terminalCause: "operator_cancelled",
    });
    this.event("run_cancelled", { reason: "operator_cancelled" });
    this.ensureTerminalConversation(cancelled);
    return cancelled;
  }

  /** Find exact accepted operator input by stable identifier. */
  public operatorMessage(id: string): OperatorMessage | undefined {
    return this.operatorQueue.message(id);
  }

  /** Durably enqueue exact operator text within per-run capacity. */
  public enqueueMessage(text: string, fixedId?: string): OperatorMessage {
    return this.operatorQueue.enqueue(text, fixedId);
  }

  /** Return exact accepted input that lacks durable consumption proof. */
  public pendingMessages(): OperatorMessage[] {
    return this.operatorQueue.pending();
  }

  /** Record exact delivery evidence before an invocation can consume input. */
  public deliveryAttempt(messages: OperatorMessage[], sessionId: string): void {
    this.operatorQueue.deliveryAttempt(messages, sessionId);
  }

  /** Consume operator input only after matching durable checkpoint evidence. */
  public consumeMessages(
    messages: OperatorMessage[],
    proofType: "work_checkpoint" | "handover_written",
  ): void {
    this.operatorQueue.consume(messages, proofType);
  }

  /** Persist handover artifacts and replacement authority before consuming input. */
  public persistHandover(
    epoch: number,
    predecessorSessionId: string,
    predecessorSessionFile: string | undefined,
    handover: Handover,
    messages: OperatorMessage[],
  ): DurableHandover {
    return this.contextTransfer.persistHandover(
      epoch,
      predecessorSessionId,
      predecessorSessionFile,
      handover,
      messages,
    );
  }

  /** Return the latest validated handover selected by durable event order. */
  public latestHandover(): DurableHandover | undefined {
    return this.contextTransfer.latestHandover();
  }

  /** Persist exact checkpoint evidence before marking operator input consumed. */
  public checkpoint(control: WorkControl, messages: OperatorMessage[], sessionId: string): void {
    this.contextTransfer.checkpoint(control, messages, sessionId);
  }

  /** Build bounded restart context from the latest durable handover and checkpoint. */
  public recoveryContext(): string {
    return this.contextTransfer.recoveryContext();
  }

  /** Append one bounded payload-free operational log record. */
  public log(record: Record<string, unknown>, maxBytes = 5 * 1024 * 1024): void {
    this.evidence.log(record, maxBytes);
  }

  /** Return a bounded tail of payload-free operational logs. */
  public logTail(maxBytes = 512 * 1024): string {
    return this.evidence.logTail(maxBytes);
  }

  /** Acquire exclusive controller authority for this run. */
  public acquireLease(): () => void {
    return acquireRunLease(this.runDir, this.runId);
  }

  private initialize(manifest: Omit<Manifest, "runId" | "createdAt">, runId: string): void {
    const createdAt = now();
    const durableManifest = validateManifest({ ...manifest, runId, createdAt }, runId);
    atomicWrite(this.manifestPath, durableManifest);
    atomicWrite(this.snapshotPath, validateSnapshot(initialSnapshot(createdAt)));
    this.event("run_started");
    this.conversationMessage(`task-${runId}`, "user", durableManifest.task);
  }
}
