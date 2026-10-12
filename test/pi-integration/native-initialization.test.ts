/** Interrupted first-open evidence resumes only before any native work or published identity. */

import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assertNativeRun } from "../../src/pi-integration/index.js";
import {
  prepareDurableInitialization,
  readDurableInitialization,
} from "../../src/pi-integration/durable-initialization.js";
import {
  createDurableConversation,
  openDurableRuntime,
} from "../../src/pi-integration/durable-runtime.js";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import {
  assistant,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  registerFixtureProvider,
  streamOf,
} from "./support.js";

async function fixture() {
  const directories = fixtureDirectories("sept-native-initialization-");
  const models = await fixtureModelRuntime(directories.agentDir);
  registerFixtureProvider(models, "initialization", () =>
    streamOf(assistant([{ type: "text", text: "unused" }], 10, "stop")),
  );
  const store = fixtureStore(directories, "initialization", "recover initial publication");
  return { store, directories, models };
}

await test("native initialization resumes absent, empty and atomically initialized schema before conversation creation", async () => {
  for (const stage of ["intent", "database", "schema"]) {
    const { store, directories, models } = await fixture();
    prepareDurableInitialization(store);
    const path = join(store.runDir, "pi-durable.sqlite");
    if (stage === "database") {
      new DatabaseSync(path).close();
    } else if (stage === "schema") {
      const database = await openNodeSqliteDatabase(path);
      await database.exec("PRAGMA synchronous = FULL");
      const storage = await SqliteStorage.open(database);
      await storage.close(BACKGROUND_CONTEXT);
    }
    assertNativeRun(store);
    assert.equal(readDurableInitialization(store, NOOP_TELEMETRY)?.conversationId, undefined);
    const native = await openDurableRuntime(
      store.manifest(),
      store,
      directories.agentDir,
      undefined,
      NOOP_TELEMETRY,
      { modelRuntime: models },
    );
    try {
      assert.equal(
        readDurableInitialization(store, NOOP_TELEMETRY)?.conversationId,
        native.conversation.id,
      );
    } finally {
      await native.harness.close(BACKGROUND_CONTEXT);
    }
  }
});

async function recoverStage(stage: string): Promise<void> {
  const { store, directories, models } = await fixture();
  const native = await openDurableRuntime(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: models },
  );
  const id = native.conversation.id;
  await native.harness.close(BACKGROUND_CONTEXT);
  if (stage !== "marker") {
    const marker = join(store.runDir, "pi-durable-engine.json");
    renameSync(marker, `${marker}.preserved`);
  }
  if (stage === "conversation") {
    renameSync(native.sessionFile, `${native.sessionFile}.preserved`);
  }
  assertNativeRun(store);
  const recovered = await openDurableRuntime(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: models },
  );
  try {
    assert.equal(recovered.conversation.id, id);
    const conversations = await recovered.conversation.commit(
      (tx) => tx.scanConversations({}, 2),
      BACKGROUND_CONTEXT,
    );
    assert.equal(conversations.items.length, 1);
  } finally {
    await recovered.harness.close(BACKGROUND_CONTEXT);
  }
}

await test("initial conversation, locator and marker publication gaps reuse the same native identity", async () => {
  for (const stage of ["conversation", "locator", "marker"]) {
    await recoverStage(stage);
  }
});

await test("initialization rejects malformed intent", async () => {
  const { store } = await fixture();
  prepareDurableInitialization(store);
  const intent = join(store.runDir, "pi-durable-initializing.json");
  writeFileSync(
    intent,
    JSON.stringify({ engine: "pi-durable", version: "1.1.0", runId: "foreign-run" }),
  );
  assert.throws(() => {
    assertNativeRun(store);
  }, /initialization evidence is incompatible/);
});

await test("initialization rejects native work without published authority", async () => {
  const { store, directories, models } = await fixture();
  const native = await openDurableRuntime(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: models },
  );
  try {
    const submitted = await native.conversation.submit(
      { type: "input", content: "native work without SEPT publication" },
      BACKGROUND_CONTEXT,
    );
    await submitted.wait(BACKGROUND_CONTEXT);
    assert.throws(() => {
      assertNativeRun(store);
    }, /native work without published authority/);
  } finally {
    await native.harness.close(BACKGROUND_CONTEXT);
  }
});

await test("initialization rejects ambiguous conversations", async () => {
  const second = await fixture();
  const opened = await openDurableRuntime(
    second.store.manifest(),
    second.store,
    second.directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: second.models },
  );
  try {
    await createDurableConversation(opened.harness, second.store.manifest());
    assert.throws(() => {
      assertNativeRun(second.store);
    }, /initial conversation identity is ambiguous/);
  } finally {
    await opened.harness.close(BACKGROUND_CONTEXT);
  }
});
