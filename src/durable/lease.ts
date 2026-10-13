/**
 * Owns exclusive run and state-root lease files for process-local single-slot authority. Callers own
 * lifecycle work; this module validates owner evidence, refuses ambiguous takeover, refreshes only
 * its own lease, and makes release idempotent so cleanup cannot revoke another owner.
 */

import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NOOP_TELEMETRY } from "../observability/index.js";
import { SeptError } from "./errors.js";
import { ensureDirectory, errorCode, now, syncDirectory } from "./filesystem.js";
import { loadNativeSqliteReader } from "./sqlite-builtin.js";
import {
  boundedInteger,
  boundedString,
  exactKeys,
  unknownRecord,
} from "./validation-primitives.js";

interface LeaseOwner {
  ownerId: string;
  pid: number;
  hostname: string;
  processStartedAt: number;
  heartbeatAt: string;
}

type LeaseScope = { kind: "state-root" } | { kind: "run"; runId: string };

const PROCESS_IDENTITY = Object.freeze({
  pid: process.pid,
  hostname: hostname(),
  processStartedAt: Date.now() - Math.floor(process.uptime() * 1000),
});
const STALE_LEASE_MILLISECONDS = 5_000;
const HEARTBEAT_MILLISECONDS = 1_000;

function openLeaseMutex(path: string): import("node:sqlite").DatabaseSync {
  const lockPath = `${path}.lock`;
  try {
    const descriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
  // Closing any extra descriptor for an existing inode can drop this process's SQLite locks.
  const file = lstatSync(lockPath);
  if (
    !file.isFile() ||
    file.nlink !== 1 ||
    (file.mode & 0o077) !== 0 ||
    file.size !== 0 ||
    file.uid !== process.getuid?.()
  ) {
    throw new SeptError("Lease acquisition lock must be a private owned regular file");
  }
  const { DatabaseSync } = loadNativeSqliteReader(NOOP_TELEMETRY);
  return new DatabaseSync(lockPath);
}

function lockLeaseAcquisition(path: string, scope: LeaseScope): import("node:sqlite").DatabaseSync {
  let mutex: import("node:sqlite").DatabaseSync;
  try {
    mutex = openLeaseMutex(path);
  } catch (error: unknown) {
    throw new SeptError("Lease acquisition lock is unreadable or invalid", { cause: error });
  }
  try {
    // Kernel locks serialize observation/reclaim/claim and disappear on close or process death.
    // Keep this empty mutex inode permanently: replacing it would split competing owners' locks.
    mutex.exec("BEGIN EXCLUSIVE");
    return mutex;
  } catch (error: unknown) {
    mutex.close();
    throw new SeptError(scopeMessage(scope, "recent"), { cause: error });
  }
}

function newOwner(): LeaseOwner {
  return { ownerId: randomUUID(), ...PROCESS_IDENTITY, heartbeatAt: now() };
}

function validateLeaseOwner(value: unknown): LeaseOwner {
  const input = unknownRecord(value, "lease owner");
  exactKeys(
    input,
    ["heartbeatAt", "hostname", "ownerId", "pid", "processStartedAt"],
    [],
    "lease owner",
  );
  return {
    ownerId: boundedString(input.ownerId, 1, 128, "lease ownerId"),
    pid: boundedInteger(input.pid, 1, Number.MAX_SAFE_INTEGER, "lease pid"),
    hostname: boundedString(input.hostname, 1, 256, "lease hostname"),
    processStartedAt: boundedInteger(
      input.processStartedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      "lease processStartedAt",
    ),
    heartbeatAt: boundedString(input.heartbeatAt, 1, 128, "lease heartbeatAt"),
  };
}

function readOwner(path: string): LeaseOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validateLeaseOwner(parsed);
  } catch {
    return undefined;
  }
}

function sameProcess(owner: LeaseOwner | undefined): boolean {
  return (
    owner?.hostname === PROCESS_IDENTITY.hostname &&
    owner.processStartedAt === PROCESS_IDENTITY.processStartedAt
  );
}

function scopeMessage(
  scope: LeaseScope,
  reason: "same-process" | "recent" | "unverifiable",
): string {
  if (scope.kind === "state-root") {
    const messages = {
      "same-process": "Worker state root is already owned by this process",
      recent: "Worker state root has a recent ownership lease; retry shortly",
      unverifiable: "Cannot verify the worker state-root owner; refusing lease takeover",
    };
    return messages[reason];
  }
  const messages = {
    "same-process": `Run ${scope.runId} is already controlled by this process`,
    recent: `Run ${scope.runId} has a recent controller lease; retry adoption shortly`,
    unverifiable: `Cannot verify the owner of run ${scope.runId}; refusing lease takeover`,
  };
  return messages[reason];
}

