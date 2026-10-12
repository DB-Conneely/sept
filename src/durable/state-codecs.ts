/**
 * Validates immutable manifests and authoritative lifecycle snapshots read from disk. RunStore owns
 * writes and runtime owns transition intent; these codecs reject unknown fields, invalid phase/status
 * combinations, unsafe paths, and incomplete handover or cancellation authority.
 */

import { isAbsolute } from "node:path";
import type { Manifest, RunPhase, RunSnapshot, RunStatus, TerminalCause } from "./contracts.js";
import { SeptError } from "./errors.js";
import {
  boundedInteger,
  boundedString,
  enumValue,
  exactKeys,
  isoDate,
  unknownRecord,
} from "./validation-primitives.js";

const MANIFEST_KEYS = [
  "createdAt",
  "formatVersion",
  "maxEpochs",
  "maxInvocations",
  "model",
  "piVersion",
  "provider",
  "role",
  "runId",
  "task",
  "thinking",
  "timeoutSeconds",
  "workspace",
] as const;
const LEGACY_MANIFEST_KEYS = ["handoverReserveTokens", "thresholdPercent"] as const;
const RUN_STATUSES: readonly RunStatus[] = [
  "active",
  "waiting",
  "cancelling",
  "cancelled",
  "complete",
  "blocked",
  "failed",
];
const RUN_PHASES: readonly RunPhase[] = [
  "ready",
  "running",
  "waiting",
  "handover_durable",
  "replacing",
  "cancelling",
  "terminal",
];
const TERMINAL_CAUSES: readonly TerminalCause[] = [
  "agent_blocked",
  "invocation_limit",
  "epoch_limit",
  "timeout",
  "controller_failure",
  "operator_cancelled",
];
const PHASES_BY_STATUS: Readonly<Record<RunStatus, readonly RunPhase[]>> = {
  active: ["ready", "running", "handover_durable", "replacing"],
  waiting: ["waiting"],
  cancelling: ["cancelling"],
  cancelled: ["terminal"],
  complete: ["terminal"],
  blocked: ["terminal"],
  failed: ["terminal"],
};

function validateManifestVersion(input: Record<string, unknown>): void {
  if (input.formatVersion === 2) {
    exactKeys(input, [...MANIFEST_KEYS, ...LEGACY_MANIFEST_KEYS], [], "manifest");
    boundedInteger(input.thresholdPercent, 1, 95, "legacy manifest thresholdPercent");
    boundedInteger(
      input.handoverReserveTokens,
      1000,
      1_000_000,
      "legacy manifest handoverReserveTokens",
    );
    return;
  }
  exactKeys(input, MANIFEST_KEYS, [], "manifest");
  if (input.formatVersion !== 3) {
    throw new SeptError("Invalid durable manifest formatVersion");
  }
}

function validateRunId(value: unknown, expectedRunId: string | undefined): string {
  const runId = boundedString(value, 1, 128, "manifest runId");
  const validSyntax = /^[A-Za-z0-9_-]+$/.test(runId);
  const matchesDirectory = expectedRunId === undefined || runId === expectedRunId;
  if (!validSyntax || !matchesDirectory) {
    throw new SeptError("Invalid durable manifest runId");
  }
  return runId;
}

function trimmedIdentifier(value: unknown, name: string, maximum: number): string {
  const result = boundedString(value, 1, maximum, name);
  if (result !== result.trim()) {
    throw new SeptError(`Invalid durable ${name}`);
  }
  return result;
}

/** Validate and migrate an immutable format-2 or format-3 run manifest. */
function validateManifest(value: unknown, expectedRunId?: string): Manifest {
  const input = unknownRecord(value, "manifest");
  validateManifestVersion(input);
  const workspace = boundedString(input.workspace, 1, 4096, "manifest workspace");
  const task = boundedString(input.task, 1, 32_768, "manifest task");
  if (!isAbsolute(workspace) || workspace !== workspace.trim() || !task.trim()) {
    throw new SeptError("Invalid durable manifest string value");
  }
  return {
    formatVersion: 3,
    runId: validateRunId(input.runId, expectedRunId),
    createdAt: isoDate(input.createdAt, "manifest createdAt"),
    task,
    role: boundedString(input.role, 0, 4096, "manifest role"),
    workspace,
    provider: trimmedIdentifier(input.provider, "manifest provider", 4096),
    model: trimmedIdentifier(input.model, "manifest model", 4096),
    thinking: enumValue(
      input.thinking,
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "manifest thinking",
    ),
    maxInvocations: boundedInteger(input.maxInvocations, 1, 10_000, "manifest maxInvocations"),
    maxEpochs: boundedInteger(input.maxEpochs, 1, 1000, "manifest maxEpochs"),
    timeoutSeconds: boundedInteger(input.timeoutSeconds, 1, 604_800, "manifest timeoutSeconds"),
    piVersion: trimmedIdentifier(input.piVersion, "manifest piVersion", 128),
  };
}

