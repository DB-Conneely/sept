import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Manifest } from "../durable/index.js";
import { acquireStateRootLease, listRuns, RunStore, SeptError } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError, NOOP_TELEMETRY } from "../observability/index.js";
import { CycleController, type HostFactory } from "./controller.js";

export interface WorkerRuntimeOptions {
  stateRoot: string;
  agentDir: string;
  hostFactory?: HostFactory;
  workspaceRoot?: string;
  observability?: Observability;
}

export type WorkerAdoption = "none" | "active" | "waiting" | "wake_recovered";
export type WorkerStatus = "idle" | "busy" | "waiting";

/** Owns the single resident run and controller lifecycle, independently of HTTP transport. */
export class WorkerRuntime {
  private active?: { store: RunStore; promise: Promise<void> };
  private resident?: RunStore;
  private releaseRoot?: () => void;
  private initialized = false;
  private stopping = false;
  private readonly observability: Observability;

  constructor(private readonly options: WorkerRuntimeOptions) {
    this.observability = options.observability ?? NOOP_TELEMETRY;
  }

  initialize(): WorkerAdoption {
    if (this.initialized || this.releaseRoot) throw new SeptError("Worker runtime is already initialized");
    if (this.stopping) throw new SeptError("Worker runtime is stopping");
    this.releaseRoot = acquireStateRootLease(this.options.stateRoot);
    try {
      const resident = listRuns(this.options.stateRoot).filter((store) => {
        const status = store.snapshot().status;
        if (status === "active" || status === "waiting") {
          this.assertAssignedWorkspace(store);
          return true;
        }
        return false;
      });
      if (resident.length > 1) throw new SeptError(`Single-slot worker found ${resident.length} resumable runs; operator resolution is required`);
      this.resident = resident[0];
      const residentStatus = this.resident?.snapshot().status;
      let adoption: WorkerAdoption = residentStatus === "active" || residentStatus === "waiting" ? residentStatus : "none";
      if (this.resident?.snapshot().status === "waiting" && this.resident.pendingMessages().length) {
        const messageIds = this.resident.pendingMessages().map((message) => message.id);
        this.resident.update({ status: "active", phase: "ready", reason: undefined, terminalCause: undefined });
        this.resident.event("run_wake_recovered", { messageIds });
        adoption = "wake_recovered";
        this.observability.log("run.wake_recovered", { "sept.run.id": this.resident.runId, "sept.queue.depth": messageIds.length, "sept.outcome": "active" });
      }
      this.initialized = true;
      if (this.resident?.snapshot().status === "active") this.launch(this.resident);
      return adoption;
    } catch (error) {
      this.releaseRoot();
      this.releaseRoot = undefined;
      throw error;
    }
  }

  beginStop(): void { this.stopping = true; }

  async stop(): Promise<void> {
    this.beginStop();
    try { await this.active?.promise; }
    finally {
      this.releaseRoot?.();
      this.releaseRoot = undefined;
      this.initialized = false;
    }
  }

  status(): { worker: WorkerStatus; activeRunId: string | null } {
    return {
      worker: this.active ? "busy" : this.resident?.snapshot().status === "waiting" ? "waiting" : "idle",
      activeRunId: this.resident?.runId ?? null,
    };
  }

  syncObservability(): void {
    const current = this.status().worker;
    this.observability.setWorkerState(current);
    const snapshot = this.resident?.snapshot();
    this.observability.setRunState(snapshot?.status ?? "none", snapshot?.epoch, snapshot?.invocations, this.resident?.pendingMessages().length);
  }

  findRun(runId: string): RunStore {
    const store = this.active?.store.runId === runId
      ? this.active.store
      : listRuns(this.options.stateRoot).find((candidate) => candidate.runId === runId);
    if (!store) throw new RunNotFoundError("unknown run");
    this.assertAssignedWorkspace(store);
    return store;
  }

  assertTaskAvailable(): void {
    if (this.stopping) throw new WorkerConflictError("worker is stopping");
    if (!this.initialized) throw new WorkerConflictError("worker is not ready");
    if (this.resident) throw new WorkerConflictError("single worker slot is busy");
  }

  createTask(manifest: Omit<Manifest, "runId" | "createdAt">, fixedRunId?: string): { runId: string; status: "active" } {
    return this.observability.spanSync("sept.task.create", {}, () => {
      this.assertTaskAvailable();
      this.assertWorkspacePath(manifest.workspace);
      const store = RunStore.create(this.options.stateRoot, manifest, fixedRunId);
      this.observability.event("sept.task.durable", { "sept.run.id": store.runId, "sept.run.state": "active" });
      this.observability.log("task.created", { "sept.run.id": store.runId, "sept.run.state": "active", "sept.outcome": "accepted" });
      this.launch(store);
      return { runId: store.runId, status: "active" };
    });
  }

  adoptWebhookTask(store: RunStore): { kind: "task"; runId: string; status: "active" } {
    this.assertAssignedWorkspace(store);
    if (store.snapshot().status === "active" && !this.active) this.launch(store);
    return { kind: "task", runId: store.runId, status: "active" };
  }

  assertMessageAvailable(store: RunStore, existing: boolean): void {
    this.messageAdmission(store, existing);
  }