function assertOtherProcessIsDead(owner: LeaseOwner | undefined, scope: LeaseScope): void {
  const isOtherLocalProcess =
    owner?.hostname === PROCESS_IDENTITY.hostname && owner.pid !== PROCESS_IDENTITY.pid;
  if (!isOtherLocalProcess) {
    // Heartbeat age cannot prove death across hosts, containers, or an ambiguous PID identity.
    throw new SeptError(scopeMessage(scope, "unverifiable"));
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error: unknown) {
    if (errorCode(error) === "ESRCH") {
      return;
    }
    throw new SeptError(scopeMessage(scope, "unverifiable"), { cause: error });
  }
  const noun = scope.kind === "run" ? `Run ${scope.runId}` : "Worker state root";
  throw new SeptError(`${noun} is already owned by pid ${String(owner.pid)}`);
}

function removeStaleLease(path: string, scope: LeaseScope): void {
  const owner = readOwner(path);
  if (sameProcess(owner)) {
    throw new SeptError(scopeMessage(scope, "same-process"));
  }
  assertOtherProcessIsDead(owner, scope);
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  if (age < STALE_LEASE_MILLISECONDS) {
    throw new SeptError(scopeMessage(scope, "recent"));
  }
  try {
    unlinkSync(path);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function tryClaim(path: string, owner: LeaseOwner): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
    fsyncSync(descriptor);
    return true;
  } finally {
    closeSync(descriptor);
  }
}

function refreshOwnedLease(path: string, owner: LeaseOwner): void {
  const current = readOwner(path);
  if (current?.ownerId === owner.ownerId) {
    writeFileSync(path, `${JSON.stringify({ ...owner, heartbeatAt: now() })}\n`, {
      mode: 0o600,
    });
  }
}

function removeOwnedLease(path: string, directory: string, owner: LeaseOwner): void {
  if (readOwner(path)?.ownerId === owner.ownerId) {
    unlinkSync(path);
    syncDirectory(directory);
  }
}

function leaseRelease(path: string, directory: string, owner: LeaseOwner): () => void {
  const heartbeat = setInterval(() => {
    try {
      refreshOwnedLease(path, owner);
    } catch {
      // A failed heartbeat cannot grant authority; the lease file remains fail-closed.
    }
  }, HEARTBEAT_MILLISECONDS);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    try {
      removeOwnedLease(path, directory, owner);
    } catch {
      // Cleanup is idempotent and must not mask controller settlement.
    }
  };
}

function claimUnderMutex(path: string, owner: LeaseOwner, scope: LeaseScope): void {
  if (tryClaim(path, owner)) {
    return;
  }
  removeStaleLease(path, scope);
  if (!tryClaim(path, owner)) {
    throw new SeptError(scopeMessage(scope, "recent"));
  }
}

function acquireLease(path: string, directory: string, scope: LeaseScope): () => void {
  ensureDirectory(directory);
  const owner = newOwner();
  const mutex = lockLeaseAcquisition(path, scope);
  try {
    try {
      claimUnderMutex(path, owner, scope);
      syncDirectory(directory);
    } finally {
      mutex.close();
    }
  } catch (error: unknown) {
    // No authority or heartbeat escapes a failed acquisition, including a failed mutex close.
    try {
      removeOwnedLease(path, directory, owner);
    } catch (cleanup: unknown) {
      throw new SeptError("Lease acquisition failed; ownership cleanup is unverified", {
        cause: new AggregateError([error, cleanup]),
      });
    }
    throw error;
  }
  return leaseRelease(path, directory, owner);
}

/** Acquire exclusive controller authority for one run directory. */
function acquireRunLease(runDirectory: string, runId: string): () => void {
  return acquireLease(join(runDirectory, "controller.lease"), runDirectory, {
    kind: "run",
    runId,
  });
}

/** Acquire the process-wide single-slot authority for one durable state root. */
export function acquireStateRootLease(root: string): () => void {
  return acquireLease(join(root, "worker.lease"), root, { kind: "state-root" });
}

export { acquireRunLease };
