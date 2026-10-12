/** Records exact operator identities captured by the controller before native input admission. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { atomicWrite, SeptError, type OperatorMessage, type RunStore } from "../durable/index.js";

interface DurableAdmission {
  formatVersion: 1;
  conversationId: number;
  requestId: string;
  operatorMessageIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function admissionRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SeptError("Pi Durable admission must be an object");
  }
  const allowed = ["formatVersion", "conversationId", "requestId", "operatorMessageIds"];
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
    input.formatVersion !== 1 ||
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
  return {
    formatVersion: 1,
    conversationId: input.conversationId,
    requestId: input.requestId,
    operatorMessageIds: admittedMessageIds(input.operatorMessageIds),
  };
}

/** Fsync exact captured IDs before native submission; later queue arrivals are never included. */
export function writeDurableAdmission(
  store: RunStore,
  conversationId: ConversationId,
  requestId: string,
  messages: readonly OperatorMessage[],
): void {
  atomicWrite(
    join(store.runDir, "pi-durable-admission.json"),
    validateAdmission({
      formatVersion: 1,
      conversationId,
      requestId,
      operatorMessageIds: messages.map((message) => message.id),
    }),
  );
}

/** Require bounded admission evidence for the exact native input being recovered. */
export function readDurableAdmission(
  store: RunStore,
  conversationId: ConversationId,
  requestId: string | undefined,
): readonly string[] {
  const path = join(store.runDir, "pi-durable-admission.json");
  try {
    if (!existsSync(path) || statSync(path).size > 32 * 1024) {
      throw new SeptError("Pi Durable recovery admission evidence is missing or oversized");
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const admission = validateAdmission(value);
    if (admission.conversationId !== conversationId || admission.requestId !== requestId) {
      throw new SeptError("Pi Durable recovery admission identity does not match native work");
    }
    return admission.operatorMessageIds;
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Pi Durable recovery admission evidence is unreadable", { cause: error });
  }
}
