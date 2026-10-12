/**
 * Owns the provider-neutral webhook envelope and its payload-free idempotency receipts. Durable
 * receipts contain only hashes and routing results: provider payloads and operator text never
 * cross this persistence boundary.
 */

import { createHash } from "node:crypto";
import { SeptError } from "../durable/index.js";
import { TASK_KEYS, validateOperatorMessage } from "./validation.js";

/** Validated outer webhook envelope accepted by the transport-independent router. */
export type WebhookEvent =
  | {
      version: 1;
      eventId: string;
      source: string;
      kind: "task";
      task: Record<string, unknown>;
    }
  | {
      version: 1;
      eventId: string;
      source: string;
      kind: "operator_message";
      runId: string;
      message: string;
    };

/** Minimal replay-safe result retained after webhook routing completes. */
export type WebhookResult =
  | { kind: "task"; runId: string; status: "active" }
  | { kind: "operator_message"; runId: string; messageId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SeptError(`${name} must be an object`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  const mismatch =
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index]);
  if (mismatch) {
    throw new SeptError(`${name} has unexpected or missing fields`);
  }
}

function boundedString(value: unknown, name: string, maximum: number): string {
  const invalid =
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value);
  if (invalid) {
    throw new SeptError(
      `${name} must be a trimmed non-empty string of at most ${String(maximum)} characters without control characters`,
    );
  }
  return value;
}

function adapterSource(value: unknown): string {
  const source = boundedString(value, "source", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(source)) {
    throw new SeptError("source must be an adapter identifier");
  }
  return source;
}

function runIdentifier(value: unknown, name: string): string {
  const identifier = boundedString(value, name, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(identifier)) {
    throw new SeptError(`${name} is invalid`);
  }
  return identifier;
}

function taskEvent(input: Record<string, unknown>, eventId: string, source: string): WebhookEvent {
  exactKeys(input, ["eventId", "kind", "source", "task", "version"], "task webhook event");
  const task = record(input.task, "task");
  if (Object.keys(task).some((key) => !TASK_KEYS.some((candidate) => candidate === key))) {
    throw new SeptError("task has unexpected fields");
  }
  return { version: 1, eventId, source, kind: "task", task };
}

function messageEvent(
  input: Record<string, unknown>,
  eventId: string,
  source: string,
): WebhookEvent {
  exactKeys(
    input,
    ["eventId", "kind", "message", "runId", "source", "version"],
    "operator_message webhook event",
  );
  return {
    version: 1,
    eventId,
    source,
    kind: "operator_message",
    runId: runIdentifier(input.runId, "runId"),
    message: validateOperatorMessage(input.message),
  };
}

/** Validate exact webhook framing before any receipt or runtime state can be created. */
export function validateWebhookEvent(value: unknown): WebhookEvent {
  const input = record(value, "webhook event");
  if (input.version !== 1) {
    throw new SeptError("webhook event version must be 1");
  }
  const eventId = boundedString(input.eventId, "eventId", 256);
  const source = adapterSource(input.source);
  if (input.kind === "task") {
    return taskEvent(input, eventId, source);
  }
  if (input.kind === "operator_message") {
    return messageEvent(input, eventId, source);
  }
  throw new SeptError("webhook event kind is invalid");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new SeptError("webhook event contains an unsupported value");
  }
  return JSON.stringify(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Derive separate delivery-key and full-event hashes without retaining hostile payload text. */
export function webhookHashes(event: WebhookEvent): { keyHash: string; eventHash: string } {
  return {
    keyHash: digest(canonical([event.source, event.eventId])),
    eventHash: digest(canonical(event)),
  };
}

/** Payload-free durable idempotency receipt store. */
export { WebhookReceipts } from "./webhook-receipts.js";
