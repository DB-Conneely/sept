import { fixtureBackend } from "./backend-support.js";
/** Present malformed native evidence fails before leases, repairs, task scheduling or schema writes. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { assertCompatibleStateRoot } from "../../src/pi-integration/index.js";
import { assertDurableDatabase } from "../../src/pi-integration/durable-database-preflight.js";
import { openDurableRuntime } from "../../src/pi-integration/durable-runtime.js";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { updateRuntimeSnapshot } from "../../src/runtime/runtime-state.js";
import { writeDurableAdmission } from "../../src/pi-integration/durable-admission.js";
import { readDurableLocator } from "../../src/pi-integration/durable-session-files.js";
import {
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  registerFixtureProvider,
  streamOf,
  assistant,
} from "./support.js";

async function nativeFixture() {
  const directories = fixtureDirectories("sept-native-preflight-");
  const models = await fixtureModelRuntime(directories.agentDir);
  registerFixtureProvider(models, "preflight", () =>
    streamOf(assistant([{ type: "text", text: "unused" }], 10, "stop")),
  );
  const store = fixtureStore(directories, "preflight", "preflight evidence");
  const native = await openDurableRuntime(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    undefined,
    { modelRuntime: models, executionBackend: fixtureBackend(models) },
  );
  store.update({
    phase: "running",
    activeSessionId: String(native.conversation.id),
    activeSessionFile: native.sessionFile,
  });
  await native.harness.close(BACKGROUND_CONTEXT);
  return {
    store,
    root: join(directories.root, "runs"),
    database: join(store.runDir, "pi-durable.sqlite"),
    marker: join(store.runDir, "pi-durable-engine.json"),
  };
}

await test("malformed/missing native marker and valid-header wrong schema are rejected without state repair", async () => {
  const fixture = await nativeFixture();
  assertCompatibleStateRoot(fixture.root);
  const state = readFileSync(fixture.store.snapshotPath);
  const marker = readFileSync(fixture.marker);
  writeFileSync(fixture.marker, "{ HOSTILE-MARKER-CANARY");
  assert.throws(() => {
    assertCompatibleStateRoot(fixture.root);
  }, /engine evidence is unreadable/);
  writeFileSync(fixture.marker, marker);
  renameSync(fixture.marker, `${fixture.marker}.preserved`);
  assert.throws(() => {
    assertCompatibleStateRoot(fixture.root);
  }, /engine evidence is missing/);
  renameSync(`${fixture.marker}.preserved`, fixture.marker);
  copyFileSync(fixture.database, `${fixture.database}.preserved`);
  const database = new DatabaseSync(fixture.database);
  database.exec("DROP TABLE submissions");
  database.close();
  const corrupt = readFileSync(fixture.database);
  assert.throws(() => {
    assertDurableDatabase(fixture.database, [], NOOP_TELEMETRY);
  }, /schema is unreadable/);
  assert.throws(() => {
    assertCompatibleStateRoot(fixture.root);
  }, /schema is unreadable/);
  assert.deepEqual(readFileSync(fixture.database), corrupt);
  assert.deepEqual(readFileSync(fixture.store.snapshotPath), state);
});

await test("installed startup rejects published history with all native artifacts removed without fresh-brain adoption", async () => {
  const fixture = await nativeFixture();
  const sessions = join(fixture.store.runDir, "pi-sessions");
  renameSync(sessions, `${sessions}.preserved`);
  renameSync(fixture.database, `${fixture.database}.preserved`);
  renameSync(fixture.marker, `${fixture.marker}.preserved`);
  updateRuntimeSnapshot(fixture.store, { activeSessionFile: undefined, invocations: 1 });
  const before = readFileSync(fixture.store.snapshotPath);
  assert.throws(() => {
    assertCompatibleStateRoot(fixture.root);
  }, /missing native engine evidence/);
  const child = spawnSync(
    resolve("sept"),
    [
      "worker",
      "--port",
      "0",
      "--state-dir",
      fixture.root,
      "--agent-dir",
      join(fixture.store.runDir, "generated-agent"),
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SEPT_TOKEN: "native-preflight-fixture",
        OTEL_SDK_DISABLED: "true",
        SEPT_LOG_LEVEL: "silent",
      },
    },
  );
  assert.equal(child.status, 1);
  assert.equal(child.signal, null);
  assert.match(child.stderr, /missing native engine evidence/);
  assert.deepEqual(readFileSync(fixture.store.snapshotPath), before);
});

await test("pending native admission cannot lower or change the published invocation identity", async () => {
  const fixture = await nativeFixture();
  fixture.store.update({ invocations: 1 });
  const file = fixture.store.snapshot().activeSessionFile;
  assert.ok(file);
  writeDurableAdmission(
    fixture.store,
    readDurableLocator(file).conversationId,
    "sept-invocation-2",
    [],
    "exact original prompt",
  );
  const before = readFileSync(fixture.store.snapshotPath);
  assert.throws(() => {
    assertCompatibleStateRoot(fixture.root);
  }, /invocation identity does not match/);
  assert.deepEqual(readFileSync(fixture.store.snapshotPath), before);
});
