/**
 * Persists payload-free webhook idempotency receipts. It owns receipt codecs and atomic claim /
 * completion ordering; webhook validation and runtime admission remain separate dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicCreate, atomicWrite, now, SeptError } from "../durable/index.js";
import type { WebhookEvent, WebhookResult } from "./webhook.js";

interface PendingWebhookReceipt {
  formatVersion: 1;
  keyHash: string;
  eventHash: string;
  kind: WebhookEvent["kind"];
  state: "pending";
  createdAt: string;
}

interface CompleteWebhookReceipt {
  formatVersion: 1;
  keyHash: string;
  eventHash: string;
  kind: WebhookEvent["kind"];
  state: "complete";
  createdAt: string;
  completedAt: string;
  result: WebhookResult;
}

type WebhookReceipt = PendingWebhookReceipt | CompleteWebhookReceipt;

const COMPLETE_RECEIPT_KEYS = [
  "completedAt",
  "createdAt",
  "eventHash",
  "formatVersion",
  "keyHash",
  "kind",
  "result",
  "state",
] as const;

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

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new SeptError(`Invalid ${name}`);
  }
  return value;
}

function validateResult(value: unknown, kind: WebhookEvent["kind"]): WebhookResult {
  const result = record(value, "webhook receipt result");
  if (kind === "task") {
    exactKeys(result, ["kind", "runId", "status"], "task webhook receipt result");
    if (result.kind !== "task" || result.status !== "active") {
      throw new SeptError("Invalid task webhook receipt result");
    }
    return { kind: "task", runId: identifier(result.runId, "runId"), status: "active" };
  }
  exactKeys(result, ["kind", "messageId", "runId"], "operator_message webhook receipt result");
  if (result.kind !== "operator_message") {
    throw new SeptError("Invalid operator_message webhook receipt result");
  }
  return {
    kind: "operator_message",
    runId: identifier(result.runId, "runId"),
    messageId: identifier(result.messageId, "messageId"),
  };
}

function receiptKind(value: unknown): WebhookEvent["kind"] {
  if (value === "task" || value === "operator_message") {
    return value;
  }
  throw new SeptError("Invalid durable webhook receipt");
}

function parseReceipt(value: unknown, keyHash: string): WebhookReceipt {
  const receipt = record(value, "durable webhook receipt");
  const eventHash = receipt.eventHash;
  const createdAt = receipt.createdAt;
  const commonValid =
    receipt.formatVersion === 1 &&
    receipt.keyHash === keyHash &&
    typeof eventHash === "string" &&
    /^[a-f0-9]{64}$/.test(eventHash) &&
    typeof createdAt === "string";
  if (!commonValid || typeof eventHash !== "string" || typeof createdAt !== "string") {
    throw new SeptError("Invalid durable webhook receipt");
  }
  const kind = receiptKind(receipt.kind);
  if (receipt.state !== "pending") {
    return parseCompleteReceipt(receipt, keyHash, kind);
  }
  exactKeys(
    receipt,
    ["createdAt", "eventHash", "formatVersion", "keyHash", "kind", "state"],
    "durable webhook receipt",
  );
  return { formatVersion: 1, keyHash, eventHash, kind, state: "pending", createdAt };
}

function parseCompleteReceipt(
  receipt: Record<string, unknown>,
  keyHash: string,
  kind: WebhookEvent["kind"],
): CompleteWebhookReceipt {
  exactKeys(receipt, COMPLETE_RECEIPT_KEYS, "durable webhook receipt");
  const completedAt = receipt.completedAt;
  const createdAt = receipt.createdAt;
  const eventHash = receipt.eventHash;
  if (
    receipt.state !== "complete" ||
    typeof completedAt !== "string" ||
    typeof createdAt !== "string" ||
    typeof eventHash !== "string"
  ) {
    throw new SeptError("Invalid completed webhook receipt");
  }
  return {
    formatVersion: 1,
    keyHash,
    eventHash,
    kind,
    state: "complete",
    createdAt,
    completedAt,
    result: validateResult(receipt.result, kind),
  };
}

/** Owns atomic claim and completion of bounded webhook idempotency receipts. */
export class WebhookReceipts {
  private readonly root: string;

  public constructor(stateRoot: string) {
    this.root = join(stateRoot, "webhook-receipts");
  }

  /** Read and fully validate a receipt; malformed present state fails closed. */
  public read(keyHash: string): WebhookReceipt | undefined {
    const path = this.path(keyHash);
    if (!existsSync(path)) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new SeptError("Invalid durable webhook receipt", { cause: error });
    }
    return parseReceipt(value, keyHash);
  }

  /** Atomically reserve an event key so concurrent deliveries cannot both gain authority. */
  public claim(
    keyHash: string,
    eventHash: string,
    kind: WebhookEvent["kind"],
  ): { receipt: WebhookReceipt; created: boolean } {
    const receipt: PendingWebhookReceipt = {
      formatVersion: 1,
      keyHash,
      eventHash,
      kind,
      state: "pending",
      createdAt: now(),
    };
    // Atomic create is the authority handoff: only the creator may be the first delivery.
    if (atomicCreate(this.path(keyHash), receipt)) {
      return { receipt, created: true };
    }
    const existing = this.read(keyHash);
    if (existing === undefined) {
      throw new SeptError("Webhook receipt disappeared during claim");
    }
    return { receipt: existing, created: false };
  }

  /** Persist the replay result only after runtime admission has completed successfully. */
  public complete(receipt: WebhookReceipt, result: WebhookResult): void {
    const validatedResult = validateResult(result, receipt.kind);
    atomicWrite(this.path(receipt.keyHash), {
      ...receipt,
      state: "complete",
      result: validatedResult,
      completedAt: now(),
    } satisfies CompleteWebhookReceipt);
  }

  private path(keyHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(keyHash)) {
      throw new SeptError("Webhook receipt key is invalid");
    }
    return join(this.root, `${keyHash}.json`);
  }
}