function addOptionalSnapshotFields(input: Record<string, unknown>, snapshot: RunSnapshot): void {
  if (input.activeSessionFile !== undefined) {
    snapshot.activeSessionFile = boundedString(
      input.activeSessionFile,
      1,
      4096,
      "snapshot activeSessionFile",
    );
  }
  if (input.activeSessionId !== undefined) {
    snapshot.activeSessionId = boundedString(
      input.activeSessionId,
      1,
      4096,
      "snapshot activeSessionId",
    );
  }
  if (input.predecessorSessionFile !== undefined) {
    snapshot.predecessorSessionFile = boundedString(
      input.predecessorSessionFile,
      1,
      4096,
      "snapshot predecessorSessionFile",
    );
  }
  if (input.predecessorSessionId !== undefined) {
    snapshot.predecessorSessionId = boundedString(
      input.predecessorSessionId,
      1,
      4096,
      "snapshot predecessorSessionId",
    );
  }
  if (input.reason !== undefined) {
    snapshot.reason = boundedString(input.reason, 1, 65_536, "snapshot reason");
  }
}

function terminalCauseAllowed(status: RunStatus, cause: TerminalCause): boolean {
  if (status === "failed") {
    return cause === "controller_failure";
  }
  if (status === "cancelling" || status === "cancelled") {
    return cause === "operator_cancelled";
  }
  if (status === "blocked") {
    return cause !== "controller_failure" && cause !== "operator_cancelled";
  }
  return false;
}

function validateSnapshotAuthority(snapshot: RunSnapshot): void {
  if (!PHASES_BY_STATUS[snapshot.status].includes(snapshot.phase)) {
    throw new SeptError("Invalid durable snapshot status/phase combination");
  }
  const replacing = snapshot.phase === "handover_durable" || snapshot.phase === "replacing";
  if (replacing && snapshot.predecessorSessionId === undefined) {
    throw new SeptError("Invalid durable snapshot handover state");
  }
  if (replacing && snapshot.handoverEpoch !== snapshot.epoch) {
    throw new SeptError("Invalid durable snapshot handover state");
  }
  if (
    snapshot.terminalCause !== undefined &&
    !terminalCauseAllowed(snapshot.status, snapshot.terminalCause)
  ) {
    throw new SeptError("Invalid durable snapshot terminal cause state");
  }
}

function snapshotBase(input: Record<string, unknown>): RunSnapshot {
  return {
    status: enumValue(input.status, RUN_STATUSES, "snapshot status"),
    phase: enumValue(input.phase, RUN_PHASES, "snapshot phase"),
    epoch: boundedInteger(input.epoch, 1, 1000, "snapshot epoch"),
    invocations: boundedInteger(input.invocations, 0, 10_000, "snapshot invocations"),
    activeMilliseconds: boundedInteger(
      input.activeMilliseconds,
      0,
      Number.MAX_SAFE_INTEGER,
      "snapshot activeMilliseconds",
    ),
    startedAt: isoDate(input.startedAt, "snapshot startedAt"),
    updatedAt: isoDate(input.updatedAt, "snapshot updatedAt"),
  };
}

/** Validate a complete lifecycle snapshot before read or atomic replacement. */
function validateSnapshot(value: unknown): RunSnapshot {
  const input = unknownRecord(value, "snapshot");
  exactKeys(
    input,
    ["activeMilliseconds", "epoch", "invocations", "phase", "startedAt", "status", "updatedAt"],
    [
      "activeSessionFile",
      "activeStartedAt",
      "activeSessionId",
      "handoverEpoch",
      "predecessorSessionFile",
      "predecessorSessionId",
      "reason",
      "terminalCause",
    ],
    "snapshot",
  );
  const snapshot = snapshotBase(input);
  if (input.activeStartedAt !== undefined) {
    snapshot.activeStartedAt = boundedInteger(
      input.activeStartedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      "snapshot activeStartedAt",
    );
  }
  addOptionalSnapshotFields(input, snapshot);
  if (input.handoverEpoch !== undefined) {
    snapshot.handoverEpoch = boundedInteger(input.handoverEpoch, 1, 1000, "snapshot handoverEpoch");
  }
  if (input.terminalCause !== undefined) {
    snapshot.terminalCause = enumValue(
      input.terminalCause,
      TERMINAL_CAUSES,
      "snapshot terminalCause",
    );
  }
  validateSnapshotAuthority(snapshot);
  return snapshot;
}

export { validateManifest, validateSnapshot };
