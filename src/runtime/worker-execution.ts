/**
 * Owns the currently running CycleController and its bounded lease-adoption retry loop. WorkerRuntime
 * retains resident-slot and admission authority; this collaborator exposes only active identity,
 * cancellation, shutdown waiting, and exactly-once settlement notification.
 */

import { SeptError, type RunStore } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError } from "../observability/index.js";
import { CycleController, type HostFactory } from "./controller.js";

interface ActiveExecution {
  store: RunStore;
  controller: CycleController;
  promise: Promise<boolean>;
}

/** Manages at most one active controller without owning resident-run admission decisions. */
export class WorkerExecutionSlot {
  private active: ActiveExecution | undefined;

  public constructor(
    private readonly agentDir: string,
    private readonly hostFactory: HostFactory | undefined,
    private readonly observability: Observability,
    private readonly stopping: () => boolean,
    private readonly settled: (store: RunStore, outcome: "success" | "failure") => void,
  ) {}

  /** Return whether any controller currently owns the execution slot. */
  public isActive(): boolean {
    return this.active !== undefined;
  }

  /** Return the active durable run identity, when occupied. */
  public activeRunId(): string | undefined {
    return this.active?.store.runId;
  }

  /** Return the active store only when it matches the requested durable run identity. */
  public storeFor(runId: string): RunStore | undefined {
    return this.active?.store.runId === runId ? this.active.store : undefined;
  }

  /** Await active controller settlement during graceful worker shutdown. */
  public async wait(): Promise<void> {
    await this.active?.promise;
  }

  /** Forward abort to the matching controller after caller has persisted cancellation intent. */
  public async abort(runId: string): Promise<boolean> {
    if (this.active?.store.runId !== runId) {
      return false;
    }
    await this.active.controller.abort();
    return true;
  }

  /** Launch one controller or idempotently retain the same already-active run. */
  public launch(store: RunStore): void {
    if (this.active !== undefined) {
      if (this.active.store.runId === store.runId) {
        return;
      }
      throw new WorkerExecutionConflictError("single worker slot already has a controller");
    }
    this.recordLaunch(store);
    const controller = new CycleController(
      store,
      this.agentDir,
      this.hostFactory,
      this.observability,
      this.stopping,
    );
    const execution: ActiveExecution = { store, controller, promise: Promise.resolve(true) };
    execution.promise = this.control(store, controller).then((succeeded) => {
      if (this.active !== execution) {
        return succeeded;
      }
      this.active = undefined;
      this.settled(store, succeeded ? "success" : "failure");
      return succeeded;
    });
    this.active = execution;
  }

  private recordLaunch(store: RunStore): void {
    this.observability.setWorkerState("busy");
    const snapshot = store.snapshot();
    this.observability.setRunState(
      snapshot.status,
      snapshot.epoch,
      snapshot.invocations,
      store.pendingMessages().length,
    );
    this.observability.log("controller.launched", {
      "sept.run.id": store.runId,
      "sept.run.state": snapshot.status,
      "sept.epoch": snapshot.epoch,
      "sept.invocation": snapshot.invocations,
    });
  }

  private async control(store: RunStore, controller: CycleController): Promise<boolean> {
    while (store.snapshot().status === "active") {
      try {
        await controller.run();
        return true;
      } catch (error: unknown) {
        if (!this.retryableLeaseExit(store, error) || this.stopping()) {
          return false;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
      }
    }
    return true;
  }

  private retryableLeaseExit(store: RunStore, error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    store.log({ type: "controller_exit", error: message });
    this.observability.log(
      "controller.exit",
      {
        "sept.run.id": store.runId,
        "sept.outcome": "failure",
        "error.type": classifyError(error),
      },
      "warn",
    );
    return (
      store.snapshot().status === "active" && /controller lease|controlled by pid/.test(message)
    );
  }
}

class WorkerExecutionConflictError extends SeptError {}
