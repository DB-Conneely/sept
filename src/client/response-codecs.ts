/** Reuses durable codecs, then validates HTTP envelope, requested identity and page invariants. */
import {
  validateConversationEvent,
  validateManifest,
  validateSnapshot,
  type RunStatus,
} from "../durable/index.js";
import type {
  CancelResult,
  ConversationPage,
  MessageAdmission,
  TaskAdmission,
  TaskProjection,
  TerminalStatus,
} from "./contracts.js";
import { TaskClientError } from "./errors.js";

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskClientError("protocol");
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TaskClientError("protocol");
  }
  // CAST: the non-null non-array object was checked before this property-based envelope decoder.
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TaskClientError("protocol");
  }
  return value;
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TaskClientError("protocol");
  }
  return value;
}

function duplicateReceipt(value: unknown, status: number): boolean {
  if (typeof value !== "boolean" || status !== (value ? 200 : 202)) {
    throw new TaskClientError("protocol");
  }
  return value;
}

/** Decode the original receipt, never substituting a later run status for active admission. */
export function taskAdmission(value: unknown, status: number): TaskAdmission {
  const input = record(value, ["kind", "runId", "status", "duplicate"]);
  if (input.kind !== "task" || input.status !== "active") {
    throw new TaskClientError("protocol");
  }
  return {
    kind: "task",
    runId: identifier(input.runId),
    status: "active",
    duplicate: duplicateReceipt(input.duplicate, status),
  };
}

/** Decode one replay-safe operator receipt bound to the requested run. */
export function messageAdmission(value: unknown, status: number, runId: string): MessageAdmission {
  const input = record(value, ["kind", "runId", "messageId", "duplicate"]);
  if (input.kind !== "operator_message" || input.runId !== runId) {
    throw new TaskClientError("protocol");
  }
  return {
    kind: "operator_message",
    runId,
    messageId: identifier(input.messageId),
    duplicate: duplicateReceipt(input.duplicate, status),
  };
}

/** Decode public path projections with the exact existing durable record validators. */
export function taskProjection(value: unknown, status: number, runId: string): TaskProjection {
  if (status !== 200) {
    throw new TaskClientError("protocol");
  }
  try {
    const input = record(value, ["manifest", "state"]);
    return {
      manifest: validateManifest(input.manifest, runId),
      state: validateSnapshot(input.state),
    };
  } catch {
    // Durable diagnostics describe hostile response fields; retain only the client classification.
    throw new TaskClientError("protocol");
  }
}

function terminalStatus(value: unknown): TerminalStatus {
  if (value === "cancelled" || value === "complete" || value === "blocked" || value === "failed") {
    return value;
  }
  throw new TaskClientError("protocol");
}

function currentTerminal(value: unknown): { status: TerminalStatus } | null {
  return value === null ? null : { status: terminalStatus(record(value, ["status"]).status) };
}

/** Validate strict cursor order and page bounds without equating old terminal events to current state. */
export function conversationPage(
  value: unknown,
  status: number,
  after: number,
  limit: number,
): ConversationPage {
  if (status !== 200) {
    throw new TaskClientError("protocol");
  }
  try {
    const input = record(value, ["events", "nextCursor", "retainedFrom", "terminal"]);
    const retainedFrom = integer(input.retainedFrom, 1);
    if (!Array.isArray(input.events) || input.events.length > limit || after < retainedFrom - 1) {
      throw new TaskClientError("protocol");
    }
    const events = input.events.map(validateConversationEvent);
    let previous = after;
    for (const event of events) {
      if (event.cursor <= previous || event.cursor < retainedFrom) {
        throw new TaskClientError("protocol");
      }
      previous = event.cursor;
    }
    const nextCursor = integer(input.nextCursor, 0);
    if (nextCursor !== previous) {
      throw new TaskClientError("protocol");
    }
    return { events, nextCursor, retainedFrom, terminal: currentTerminal(input.terminal) };
  } catch {
    throw new TaskClientError("protocol");
  }
}

function runStatus(value: unknown): RunStatus {
  if (value === "active" || value === "waiting" || value === "cancelling") {
    return value;
  }
  return terminalStatus(value);
}

/** Decode targeted cancellation; accepted cancellation remains distinct from final settlement. */
export function cancelResult(value: unknown, status: number, runId: string): CancelResult {
  const input = record(value, ["runId", "status", "cancelled"]);
  const current = runStatus(input.status);
  const cancelled = input.cancelled;
  if (
    input.runId !== runId ||
    typeof cancelled !== "boolean" ||
    status !== (current === "cancelling" ? 202 : 200)
  ) {
    throw new TaskClientError("protocol");
  }
  if (cancelled !== (current === "cancelling" || current === "cancelled")) {
    throw new TaskClientError("protocol");
  }
  return { runId, status: current, cancelled };
}
