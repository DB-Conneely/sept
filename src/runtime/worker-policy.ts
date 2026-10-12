/**
 * Owns pure worker admission and workspace-confinement checks. WorkerRuntime supplies current
 * process authority and durable stores; this module performs no mutation, ensuring every external
 * admission is rechecked immediately against live readiness, slot ownership, and configured limits.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
  SeptError,
  type RunSnapshot,
  type RunStore,
  type WorkerReadiness,
} from "../durable/index.js";
import { WorkerConflictError } from "./errors.js";

interface MessageAuthority {
  readiness: WorkerReadiness;
  stopping: boolean;
  initialized: boolean;
  activeRunId: string | undefined;
  residentRunId: string | undefined;
}

function terminallyClosed(snapshot: RunSnapshot): boolean {
  return (
    snapshot.status === "complete" ||
    snapshot.status === "failed" ||
    snapshot.status === "cancelling" ||
    snapshot.status === "cancelled"
  );
}

function configuredLimitExhausted(store: RunStore, snapshot: RunSnapshot): boolean {
  const manifest = store.manifest();
  const countExhausted = snapshot.invocations >= manifest.maxInvocations;
  const timeExhausted = snapshot.activeMilliseconds >= manifest.timeoutSeconds * 1000;
  const handoverExhausted =
    snapshot.status === "blocked" &&
    snapshot.handoverEpoch === snapshot.epoch &&
    snapshot.epoch >= manifest.maxEpochs;
  return countExhausted || timeExhausted || handoverExhausted;
}

function blockedByTerminalCause(snapshot: RunSnapshot): boolean {
  return (
    snapshot.status === "blocked" &&
    (snapshot.terminalCause === "invocation_limit" ||
      snapshot.terminalCause === "epoch_limit" ||
      snapshot.terminalCause === "timeout")
  );
}

/** Validate an assigned workspace against the configured canonical workspace root. */
export function assertWorkspaceConfined(
  workspace: string,
  workspaceRoot: string | undefined,
): void {
  if (workspaceRoot === undefined) {
    return;
  }
  let canonical: string;
  try {
    canonical = realpathSync(workspace);
    if (!statSync(canonical).isDirectory()) {
      throw new SeptError("workspace is not a directory");
    }
  } catch (error: unknown) {
    throw new SeptError("durable run workspace is unavailable or is not a directory", {
      cause: error,
    });
  }
  const child = relative(workspaceRoot, canonical);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new SeptError("durable run workspace is outside the configured workspace root");
  }
}

function assertWorkerAuthority(authority: MessageAuthority): void {
  if (authority.readiness !== "accepting") {
    throw new WorkerConflictError("worker is draining and not accepting new work");
  }
  if (authority.stopping) {
    throw new WorkerConflictError("worker is stopping");
  }
  if (!authority.initialized) {
    throw new WorkerConflictError("worker is not ready");
  }
}

function assertRunCapacity(store: RunStore, snapshot: RunSnapshot): void {
  if (terminallyClosed(snapshot)) {
    throw new WorkerConflictError(`run is ${snapshot.status}`);
  }
  if (blockedByTerminalCause(snapshot) || configuredLimitExhausted(store, snapshot)) {
    throw new WorkerConflictError("run exhausted its configured limits");
  }
  const cannotGuaranteeDelivery =
    snapshot.status === "active" &&
    snapshot.phase === "running" &&
    snapshot.epoch >= store.manifest().maxEpochs;
  if (cannotGuaranteeDelivery) {
    throw new WorkerConflictError(
      "run cannot guarantee another delivery at its configured epoch limit",
    );
  }
}

/** Recheck live slot authority before accepting or repairing input; consumed duplicates are inert. */
export function assertMessageAdmission(
  store: RunStore,
  existing: boolean,
  authority: MessageAuthority,
): RunSnapshot {
  const snapshot = store.snapshot();
  if (existing) {
    return snapshot;
  }
  assertWorkerAuthority(authority);
  // A blocked controller retains authority through settlement, even for its own run. Waiting runs
  // may wake only when the resident slot is empty or already belongs to that same run.
  const blockedDuringSettlement =
    snapshot.status === "blocked" && authority.activeRunId !== undefined;
  const residentBehindAnotherRun =
    authority.residentRunId !== undefined && authority.residentRunId !== store.runId;
  const activeBehindAnotherRun =
    authority.activeRunId !== undefined && authority.activeRunId !== store.runId;
  if (blockedDuringSettlement || residentBehindAnotherRun || activeBehindAnotherRun) {
    throw new WorkerConflictError("single worker slot is busy; retry the message when idle");
  }
  assertRunCapacity(store, snapshot);
  return snapshot;
}
