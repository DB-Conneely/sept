/**
 * Reconciles durable runs after the worker acquires exclusive state-root authority. It repairs
 * cancellation/conversation evidence, selects at most one resident slot, and converts queued input
 * on a waiting run into a durable wake before any controller is launched.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CapabilityRequestStore,
  CapabilityRequestWaitingError,
  listRuns,
  SeptError,
  type RunStore,
} from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import {
  assertCompatibleStateRoot,
  isLegacyRun,
  checkpointPermissionWait,
  readInvocationAdmission,
} from "../pi-integration/index.js";
import { assertHandsRunProfile, revokeRecordedHandsBinding } from "../execution/index.js";
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
    // A crash cannot prove that a supplied namespace joined. Preserve uncertainty rather
    // than publishing cancellation from only the old intent; no native work is resumed.
    if (existsSync(join(store.runDir, "hands-binding.json"))) {
      store.blockUnverifiedCleanup();
    } else {
      store.finishCancellation();
    }
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
  canSchedule = true,
): WorkerRecoveryResult {
  assertCompatibleStateRoot(stateRoot, telemetry);
  const stores = listRuns(stateRoot);
  for (const store of stores) {
    if (!isLegacyRun(store)) {
      reconcileStore(store);
    }
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
  if (shouldWake(resident, canSchedule)) {
    wakeWaitingRun(resident, telemetry);
    return { resident, adoption: "wake_recovered" };
  }
  return { resident, adoption: status === "active" ? "active" : "waiting" };
}

function permissionWaiting(store: RunStore): boolean {
  return store.snapshot().permissionRequestId !== undefined;
}
/** Crash recovery closes the captured effect namespace before acknowledgement/waiting, never schedules a retry. */
export async function reconcilePermissionWait(store: RunStore): Promise<void> {
  assertHandsRunProfile(store);
  const snapshot = store.snapshot();
  const admission = readInvocationAdmission(store);
  if (
    snapshot.permissionRequestId === undefined &&
    (admission?.checkpointed !== false ||
      admission.requestId !== `sept-invocation-${String(snapshot.invocations)}`)
  ) {
    return;
  }
  const pending = new CapabilityRequestStore(dirname(store.runDir))
    .read()
    .find((entry) => entry.runId === store.runId && entry.invocation === snapshot.invocations);
  if (pending === undefined) {
    return;
  }
  await revokeRecordedHandsBinding(store, pending.binding);
  if (store.snapshot().status !== "active") {
    return;
  }
  updateRuntimeSnapshot(store, { permissionRequestId: pending.id });
  checkpointPermissionWait(store);
  throw new CapabilityRequestWaitingError(pending.id);
}

function shouldWake(store: RunStore, canSchedule: boolean): boolean {
  return (
    canSchedule &&
    store.snapshot().status === "waiting" &&
    store.pendingMessages().length > 0 &&
    !permissionWaiting(store)
  );
}
