/**
 * Owns one process-local resident run slot under an exclusive state-root lease. HTTP and webhook
 * layers call this transport-independent authority; durable stores own persisted state, while the
 * worker owns restart adoption, admission rechecks, controller lifetime, drain, wake, and shutdown.
 */

import type { Manifest } from "../durable/index.js";
import {
  acquireStateRootLease,
  listRuns,
  RunStore,
  SeptError,
  WorkerLifecycleStore,
} from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { NOOP_TELEMETRY } from "../observability/index.js";
import { assertCompatibleStateRoot, assertNativeRun } from "../pi-integration/index.js";
import type {
  WorkerAdoption,
  WorkerRuntimeOptions,
  WorkerStatus,
  WorkerStatusResult,
} from "./contracts.js";
import { RunNotFoundError, WorkerConflictError } from "./errors.js";
import { WorkerExecutionSlot } from "./worker-execution.js";
import { assertMessageAdmission, assertWorkspaceConfined } from "./worker-policy.js";
import { WorkerMessages } from "./worker-messages.js";
import { recoverWorkerResident } from "./worker-recovery.js";

function workerStatus(active: boolean, resident: RunStore | undefined): WorkerStatus {
  if (active) {
    return "busy";
  }
  return resident?.snapshot().status === "waiting" ? "waiting" : "idle";
}

/** Owns restart reconciliation and all mutations of the worker's single resident slot. */
export class WorkerRuntime {
  private readonly execution: WorkerExecutionSlot;
  private readonly messages: WorkerMessages;
  private resident: RunStore | undefined;
  private releaseRoot: (() => void) | undefined;
  private initialized = false;
  private stopping = false;
  private readonly observability: Observability;
  private readonly lifecycle: WorkerLifecycleStore;

  public constructor(private readonly options: WorkerRuntimeOptions) {
    this.observability = options.observability ?? NOOP_TELEMETRY;
    this.lifecycle = new WorkerLifecycleStore(options.stateRoot);
    this.execution = new WorkerExecutionSlot(
      options.agentDir,
      options.hostFactory,
      this.observability,
      () => this.stopping,
      (store) => {
        this.finishController(store);
      },
    );
    this.messages = new WorkerMessages(
      this.observability,
      (store, existing) => this.messageAdmission(store, existing),
      (store) => {
        if (!this.execution.isActive()) {
          this.launch(store);
        }
      },
    );
  }

  /** Acquire state-root authority, reconcile durable runs, and launch the sole active resident. */
  public initialize(): WorkerAdoption {
    if (this.initialized || this.releaseRoot !== undefined) {
      throw new SeptError("Worker runtime is already initialized");
    }
    if (this.stopping) {
      throw new SeptError("Worker runtime is stopping");
    }
    assertCompatibleStateRoot(this.options.stateRoot, this.observability);
    this.releaseRoot = acquireStateRootLease(this.options.stateRoot);
    try {
      const recovered = recoverWorkerResident(
        this.options.stateRoot,
        this.observability,
        (store) => {
          this.assertAssignedWorkspace(store);
        },
      );
      this.resident = recovered.resident;
      this.initialized = true;
      if (this.resident?.snapshot().status === "active") {
        this.launch(this.resident);
      } else {
        this.settleDrain();
      }
      return recovered.adoption;
    } catch (error: unknown) {
      this.releaseStateRoot();
      throw error;
    }
  }

  /** Stop future admission synchronously while allowing the active controller to checkpoint. */
  public beginStop(): void {
    this.stopping = true;
  }

  /** Wait for the active controller's safe boundary, then release state-root authority. */
  public async stop(): Promise<void> {
    this.beginStop();
    try {
      await this.execution.wait();
    } finally {
      this.releaseStateRoot();
      this.initialized = false;
    }
  }

  /** Return a credential-free projection of live slot occupancy and durable readiness. */
  public status(): WorkerStatusResult {
    const readiness = this.lifecycle.read().readiness;
    return {
      worker: workerStatus(this.execution.isActive(), this.resident),
      readiness,
      acceptingWork: readiness === "accepting" && !this.stopping && this.initialized,
      activeRunId: this.resident?.runId ?? null,
    };
  }

  /** Durably reject new work and settle to drained once resident execution is safe. */
  public drain(): WorkerStatusResult {
    if (!this.initialized) {
      throw new WorkerConflictError("worker is not ready");
    }
    if (this.stopping) {
      throw new WorkerConflictError("worker is stopping");
    }
    const state = this.lifecycle.beginDrain();
    if (state.readiness === "draining") {
      this.settleDrain();
    }
    return this.status();
  }

  /** Persist cancellation intent before native abort, then return the durable cancellation state. */
  public async cancel(store: RunStore): Promise<{
    runId: string;
    status: ReturnType<RunStore["snapshot"]>["status"];
    cancelled: boolean;
  }> {
    assertNativeRun(store);
    const before = store.snapshot();
    if (before.status === "complete" || before.status === "blocked" || before.status === "failed") {
      return { runId: store.runId, status: before.status, cancelled: false };
    }
    if (before.status === "cancelled") {
      return { runId: store.runId, status: "cancelled", cancelled: true };
    }
    store.requestCancellation();
    const aborted = await this.execution.abort(store.runId);
    if (!aborted) {
      this.finishInactiveCancellation(store);
    }
    this.settleDrain();
    const status = store.snapshot().status;
    return {
      runId: store.runId,
      status,
      cancelled: status === "cancelling" || status === "cancelled",
    };
  }

