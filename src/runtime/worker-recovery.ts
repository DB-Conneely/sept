/**
 * Reconciles durable runs after the worker acquires exclusive state-root authority. It repairs
 * cancellation/conversation evidence, selects at most one resident slot, and converts queued input
 * on a waiting run into a durable wake before any controller is launched.
 */

import { listRuns, SeptError, type RunStore } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { updateRuntimeSnapshot } from "./runtime-state.js";
import type { WorkerAdoption } from "./contracts.js";

/** Resident run and restart classification produced under the caller's state-root lease. */
export interface WorkerRecoveryResult {
  resident: RunStore | undefined;
  adoption: WorkerAdoption;
}

function reconcileStore(store: RunStore): void {
  store.ensureInitialConversation();
  store.reconcileOperatorConversation();
  if (store.snapshot().status === "cancelling") {
    store.finishCancellation();
  }
  store.ensureTerminalConversation();
}

function wakeWaitingRun(store: RunStore, telemetry: Observability): void {
  const messageIds = store.pendingMessages().map((message) => message.id);
  updateRuntimeSnapshot(store, {
    status: "active",
    phase: "ready",
    reason: undefined,
    terminalCause: undefined,
  });
  store.event("run_wake_recovered", { messageIds });
  store.conversationState(`wake-recovered-${String(store.snapshot().invocations)}`, "active");
  telemetry.log("run.wake_recovered", {
    "sept.run.id": store.runId,
    "sept.queue.depth": messageIds.length,
    "sept.outcome": "active",
  });
}

/** Reconcile all durable runs and return the sole resumable resident, failing closed on ambiguity. */
export function recoverWorkerResident(
  stateRoot: string,
  telemetry: Observability,
  assertWorkspace: (store: RunStore) => void,
): WorkerRecoveryResult {
  const stores = listRuns(stateRoot);
  for (const store of stores) {
    reconcileStore(store);
  }
  const residents = stores.filter((store) => {
    const status = store.snapshot().status;
    if (status !== "active" && status !== "waiting") {
      return false;
    }
    assertWorkspace(store);
    return true;
  });
  if (residents.length > 1) {
    throw new SeptError(
      `Single-slot worker found ${String(residents.length)} resumable runs; operator resolution is required`,
    );
  }
  const resident = residents[0];
  if (resident === undefined) {
    return { resident: undefined, adoption: "none" };
  }
  const status = resident.snapshot().status;
  if (status === "waiting" && resident.pendingMessages().length > 0) {
    wakeWaitingRun(resident, telemetry);
    return { resident, adoption: "wake_recovered" };
  }
  return { resident, adoption: status === "active" ? "active" : "waiting" };
}
