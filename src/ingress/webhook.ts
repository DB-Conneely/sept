import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicCreate, atomicWrite, now, SeptError, type TaskRequest } from "../durable/index.js";
import { TASK_KEYS, validateOperatorMessage } from "./validation.js";

export type WebhookEvent =
  | { version: 1; eventId: string; source: string; kind: "task"; task: TaskRequest }
  | {
      version: 1;
      eventId: string;
      source: string;
      kind: "operator_message";
      runId: string;
      message: string;
    };

export type WebhookResult =
  | { kind: "task"; runId: string; status: "active" }
  | { kind: "operator_message"; runId: string; messageId: string };

interface WebhookReceipt {
  formatVersion: 1;
  keyHash: string;
  eventHash: string;
  kind: WebhookEvent["kind"];
  state: "pending" | "complete";
  createdAt: string;
  completedAt?: string;
  result?: WebhookResult;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SeptError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new SeptError(`${name} has unexpected or missing fields`);
}

function boundedString(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SeptError(
      `${name} must be a trimmed non-empty string of at most ${max} characters without control characters`,
    );
  }
  return value;
}

export function validateWebhookEvent(value: unknown): WebhookEvent {
  const input = record(value, "webhook event");
  if (input.version !== 1) throw new SeptError("webhook event version must be 1");
  const eventId = boundedString(input.eventId, "eventId", 256);
  const source = boundedString(input.source, "source", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(source))
    throw new SeptError("source must be an adapter identifier");

  if (input.kind === "task") {
    exactKeys(input, ["eventId", "kind", "source", "task", "version"], "task webhook event");
    const task = record(input.task, "task");
    const keys = Object.keys(task).sort();
    if (keys.some((key) => !(TASK_KEYS as readonly string[]).includes(key)))
      throw new SeptError("task has unexpected fields");
    return { version: 1, eventId, source, kind: "task", task: task as unknown as TaskRequest };
  }
  if (input.kind === "operator_message") {
    exactKeys(
      input,
      ["eventId", "kind", "message", "runId", "source", "version"],
      "operator_message webhook event",
    );
    const runId = boundedString(input.runId, "runId", 128);
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new SeptError("runId is invalid");
    const message = validateOperatorMessage(input.message);
    return { version: 1, eventId, source, kind: "operator_message", runId, message };
  }
  throw new SeptError("webhook event kind is invalid");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SeptError("webhook event contains an unsupported value");
  return encoded;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function webhookHashes(event: WebhookEvent): { keyHash: string; eventHash: string } {
  return {
    keyHash: digest(canonical([event.source, event.eventId])),
    eventHash: digest(canonical(event)),
  };
}

function validateResult(
  value: unknown,
  kind: WebhookEvent["kind"],
): asserts value is WebhookResult {
  const result = record(value, "webhook receipt result");
  if (kind === "task") {
    exactKeys(result, ["kind", "runId", "status"], "task webhook receipt result");
    if (
      result.kind !== "task" ||
      result.status !== "active" ||
      typeof result.runId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(result.runId)
    )
      throw new SeptError("Invalid task webhook receipt result");
    return;
  }
  exactKeys(result, ["kind", "messageId", "runId"], "operator_message webhook receipt result");
  if (
    result.kind !== "operator_message" ||
    typeof result.runId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(result.runId) ||
    typeof result.messageId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(result.messageId)
  ) {
    throw new SeptError("Invalid operator_message webhook receipt result");
  }
}

export class WebhookReceipts {
  private readonly root: string;

  constructor(stateRoot: string) {
    this.root = join(stateRoot, "webhook-receipts");
  }

  read(keyHash: string): WebhookReceipt | undefined {
    const path = this.path(keyHash);
    if (!existsSync(path)) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new SeptError("Invalid durable webhook receipt");
    }
    const receiptRecord = record(value, "durable webhook receipt");
    const receipt = receiptRecord as unknown as WebhookReceipt;
    if (
      receipt.formatVersion !== 1 ||
      receipt.keyHash !== keyHash ||
      !/^[a-f0-9]{64}$/.test(receipt.eventHash) ||
      !(receipt.kind === "task" || receipt.kind === "operator_message") ||
      !(receipt.state === "pending" || receipt.state === "complete") ||
      typeof receipt.createdAt !== "string"
    ) {
      throw new SeptError("Invalid durable webhook receipt");
    }
    const expectedKeys =
      receipt.state === "pending"
        ? ["createdAt", "eventHash", "formatVersion", "keyHash", "kind", "state"]
        : [
            "completedAt",
            "createdAt",
            "eventHash",
            "formatVersion",
            "keyHash",
            "kind",
            "result",
            "state",
          ];
    exactKeys(receiptRecord, expectedKeys, "durable webhook receipt");
    if (receipt.state === "complete") {
      if (typeof receipt.completedAt !== "string" || !receipt.result)
        throw new SeptError("Invalid completed webhook receipt");
      validateResult(receipt.result, receipt.kind);
    }
    return receipt;
  }

  claim(
    keyHash: string,
    eventHash: string,
    kind: WebhookEvent["kind"],
  ): { receipt: WebhookReceipt; created: boolean } {
    const receipt: WebhookReceipt = {
      formatVersion: 1,
      keyHash,
      eventHash,
      kind,
      state: "pending",
      createdAt: now(),
    };
    if (atomicCreate(this.path(keyHash), receipt)) return { receipt, created: true };
    const existing = this.read(keyHash);
    if (!existing) throw new SeptError("Webhook receipt disappeared during claim");
    return { receipt: existing, created: false };
  }

  complete(receipt: WebhookReceipt, result: WebhookResult): void {
    validateResult(result, receipt.kind);
    atomicWrite(this.path(receipt.keyHash), {
      ...receipt,
      state: "complete",
      result,
      completedAt: now(),
    } satisfies WebhookReceipt);
  }

  private path(keyHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(keyHash)) throw new SeptError("Webhook receipt key is invalid");
    return join(this.root, `${keyHash}.json`);
  }
}
