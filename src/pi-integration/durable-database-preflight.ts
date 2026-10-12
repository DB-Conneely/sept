/** Verifies pinned native SQLite metadata/schema/locators without initializing or migrating storage. */

import { SeptError } from "../durable/index.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Observability } from "../observability/index.js";
import type { DurableSessionLocator } from "./durable-session-files.js";
import { loadNativeSqliteReader } from "./sqlite-driver.js";

/** Reject incompatible native schema and missing conversation identities before SEPT recovery writes. */
export function assertDurableDatabase(
  path: string,
  locators: readonly DurableSessionLocator[],
  telemetry: Observability,
  options?: { initializing: true },
): ConversationId | undefined {
  const { DatabaseSync } = loadNativeSqliteReader(telemetry);
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return inspectDatabase(database, locators, options);
    } finally {
      database.close();
    }
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Pi Durable database schema is unreadable or incompatible", {
      cause: error,
    });
  }
}

function inspectDatabase(
  database: import("node:sqlite").DatabaseSync,
  locators: readonly DurableSessionLocator[],
  options: { initializing: true } | undefined,
): ConversationId | undefined {
  const empty =
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1").get() ===
    undefined;
  if (options?.initializing && empty) {
    if (locators.length > 0) {
      throw new SeptError("Pi Durable locator precedes its initialized native schema");
    }
    return undefined;
  }
  validateSchema(database);
  validateLocators(database, locators);
  return options?.initializing ? initialConversation(database) : undefined;
}

function initialConversation(
  database: import("node:sqlite").DatabaseSync,
): ConversationId | undefined {
  const work = database
    .prepare(
      "SELECT id FROM tasks UNION ALL SELECT id FROM submissions UNION ALL SELECT id FROM entries LIMIT 1",
    )
    .get();
  if (work !== undefined) {
    throw new SeptError(
      "Pi Durable initialization contains native work without published authority",
    );
  }
  const conversations = database.prepare("SELECT id, record FROM conversations LIMIT 2").all();
  if (conversations.length > 1) {
    throw new SeptError("Pi Durable initial conversation identity is ambiguous");
  }
  const conversation = conversations[0];
  if (conversation === undefined) {
    return undefined;
  }
  if (
    typeof conversation.id !== "number" ||
    !Number.isSafeInteger(conversation.id) ||
    conversation.id < 1
  ) {
    throw new SeptError("Pi Durable initial conversation identity is invalid");
  }
  const record = validateConversation(conversation.record, conversation.id);
  if (record.owner !== undefined || record.parent !== undefined) {
    throw new SeptError("Pi Durable initial conversation must be ownerless and unforked");
  }
  // CAST: A positive safe native ID was validated above, before Harness lookup.
  return conversation.id as ConversationId;
}

function validateLocators(
  database: import("node:sqlite").DatabaseSync,
  locators: readonly DurableSessionLocator[],
): void {
  for (const locator of locators) {
    const row = database
      .prepare("SELECT record FROM conversations WHERE id = ?")
      .get(locator.conversationId);
    if (row === undefined) {
      throw new SeptError("Pi Durable locator names a missing native conversation");
    }
    validateConversation(row.record, locator.conversationId);
  }
}

function validateConversation(record: unknown, conversationId: number): Record<string, unknown> {
  if (typeof record !== "string" || Buffer.byteLength(record) > 16 * 1024) {
    throw new SeptError("Pi Durable conversation evidence is invalid or oversized");
  }
  const value: unknown = JSON.parse(record);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("id" in value) ||
    value.id !== conversationId
  ) {
    throw new SeptError("Pi Durable conversation evidence does not match its locator");
  }
  return value;
}

function validateSchema(database: import("node:sqlite").DatabaseSync): void {
  const schema = database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get();
  if (schema?.version !== 1) {
    throw new SeptError("Pi Durable database schema version is incompatible");
  }
  const metadata = database
    .prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1")
    .get();
  validateMetadata(metadata);
  validateTables(database);
}

function validateMetadata(
  metadata: Record<string, import("node:sqlite").SQLOutputValue> | undefined,
): void {
  if (
    typeof metadata?.next_id !== "string" ||
    !/^[0-9]{1,16}$/.test(metadata.next_id) ||
    !Number.isSafeInteger(Number(metadata.next_id))
  ) {
    throw new SeptError("Pi Durable database identity metadata is invalid");
  }
  if (
    typeof metadata.next_seq !== "number" ||
    !Number.isSafeInteger(metadata.next_seq) ||
    metadata.next_seq < 1
  ) {
    throw new SeptError("Pi Durable database sequence metadata is invalid");
  }
}

function validateTables(database: import("node:sqlite").DatabaseSync): void {
  // These fixed zero-row queries verify the 1.1.0 schema without scanning task/history payloads.
  for (const query of [
    "SELECT id, record_type FROM record_ids LIMIT 0",
    "SELECT id, owner_conversation_id, owner_task_id, record FROM conversations LIMIT 0",
    "SELECT id, conversation_id, head, commit_seq, record FROM entries LIMIT 0",
    "SELECT id, conversation_id, kind, status, abort_requested, background, record FROM tasks LIMIT 0",
    "SELECT id, conversation_id, request_id, status, record FROM submissions LIMIT 0",
    "SELECT id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record FROM documents LIMIT 0",
    "SELECT document_id, seq, kind, version, content FROM document_revisions LIMIT 0",
  ]) {
    database.prepare(query).all();
  }
}
