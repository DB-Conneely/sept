/** Records exact operator identities captured by the controller before native input admission. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { atomicWrite, SeptError, type OperatorMessage, type RunStore } from "../durable/index.js";

/** One bounded invocation identity; SEPT checkpoints it only after its domain transition is durable. */
export interface DurableAdmission {
  formatVersion: 2;
  conversationId: number;
  requestId: string;
  operatorMessageIds: string[];
  prompt: string;
  checkpointed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function admissionRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SeptError("Pi Durable admission must be an object");
  }
  const allowed = [
    "formatVersion",
    "conversationId",
    "requestId",
    "operatorMessageIds",
    "prompt",
    "checkpointed",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new SeptError("Pi Durable admission contains unknown fields");
  }
  return value;
}

function admittedMessageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new SeptError("Pi Durable admitted operator identities exceed their bound");
  }
  const ids = value.map((id: unknown) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) {
      throw new SeptError("Pi Durable admitted operator identity is invalid");
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new SeptError("Pi Durable admitted operator identities are duplicated");
  }
  return ids;
}

function validateAdmission(value: unknown): DurableAdmission {
  const input = admissionRecord(value);
  if (
    input.formatVersion !== 2 ||
    typeof input.conversationId !== "number" ||
    !Number.isSafeInteger(input.conversationId) ||
    input.conversationId < 1
  ) {
    throw new SeptError("Pi Durable admission conversation identity is invalid");
  }
  if (
    typeof input.requestId !== "string" ||
    !/^sept-invocation-[0-9]{1,10}$/.test(input.requestId)
  ) {
    throw new SeptError("Pi Durable admission request identity is invalid");
  }
  if (typeof input.prompt !== "string" || Buffer.byteLength(input.prompt) > 4 * 1024 * 1024) {
    throw new SeptError("Pi Durable admission prompt is invalid or oversized");
  }
  if (typeof input.checkpointed !== "boolean") {
    throw new SeptError("Pi Durable admission checkpoint authority is invalid");
  }
  return {
    formatVersion: 2,
    conversationId: input.conversationId,
    requestId: input.requestId,
    operatorMessageIds: admittedMessageIds(input.operatorMessageIds),
    prompt: input.prompt,
    checkpointed: input.checkpointed,
  };
}

/** Fsync exact captured IDs before native submission; later queue arrivals are never included. */
export function writeDurableAdmission(
  store: RunStore,
  conversationId: ConversationId,
  requestId: string,
  messages: readonly OperatorMessage[],
  prompt: string,
): void {
  atomicWrite(
    join(store.runDir, "pi-durable-admission.json"),
    validateAdmission({
      formatVersion: 2,
      conversationId,
      requestId,
      operatorMessageIds: messages.map((message) => message.id),
      prompt,
      checkpointed: false,
    }),
  );
}

/** Require bounded admission evidence for the exact native input being recovered. */
export function readDurableAdmission(
  store: RunStore,
  conversationId: ConversationId,
  requestId: string | undefined,
): readonly string[] {
  const admission = readInvocationAdmission(store);
  if (admission?.conversationId !== conversationId || admission.requestId !== requestId) {
    throw new SeptError("Pi Durable recovery admission identity does not match native work");
  }
  return admission.operatorMessageIds;
}

/** Read the bounded identity without dispatch or writes; malformed present evidence never means fresh. */
export function readInvocationAdmission(store: RunStore): DurableAdmission | undefined {
  const path = join(store.runDir, "pi-durable-admission.json");
  try {
    if (!existsSync(path)) {
      return undefined;
    }
    if (!statSync(path).isFile() || statSync(path).size > 5 * 1024 * 1024) {
      throw new SeptError("Pi Durable recovery admission evidence is oversized");
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validateAdmission(value);
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Pi Durable recovery admission evidence is unreadable", { cause: error });
  }
}

/** Acknowledge only the result whose complete domain checkpoint/transition has already been fsynced. */
export function completeDurableAdmission(store: RunStore, requestId: string): void {
  const admission = readInvocationAdmission(store);
  if (admission?.requestId !== requestId) {
    throw new SeptError("Pi Durable checkpoint identity does not match admission");
  }
  atomicWrite(join(store.runDir, "pi-durable-admission.json"), {
    ...admission,
    checkpointed: true,
  });
}
