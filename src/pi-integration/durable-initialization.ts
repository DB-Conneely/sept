/** Distinguishes interrupted first-open publication from missing published native history. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { atomicWrite, SeptError, type RunStore } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { assertDurableDatabase } from "./durable-database-preflight.js";

function unpublished(store: RunStore): boolean {
  const snapshot = store.snapshot();
  return (
    snapshot.epoch === 1 &&
    snapshot.invocations === 0 &&
    snapshot.activeSessionId === undefined &&
    snapshot.activeSessionFile === undefined &&
    snapshot.predecessorSessionId === undefined &&
    snapshot.predecessorSessionFile === undefined &&
    snapshot.handoverEpoch === undefined
  );
}

/** Fsync first-open intent before SQLite can expose any native initialization artifacts. */
export function prepareDurableInitialization(store: RunStore): void {
  const path = join(store.runDir, "pi-durable-initializing.json");
  if (existsSync(path) || existsSync(join(store.runDir, "pi-durable-engine.json"))) {
    return;
  }
  if (!unpublished(store)) {
    throw new SeptError("Pi Durable initialization requires unpublished first-open state");
  }
  atomicWrite(path, { engine: "pi-durable", version: "1.1.0", runId: store.runId });
}

function intentRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SeptError("Pi Durable initialization evidence is incompatible");
  }
  // CAST: Non-null JSON objects have string keys; arrays were rejected above.
  return input as Record<string, unknown>;
}

function validateIntent(store: RunStore, path: string): void {
  if (!statSync(path).isFile() || statSync(path).size > 1024) {
    throw new SeptError("Pi Durable initialization evidence is invalid or oversized");
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const input = intentRecord(value);
  if (
    input.engine !== "pi-durable" ||
    input.version !== "1.1.0" ||
    input.runId !== store.runId ||
    Object.keys(input).length !== 3
  ) {
    throw new SeptError("Pi Durable initialization evidence is incompatible");
  }
}

/** Read-only first-open recovery; published history never receives the initialization exception. */
export function readDurableInitialization(
  store: RunStore,
  telemetry: Observability,
): { conversationId: ConversationId | undefined } | undefined {
  const path = join(store.runDir, "pi-durable-initializing.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    validateIntent(store, path);
    if (!unpublished(store)) {
      return undefined;
    }
    const database = join(store.runDir, "pi-durable.sqlite");
    if (existsSync(database) && existsSync(join(store.runDir, "pi-durable-engine.json"))) {
      assertDurableDatabase(database, [], telemetry);
    }
    // Only initialization with no native work can be resumed; no task/history is discarded.
    const conversationId = existsSync(database)
      ? assertDurableDatabase(database, [], telemetry, { initializing: true })
      : undefined;
    return { conversationId };
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Pi Durable initialization evidence is unreadable", { cause: error });
  }
}
