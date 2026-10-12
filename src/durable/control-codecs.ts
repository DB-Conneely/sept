/**
 * Validates hostile assistant control and context-transfer output at the durable boundary. Runtime
 * receives only bounded domain values; secrets and internal control syntax cannot enter the public
 * conversation, and no handover is writable until its complete schema passes.
 */

import type {
  DurableHandover,
  Handover,
  OperatorMessage,
  WorkControl,
  WorkResponse,
} from "./contracts.js";
import { HANDOVER_FIELDS } from "./contracts.js";
import { validateOperatorMessage } from "./evidence-codecs.js";
import { SeptError } from "./errors.js";
import {
  MAX_CONTROL_ARRAY_ITEMS,
  MAX_CONTROL_BYTES,
  MAX_CONTROL_STRING_CHARS,
  MAX_CONVERSATION_TEXT_CHARS,
} from "./limits.js";
import {
  boundedInteger,
  boundedString,
  enumValue,
  exactKeys,
  isoDate,
  unknownRecord,
} from "./validation-primitives.js";

const SENSITIVE_ASSISTANT_OUTPUT =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+|\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const INTERNAL_ASSISTANT_OUTPUT =
  /(?:SEPT_CONTEXT_ROTATION|"handover_summary"\s*:|"next_action"\s*:|"verification"\s*:|```(?:json)?\s*\{\s*"status")/i;

/** Parse the last fenced or outer assistant JSON object as hostile input. */
export function parseJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].at(-1)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const parsed: unknown = JSON.parse(candidate.trim());
    return parsed;
  } catch (error: unknown) {
    throw new SeptError("Assistant did not return valid terminal JSON", { cause: error });
  }
}

function controlString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > MAX_CONTROL_STRING_CHARS) {
    throw new SeptError(
      `${field} must be a string of at most ${String(MAX_CONTROL_STRING_CHARS)} characters`,
    );
  }
  return value;
}

function controlStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONTROL_ARRAY_ITEMS) {
    throw new SeptError(
      `${field} must be an array of at most ${String(MAX_CONTROL_ARRAY_ITEMS)} strings of at most ${String(MAX_CONTROL_STRING_CHARS)} characters`,
    );
  }
  const strings: string[] = [];
  for (const element of value) {
    strings.push(controlString(element, field));
  }
  return strings;
}

function boundedControl<Control>(value: Control): Control {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTROL_BYTES) {
    throw new SeptError("Assistant control exceeds its durable byte limit");
  }
  return value;
}

/** Validate an agent lifecycle decision before checkpoint or transition. */
export function validateWork(value: unknown): WorkControl {
  const input = unknownRecord(value, "work control");
  exactKeys(input, ["next_action", "status", "summary", "verification"], [], "work control");
  const result: WorkControl = {
    status: enumValue(
      input.status,
      ["continue", "waiting", "complete", "blocked"],
      "work control status",
    ),
    summary: controlString(input.summary, "summary"),
    verification: controlStrings(input.verification, "verification"),
    next_action: controlString(input.next_action, "next_action"),
  };
  const needsNextAction = result.status === "continue" || result.status === "waiting";
  if (needsNextAction && !result.next_action.trim()) {
    throw new SeptError(`${result.status} work requires next_action`);
  }
  return boundedControl(result);
}

function safeAssistantMessage(value: unknown): string {
  const message = boundedString(value, 1, MAX_CONVERSATION_TEXT_CHARS, "assistant message");
  if (!message.trim()) {
    throw new SeptError("Assistant message must not be blank");
  }
  if (SENSITIVE_ASSISTANT_OUTPUT.test(message) || INTERNAL_ASSISTANT_OUTPUT.test(message)) {
    throw new SeptError("Assistant message failed the safe conversation filter");
  }
  return message;
}

/** Validate the only assistant envelope eligible for public conversation output. */
export function validateWorkResponse(value: unknown): WorkResponse {
  const input = unknownRecord(value, "work response");
  if (!("control" in input)) {
    return { control: validateWork(input) };
  }
  exactKeys(input, ["control", "message"], [], "work response");
  return {
    control: validateWork(input.control),
    message: safeAssistantMessage(input.message),
  };
}

/** Validate complete context-transfer content before any handover write. */
export function validateHandover(value: unknown): Handover {
  const input = unknownRecord(value, "handover");
  exactKeys(
    input,
    ["handover_summary", "entry_state_and_done", ...HANDOVER_FIELDS, "next_action"],
    [],
    "handover",
  );
  const handover: Handover = {
    handover_summary: controlString(input.handover_summary, "handover_summary"),
    entry_state_and_done: controlString(input.entry_state_and_done, "entry_state_and_done"),
    next_action: controlString(input.next_action, "next_action"),
    completed: controlStrings(input.completed, "completed"),
    in_flight: controlStrings(input.in_flight, "in_flight"),
    not_started: controlStrings(input.not_started, "not_started"),
    decisions: controlStrings(input.decisions, "decisions"),
    rejected_approaches: controlStrings(input.rejected_approaches, "rejected_approaches"),
    verification: controlStrings(input.verification, "verification"),
    uncertainties: controlStrings(input.uncertainties, "uncertainties"),
    references: controlStrings(input.references, "references"),
    lessons: controlStrings(input.lessons, "lessons"),
  };
  if (!handover.next_action.trim()) {
    throw new SeptError("Handover requires next_action");
  }
  return boundedControl(handover);
}

function handoverMessages(value: unknown): OperatorMessage[] {
  if (!Array.isArray(value)) {
    throw new SeptError("Invalid durable handover operatorMessages");
  }
  return value.map((message) => validateOperatorMessage(message));
}

function handoverEvidenceRecord(value: unknown): Record<string, unknown> {
  const input = unknownRecord(value, "handover evidence");
  exactKeys(
    input,
    [
      "epoch",
      "formatVersion",
      "handover",
      "operatorMessages",
      "predecessorSessionId",
      "runId",
      "writtenAt",
    ],
    ["predecessorSessionFile"],
    "handover evidence",
  );
  if (input.formatVersion !== 1) {
    throw new SeptError("Invalid durable handover formatVersion");
  }
  return input;
}

/** Validate fsynced handover evidence read during restart recovery. */
function validateDurableHandover(value: unknown): DurableHandover {
  const input = handoverEvidenceRecord(value);
  const result: DurableHandover = {
    formatVersion: 1,
    runId: boundedString(input.runId, 1, 128, "handover runId"),
    epoch: boundedInteger(input.epoch, 1, 1000, "handover epoch"),
    predecessorSessionId: boundedString(
      input.predecessorSessionId,
      1,
      4096,
      "handover predecessorSessionId",
    ),
    operatorMessages: handoverMessages(input.operatorMessages),
    handover: validateHandover(input.handover),
    writtenAt: isoDate(input.writtenAt, "handover writtenAt"),
  };
  if (input.predecessorSessionFile !== undefined) {
    result.predecessorSessionFile = boundedString(
      input.predecessorSessionFile,
      1,
      4096,
      "handover predecessorSessionFile",
    );
  }
  return result;
}

/** Render validated handover evidence for human recovery inspection. */
function renderHandover(value: DurableHandover): string {
  const handover = value.handover;
  const sections = [
    "# SEPT cycle handover",
    `Predecessor Pi session: \`${value.predecessorSessionId}\``,
    handover.handover_summary,
    `## Entry state and definition of done\n\n${handover.entry_state_and_done}`,
  ];
  for (const field of HANDOVER_FIELDS) {
    const entries = handover[field];
    const body =
      entries.length > 0 ? entries.map((entry) => `- ${entry}`).join("\n") : "- None recorded.";
    sections.push(`## ${field.replaceAll("_", " ")}\n\n${body}`);
  }
  sections.push(`## Exact next action\n\n${handover.next_action}`);
  if (value.operatorMessages.length > 0) {
    sections.push(
      `## Incorporated operator input\n\n\`\`\`json\n${JSON.stringify(value.operatorMessages, undefined, 2)}\n\`\`\``,
    );
  }
  return `${sections.join("\n\n")}\n`;
}

export { renderHandover, validateDurableHandover };
