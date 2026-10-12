/**
 * Verifies durable Pi rotation and restart adoption through CycleController. Fixtures inject only
 * native host outcomes; runtime remains responsible for handover ordering and session authority.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CycleController } from "../../src/runtime/index.js";
import { complete, FakeHost, handover, RuntimeFixtureError, controllerFixture } from "./support.js";

void test("cycles only after durable handover and injects it into a distinct successor", async () => {
  const { store } = controllerFixture();
  const message = store.enqueueMessage("preserve this exact direction");
  const host = new FakeHost([
    { text: JSON.stringify(handover), steered: true, contextTokens: 90, contextWindow: 100 },
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  await new CycleController(store, "/pi", () => Promise.resolve(host)).run();
  assert.equal(store.snapshot().status, "complete");
  assert.equal(store.snapshot().epoch, 2);
  assert.equal(host.replacements, 1);
  const successorPrompt = host.prompts[1];
  assert.ok(successorPrompt !== undefined);
  assert.match(successorPrompt, /Full durable predecessor handover/);
  assert.match(successorPrompt, /pi-predecessor/);
  assert.equal(store.pendingMessages().length, 0);
  const events = store.events(0, 1000);
  assert.ok(
    events.findIndex((event) => event.type === "handover_written") <
      events.findIndex((event) => event.type === "successor_session_started"),
  );
  const written = events.find((event) => event.type === "handover_written");
  assert.deepEqual(written?.messageIds, [message.id]);
  assert.equal(events.filter((event) => event.type === "successor_session_started").length, 1);
});

void test("restart resumes the durable Pi session and carries recovery context", async () => {
  const { store } = controllerFixture();
  store.update({
    phase: "running",
    invocations: 1,
    activeSessionId: "pi-existing",
    activeSessionFile: "/pi/existing.jsonl",
  });
  let opened: string | undefined;
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 20, contextWindow: 100 },
  ]);
  host.sessionId = "pi-existing";
  host.sessionFile = "/pi/existing.jsonl";
  await new CycleController(store, "/pi", (_manifest, _store, _dir, existing) => {
    opened = existing;
    return Promise.resolve(host);
  }).run();
  assert.equal(opened, "/pi/existing.jsonl");
  const prompt = host.prompts[0];
  assert.ok(prompt !== undefined);
  assert.match(prompt, /controller restarted/i);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "pi_session_resumed").length,
    1,
  );
});

void test("restart after durable handover creates exactly one successor and preserves later operator input", async () => {
  const { store } = controllerFixture();
  store.update({
    phase: "running",
    activeSessionId: "pi-predecessor",
    activeSessionFile: "/pi/predecessor.jsonl",
  });
  store.persistHandover(1, "pi-predecessor", "/pi/predecessor.jsonl", handover, []);
  const message = store.enqueueMessage("arrived after the handover commit");
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  await new CycleController(store, "/pi", () => Promise.resolve(host)).run();
  assert.equal(host.replacements, 1);
  const prompt = host.prompts[0];
  assert.ok(prompt !== undefined);
  assert.match(prompt, /arrived after the handover commit/);
  assert.equal(store.pendingMessages().length, 0);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "successor_session_started").length,
    1,
  );
  const consumed = store
    .events(0, 1000)
    .find((event) => event.type === "operator_messages_consumed");
  assert.deepEqual(consumed?.messageIds, [message.id]);
});

void test("handover phase commits before message consumption and restart replaces exactly once after a consumption fault", async () => {
  const { store } = controllerFixture();
  store.update({
    phase: "running",
    activeSessionId: "pi-predecessor",
    activeSessionFile: "/pi/predecessor.jsonl",
  });
  const message = store.enqueueMessage("must remain at least once after the fault");
  const consume = store.consumeMessages.bind(store);
  store.consumeMessages = () => {
    throw new RuntimeFixtureError("injected consumption failure");
  };
  assert.throws(
    () => store.persistHandover(1, "pi-predecessor", "/pi/predecessor.jsonl", handover, [message]),
    /injected consumption failure/,
  );
  assert.equal(store.snapshot().phase, "handover_durable");
  assert.deepEqual(
    store.pendingMessages().map((item) => item.id),
    [message.id],
  );
  store.consumeMessages = consume;

  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  await new CycleController(store, "/pi", () => Promise.resolve(host)).run();
  assert.equal(host.replacements, 1);
  const prompt = host.prompts[0];
  assert.ok(prompt !== undefined);
  assert.match(prompt, /must remain at least once after the fault/);
  assert.equal(store.pendingMessages().length, 0);
  assert.equal(store.snapshot().status, "complete");
});

void test("restart adopts an already materialized successor without creating a duplicate", async () => {
  const { store } = controllerFixture();
  const sessionDir = join(store.runDir, "pi-sessions");
  mkdirSync(sessionDir);
  const predecessorFile = join(sessionDir, "1.durable.json");
  const successorFile = join(sessionDir, "2.durable.json");
  writeFileSync(
    successorFile,
    JSON.stringify({
      formatVersion: 1,
      engine: "pi-durable",
      conversationId: 2,
      parentSession: predecessorFile,
    }),
  );
  store.update({
    phase: "running",
    activeSessionId: "pi-predecessor",
    activeSessionFile: predecessorFile,
  });
  store.persistHandover(1, "pi-predecessor", predecessorFile, handover, []);
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  host.sessionId = "pi-existing-successor";
  host.sessionFile = successorFile;
  let opened: string | undefined;
  await new CycleController(store, "/pi", (_manifest, _store, _dir, existing) => {
    opened = existing;
    return Promise.resolve(host);
  }).run();
  assert.equal(opened, successorFile);
  assert.equal(host.replacements, 0);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "successor_session_adopted").length,
    1,
  );
});