  /** Synchronize current worker/run gauges after observability startup or replacement. */
  public syncObservability(): void {
    this.observability.setWorkerState(this.status().worker);
    const snapshot = this.resident?.snapshot();
    this.observability.setRunState(
      snapshot?.status ?? "none",
      snapshot?.epoch,
      snapshot?.invocations,
      this.resident?.pendingMessages().length,
    );
  }

  /** Resolve a durable run and revalidate workspace confinement before returning authority. */
  public findRun(runId: string): RunStore {
    const store =
      this.execution.storeFor(runId) ??
      listRuns(this.options.stateRoot).find((candidate) => candidate.runId === runId);
    if (store === undefined) {
      throw new RunNotFoundError("unknown run");
    }
    this.assertAssignedWorkspace(store);
    return store;
  }

  /** Fail unless live worker readiness and single-slot authority permit a new task. */
  public assertTaskAvailable(): void {
    if (this.lifecycle.read().readiness !== "accepting") {
      throw new WorkerConflictError("worker is draining and not accepting new work");
    }
    if (this.stopping) {
      throw new WorkerConflictError("worker is stopping");
    }
    if (!this.initialized) {
      throw new WorkerConflictError("worker is not ready");
    }
    if (this.resident !== undefined) {
      throw new WorkerConflictError("single worker slot is busy");
    }
  }

  /** Persist and launch one validated task after rechecking workspace and slot authority. */
  public createTask(
    manifest: Omit<Manifest, "runId" | "createdAt">,
    fixedRunId?: string,
  ): { runId: string; status: "active" } {
    return this.observability.spanSync("sept.task.create", {}, () => {
      this.assertTaskAvailable();
      assertWorkspaceConfined(manifest.workspace, this.options.workspaceRoot);
      const store = RunStore.create(this.options.stateRoot, manifest, fixedRunId);
      this.observability.event("sept.task.durable", {
        "sept.run.id": store.runId,
        "sept.run.state": "active",
      });
      this.observability.log("task.created", {
        "sept.run.id": store.runId,
        "sept.run.state": "active",
        "sept.outcome": "accepted",
      });
      this.launch(store);
      return { runId: store.runId, status: "active" };
    });
  }

  /** Adopt an already-durable webhook task into the slot without re-creating its evidence. */
  public adoptWebhookTask(store: RunStore): { kind: "task"; runId: string; status: "active" } {
    assertNativeRun(store);
    this.assertAssignedWorkspace(store);
    if (store.snapshot().status === "active" && !this.execution.isActive()) {
      this.launch(store);
    }
    return { kind: "task", runId: store.runId, status: "active" };
  }

  /** Recheck whether a message may be accepted, treating an existing ID as idempotent replay. */
  public assertMessageAvailable(store: RunStore, existing: boolean): void {
    assertNativeRun(store);
    this.messageAdmission(store, existing);
  }

  /** Durably enqueue exact operator text and wake/reopen the resident run when required. */
  public sendMessage(
    store: RunStore,
    text: string,
    fixedId?: string,
  ): ReturnType<RunStore["enqueueMessage"]> {
    assertNativeRun(store);
    return this.observability.spanSync(
      "sept.operator.enqueue",
      { "sept.run.id": store.runId },
      () => this.messages.send(store, text, fixedId),
    );
  }

  private launch(store: RunStore): void {
    this.resident = store;
    this.execution.launch(store);
  }

  private finishController(store: RunStore): void {
    if (store.snapshot().status === "cancelling") {
      store.finishCancellation();
    }
    const status = store.snapshot().status;
    if (status === "active" && !this.stopping) {
      this.launch(store);
      return;
    }
    if (status !== "waiting" && this.resident?.runId === store.runId) {
      this.resident = undefined;
    }
    this.syncObservability();
    this.settleDrain();
  }

  private finishInactiveCancellation(store: RunStore): void {
    const cancelled = store.finishCancellation();
    this.observability.runOutcome("cancelled");
    this.observability.setRunState(
      "cancelled",
      cancelled.epoch,
      cancelled.invocations,
      store.pendingMessages().length,
    );
    this.observability.log("run.cancelled", {
      "sept.run.id": store.runId,
      "sept.run.state": "cancelled",
      "sept.outcome": "cancelled",
    });
    if (this.resident?.runId === store.runId) {
      this.resident = undefined;
    }
    this.observability.setWorkerState("idle");
  }

  private assertAssignedWorkspace(store: RunStore): void {
    assertWorkspaceConfined(store.manifest().workspace, this.options.workspaceRoot);
  }

  private settleDrain(): void {
    if (this.lifecycle.read().readiness !== "draining") {
      return;
    }
    const status = this.resident?.snapshot().status;
    if (!this.execution.isActive() && status !== "active" && status !== "cancelling") {
      this.lifecycle.finishDrain();
    }
  }

  private messageAdmission(store: RunStore, existing: boolean): ReturnType<RunStore["snapshot"]> {
    return assertMessageAdmission(store, existing, {
      readiness: this.lifecycle.read().readiness,
      stopping: this.stopping,
      initialized: this.initialized,
      activeRunId: this.execution.activeRunId(),
    });
  }

  private releaseStateRoot(): void {
    const release = this.releaseRoot;
    this.releaseRoot = undefined;
    release?.();
  }
}
