/** Owns bounded, versioned native conversation locators; legacy coding-agent transcripts fail closed. */

import { existsSync, opendirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { atomicWrite, SeptError } from "../durable/index.js";

/** SEPT locator for one Pi Durable conversation; Pi owns its SQLite contents. */
export interface DurableSessionLocator {
  formatVersion: 1;
  engine: "pi-durable";
  conversationId: ConversationId;
  parentSession?: string;
}

function locatorRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SeptError("Pi Durable session locator is invalid");
  }
  const allowed = ["formatVersion", "engine", "conversationId", "parentSession"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new SeptError("Pi Durable session locator has unknown fields");
  }
  if (
    !("formatVersion" in value) ||
    value.formatVersion !== 1 ||
    !("engine" in value) ||
    value.engine !== "pi-durable"
  ) {
    throw new SeptError("Pi Durable cannot adopt a legacy native Pi session file");
  }
  return value;
}

function conversationIdentity(value: unknown): ConversationId {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SeptError("Pi Durable conversation identity is invalid");
  }
  // CAST: The branded native ID is a positive safe integer validated before Harness lookup.
  return value as ConversationId;
}

function predecessorPath(parent: unknown): string | undefined {
  if (
    parent !== undefined &&
    (typeof parent !== "string" ||
      parent.length < 1 ||
      parent.length > 4096 ||
      /[\x00-\x1f]/.test(parent))
  ) {
    throw new SeptError("Pi Durable predecessor locator is invalid");
  }
  return parent;
}

function validateLocator(value: unknown): DurableSessionLocator {
  const locator = locatorRecord(value);
  const conversationId = conversationIdentity(locator.conversationId);
  const parent = predecessorPath(locator.parentSession);
  return {
    formatVersion: 1,
    engine: "pi-durable",
    conversationId,
    ...(parent === undefined ? {} : { parentSession: parent }),
  };
}

/** Read hostile durable state with a 16 KiB ceiling before starting any native task. */
export function readDurableLocator(path: string): DurableSessionLocator {
  try {
    const file = statSync(path);
    if (!file.isFile() || file.size > 16 * 1024) {
      throw new SeptError("Pi Durable session locator exceeds its bound");
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validateLocator(value);
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Pi Durable session locator is unreadable", { cause: error });
  }
}

/** Fsync a locator only after the native conversation has committed to SQLite. */
export function writeDurableLocator(
  directory: string,
  conversationId: ConversationId,
  parentSession?: string,
): string {
  const path = join(directory, `${String(conversationId)}.durable.json`);
  atomicWrite(path, {
    formatVersion: 1,
    engine: "pi-durable",
    conversationId,
    ...(parentSession === undefined ? {} : { parentSession }),
  });
  return path;
}

/** Find the unique committed child; ambiguity or malformed native candidates prevents adoption. */
export function findSuccessorSession(
  directory: string,
  predecessorFile: string,
): string | undefined {
  if (!existsSync(directory)) {
    return undefined;
  }
  const handle = opendirSync(directory);
  let count = 0;
  let successor: string | undefined;
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      count += 1;
      // The manifest permits at most 1,000 epochs; bound discovery before collecting entries.
      if (count > 1001) {
        throw new SeptError("Pi Durable session discovery exceeds the epoch bound");
      }
      if (!entry.name.endsWith(".durable.json")) {
        continue;
      }
      const path = join(directory, entry.name);
      if (readDurableLocator(path).parentSession !== predecessorFile) {
        continue;
      }
      if (successor !== undefined) {
        throw new SeptError("Pi Durable successor identity is ambiguous");
      }
      successor = path;
    }
    return successor;
  } finally {
    handle.closeSync();
  }
}