  sendMessage(store: RunStore, text: string, fixedId?: string) {
    return this.observability.spanSync("sept.operator.enqueue", { "sept.run.id": store.runId }, () => {
      const existing = fixedId === undefined ? undefined : store.operatorMessage(fixedId);
      const snapshot = this.messageAdmission(store, existing !== undefined);
      const message = store.enqueueMessage(text, fixedId);
      const queueDepth = store.pendingMessages().length;
      this.observability.setQueueDepth(queueDepth);
      this.observability.event("sept.operator.queued", { "sept.queue.depth": queueDepth, "sept.outcome": existing ? "duplicate" : "accepted" });
      this.observability.log("operator_message.queued", { "sept.run.id": store.runId, "sept.run.state": snapshot.status, "sept.queue.depth": queueDepth, "sept.outcome": existing ? "duplicate" : "accepted" });
      if (existing) return message;
      if (snapshot.status === "blocked" || snapshot.status === "waiting") {
        store.update({ status: "active", phase: "ready", reason: undefined, terminalCause: undefined });
        store.event(snapshot.status === "waiting" ? "run_woken" : "run_reopened", { messageId: message.id });
        this.observability.setRunState("active", snapshot.epoch, snapshot.invocations, queueDepth);
        this.observability.event(snapshot.status === "waiting" ? "sept.run.woken" : "sept.run.reopened", { "sept.queue.depth": queueDepth });
        this.observability.log(snapshot.status === "waiting" ? "run.woken" : "run.reopened", { "sept.run.id": store.runId, "sept.run.state": "active", "sept.queue.depth": queueDepth });
        if (!this.active) this.launch(store);
      }
      return message;
    });
  }

  private launch(store: RunStore): void {
    if (this.active) {
      if (this.active.store.runId === store.runId) return;
      throw new SeptError("single worker slot already has a controller");
    }
    this.resident = store;
    this.observability.setWorkerState("busy");
    const launched = store.snapshot();
    this.observability.setRunState(launched.status, launched.epoch, launched.invocations, store.pendingMessages().length);
    this.observability.log("controller.launched", { "sept.run.id": store.runId, "sept.run.state": launched.status, "sept.epoch": launched.epoch, "sept.invocation": launched.invocations });
    let promise!: Promise<void>;
    promise = this.control(store).finally(() => {
      if (this.active?.promise !== promise) return;
      this.active = undefined;
      const status = store.snapshot().status;
      if (status === "active" && !this.stopping) this.launch(store);
      else if (status !== "waiting" && this.resident?.runId === store.runId) this.resident = undefined;
      const workerState = status === "active" ? "busy" : status === "waiting" ? "waiting" : "idle";
      this.observability.setWorkerState(workerState);
      const residentSnapshot = this.resident?.snapshot();
      this.observability.setRunState(residentSnapshot?.status ?? "none", residentSnapshot?.epoch, residentSnapshot?.invocations, this.resident?.pendingMessages().length);
    });
    this.active = { store, promise };
  }

  private async control(store: RunStore): Promise<void> {
    while (store.snapshot().status === "active") {
      try {
        await new CycleController(store, this.options.agentDir, this.options.hostFactory, this.observability, () => this.stopping).run();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.log({ type: "controller_exit", error: message });
        this.observability.log("controller.exit", { "sept.run.id": store.runId, "sept.outcome": "failure", "error.type": classifyError(error) }, "warn");
        if (store.snapshot().status === "active" && /controller lease|controlled by pid/.test(message)) {
          if (this.stopping) return;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
          continue;
        }
        return;
      }
    }
  }

  private assertAssignedWorkspace(store: RunStore): void { this.assertWorkspacePath(store.manifest().workspace); }

  private assertWorkspacePath(workspace: string): void {
    if (!this.options.workspaceRoot) return;
    let canonical: string;
    try {
      canonical = realpathSync(workspace);
      if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    } catch { throw new SeptError("durable run workspace is unavailable or is not a directory"); }
    const child = relative(this.options.workspaceRoot, canonical);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new SeptError("durable run workspace is outside the configured workspace root");
  }

  private messageAdmission(store: RunStore, existing: boolean) {
    const snapshot = store.snapshot();
    if (existing) return snapshot;
    if (this.stopping) throw new WorkerConflictError("worker is stopping");
    if (!this.initialized) throw new WorkerConflictError("worker is not ready");
    if (snapshot.status === "blocked" && this.active) throw new WorkerConflictError("single worker slot is busy; retry the message when idle");
    if (snapshot.status === "waiting" && this.active && this.active.store.runId !== store.runId) throw new WorkerConflictError("single worker slot is busy; retry the message when idle");
    if (snapshot.status === "complete" || snapshot.status === "failed") throw new WorkerConflictError(`run is ${snapshot.status}`);
    if (snapshot.status === "blocked" && (snapshot.terminalCause === "invocation_limit" || snapshot.terminalCause === "epoch_limit" || snapshot.terminalCause === "timeout")) throw new WorkerConflictError("run exhausted its configured limits");
    const manifest = store.manifest();
    if (snapshot.invocations >= manifest.maxInvocations || snapshot.activeMilliseconds >= manifest.timeoutSeconds * 1000 || (snapshot.status === "blocked" && snapshot.handoverEpoch === snapshot.epoch && snapshot.epoch >= manifest.maxEpochs)) throw new WorkerConflictError("run exhausted its configured limits");
    if (snapshot.status === "active" && snapshot.phase === "running" && snapshot.epoch >= manifest.maxEpochs) throw new WorkerConflictError("run cannot guarantee another delivery at its configured epoch limit");
    return snapshot;
  }
}

export class WorkerConflictError extends SeptError {}
export class RunNotFoundError extends SeptError {}
