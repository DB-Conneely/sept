import type {
  ConversationEvent,
  OperatorMessage,
  RunEvent,
  WorkerLifecycleState,
  WorkerReadiness,
} from "./contracts.js";
import { SeptError } from "./errors.js";
import { MAX_CONVERSATION_TEXT_CHARS } from "./limits.js";
import {
  boundedInteger,
  boundedString,
  enumValue,
  exactKeys,
  isoDate,
  unknownRecord,
} from "./validation-primitives.js";

interface ConversationCommon {
  formatVersion: 1;
  cursor: number;
  id: string;
  at: string;
}

function conversationCommon(input: Record<string, unknown>): ConversationCommon {
  if (input.formatVersion !== 1) {
    throw new SeptError("Invalid durable conversation formatVersion");
  }
  const id = boundedString(input.id, 1, 256, "conversation id");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new SeptError("Invalid durable conversation id");
  }
  return {
    formatVersion: 1,
    cursor: boundedInteger(input.cursor, 1, Number.MAX_SAFE_INTEGER, "conversation cursor"),
    id,
    at: isoDate(input.at, "conversation at"),
  };
}

function conversationMessage(
  input: Record<string, unknown>,
  common: ConversationCommon,
): ConversationEvent {
  exactKeys(
    input,
    ["at", "cursor", "formatVersion", "id", "role", "text", "type"],
    [],
    "conversation message",
  );
  return {
    ...common,
    type: "message",
    role: enumValue(input.role, ["user", "assistant"], "conversation role"),
    text: boundedString(input.text, 1, MAX_CONVERSATION_TEXT_CHARS, "conversation text"),
  };
}

function conversationState(
  input: Record<string, unknown>,
  common: ConversationCommon,
): ConversationEvent {
  exactKeys(
    input,
    ["at", "cursor", "formatVersion", "id", "state", "type"],
    [],
    "conversation state",
  );
  return {
    ...common,
    type: "state",
    state: enumValue(input.state, ["active", "waiting"], "conversation state"),
  };
}

function conversationTerminal(
  input: Record<string, unknown>,
  common: ConversationCommon,
): ConversationEvent {
  exactKeys(
    input,
    ["at", "cursor", "formatVersion", "id", "status", "type"],
    [],
    "conversation terminal",
  );
  return {
    ...common,
    type: "terminal",
    status: enumValue(
      input.status,
      ["cancelled", "complete", "blocked", "failed"],
      "conversation terminal status",
    ),
  };
}

/** Validate one client-facing conversation record from durable JSONL. */
function validateConversationEvent(value: unknown): ConversationEvent {
  const input = unknownRecord(value, "conversation event");
  const common = conversationCommon(input);
  if (input.type === "message") {
    return conversationMessage(input, common);
  }
  if (input.type === "state") {
    return conversationState(input, common);
  }
  if (input.type === "terminal") {
    return conversationTerminal(input, common);
  }
  throw new SeptError("Invalid durable conversation event type");
}

/** Validate exact accepted operator input recovered from durable evidence. */
function validateOperatorMessage(value: unknown): OperatorMessage {
  const input = unknownRecord(value, "operator message");
  exactKeys(input, ["createdAt", "id", "text"], [], "operator message");
  const id = boundedString(input.id, 1, 128, "operator message id");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new SeptError("Invalid durable operator message id");
  }
  return {
    id,
    createdAt: isoDate(input.createdAt, "operator message createdAt"),
    text: boundedString(input.text, 1, 32_768, "operator message text"),
  };
}

/** Validate the authority fields common to every extensible run event. */
function validateRunEvent(value: unknown): RunEvent {
  const input = unknownRecord(value, "run event");
  return {
    ...input,
    seq: boundedInteger(input.seq, 1, Number.MAX_SAFE_INTEGER, "run event seq"),
    type: boundedString(input.type, 1, 128, "run event type"),
    at: isoDate(input.at, "run event at"),
  };
}

function validateReadinessDates(state: WorkerLifecycleState): void {
  if (state.readiness === "accepting") {
    if (state.drainAcceptedAt !== undefined || state.drainedAt !== undefined) {
      throw new SeptError("Invalid accepting worker lifecycle state");
    }
    return;
  }
  if (state.drainAcceptedAt === undefined) {
    throw new SeptError("Invalid draining worker lifecycle state");
  }
  if (state.readiness === "draining" && state.drainedAt !== undefined) {
    throw new SeptError("Invalid draining worker lifecycle state");
  }
  if (state.readiness === "drained" && state.drainedAt === undefined) {
    throw new SeptError("Invalid drained worker lifecycle state");
  }
}

function optionalLifecycleDates(input: Record<string, unknown>, state: WorkerLifecycleState): void {
  if (input.drainAcceptedAt !== undefined) {
    state.drainAcceptedAt = isoDate(input.drainAcceptedAt, "worker lifecycle drainAcceptedAt");
  }
  if (input.drainedAt !== undefined) {
    state.drainedAt = isoDate(input.drainedAt, "worker lifecycle drainedAt");
  }
}

/** Validate the state-root readiness record that gates all admission. */
function validateWorkerLifecycle(value: unknown): WorkerLifecycleState {
  const input = unknownRecord(value, "worker lifecycle state");
  exactKeys(
    input,
    ["formatVersion", "readiness", "updatedAt"],
    ["drainAcceptedAt", "drainedAt"],
    "worker lifecycle state",
  );
  if (input.formatVersion !== 1) {
    throw new SeptError("Invalid durable worker lifecycle formatVersion");
  }
  const readiness: WorkerReadiness = enumValue(
    input.readiness,
    ["accepting", "draining", "drained"],
    "worker readiness",
  );
  const state: WorkerLifecycleState = {
    formatVersion: 1,
    readiness,
    updatedAt: isoDate(input.updatedAt, "worker lifecycle updatedAt"),
  };
  optionalLifecycleDates(input, state);
  validateReadinessDates(state);
  return state;
}

export {
  validateConversationEvent,
  validateOperatorMessage,
  validateRunEvent,
  validateWorkerLifecycle,
};
