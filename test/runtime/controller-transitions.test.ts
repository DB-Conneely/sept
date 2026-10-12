/**
 * Verifies CycleController terminal, waiting, deadline, and late-message transitions. The durable
 * store remains the authority, while scripted native hosts expose race orderings deterministically.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../../src/durable/index.js";
import { CycleController } from "../../src/runtime/index.js";
import { complete, FakeHost, handover, waiting, controllerFixture } from "./support.js";

void test("operator input accepted during a completing invocation is delivered before terminal completion", async () => {
  const { store } = controllerFixture();
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
    { text: JSON.stringify(complete), steered: false, contextTokens: 11, contextWindow: 100 },
  ]);
  const run = host.run.bind(host);
  let lateMessage: ReturnType<RunStore["enqueueMessage"]> | undefined;
  host.run = (prompt: string) => {
    lateMessage ??= store.enqueueMessage("accepted just before complete returned");
    return run(prompt);
  };

  await new CycleController(store, "/pi", () => Promise.resolve(host)).run();

  assert.equal(store.snapshot().status, "complete");
  assert.equal(host.prompts.length, 2);
  assert.equal(host.replacements, 0);
  const firstPrompt = host.prompts[0];
  const secondPrompt = host.prompts[1];
  assert.ok(firstPrompt !== undefined && secondPrompt !== undefined);
  assert.doesNotMatch(firstPrompt, /accepted just before complete returned/);
  assert.match(secondPrompt, /accepted just before complete returned/);
  assert.equal(store.pendingMessages().length, 0);
  const events = store.events(0, 1000);
  assert.equal(events.filter((event) => event.type === "terminal_status_deferred").length, 1);
  const invocations = events.filter((event) => event.type === "pi_invocation_started");
  const firstInvocation = invocations[0];
  const secondInvocation = invocations[1];
  assert.ok(firstInvocation !== undefined && secondInvocation !== undefined);
  assert.deepEqual(firstInvocation.messageIds, []);
  assert.deepEqual(secondInvocation.messageIds, [lateMessage?.id]);
  assert.equal(events.filter((event) => event.type === "run_completed").length, 1);
});

void test("waiting durably checkpoints and releases Pi without another invocation", async () => {
  const { store } = controllerFixture();
  const host = new FakeHost([
    { text: JSON.stringify(waiting), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);

  await new CycleController(store, "/pi", () => Promise.resolve(host)).run();

  assert.equal(store.snapshot().status, "waiting");
  assert.equal(store.snapshot().phase, "waiting");
  assert.equal(store.snapshot().activeSessionId, "pi-predecessor");
  assert.equal(store.snapshot().activeSessionFile, undefined);
  assert.equal(host.prompts.length, 1);
  assert.equal(existsSync(store.leasePath), false);
  const events = store.events(0, 1000);
  assert.ok(
    events.findIndex((event) => event.type === "work_checkpoint") <
      events.findIndex((event) => event.type === "run_waiting"),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.prompts.length, 1);
});

void test("operator input arriving during a waiting decision prevents the lost wakeup", async () => {
  const { store } = controllerFixture();
  const host = new FakeHost([
    { text: JSON.stringify(waiting), steered: false, contextTokens: 10, contextWindow: 100 },
    { text: JSON.stringify(complete), steered: false, contextTokens: 11, contextWindow: 100 },
  ]);
  const run = host.run.bind(host);
  host.run = async (prompt: string) => {
    const result = await run(prompt);
    if (host.prompts.length === 1) store.enqueueMessage("wake at the waiting seam");
    return result;
  };

  await new CycleController(store, "/pi", () => Promise.resolve(host)).run();

  assert.equal(store.snapshot().status, "complete");
  assert.equal(host.prompts.length, 2);
  const prompt = host.prompts[1];
  assert.ok(prompt !== undefined);
  assert.match(prompt, /wake at the waiting seam/);
  assert.equal(store.pendingMessages().length, 0);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "waiting_status_deferred").length,
    1,
  );
  assert.equal(store.events(0, 1000).filter((event) => event.type === "run_waiting").length, 0);
});

void test("dormant wall-clock age does not exhaust active execution time", async () => {
  const { store } = controllerFixture();
  store.update({
    phase: "ready",
    activeSessionId: "pi-existing",
    activeSessionFile: "/pi/existing.jsonl",
    startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    activeMilliseconds: 0,
  });
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  host.sessionId = "pi-existing";
  host.sessionFile = "/pi/existing.jsonl";

  await new CycleController(store, "/pi", () => Promise.resolve(host)).run();

  assert.equal(store.snapshot().status, "complete");
  assert.equal(host.prompts.length, 1);
});

void test("oversized assistant control is rejected without persisting unreadable state", async () => {
  const { store } = controllerFixture();
  const host = new FakeHost([
    {
      text: JSON.stringify({
        status: "complete",
        summary: "x".repeat(65_537),
        verification: [],
        next_action: "",
      }),
      steered: false,
      contextTokens: 10,
      contextWindow: 100,
    },
  ]);

  await assert.rejects(
    new CycleController(store, "/pi", () => Promise.resolve(host)).run(),
    /summary must be a string/,
  );

  const snapshot = store.snapshot();
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.phase, "terminal");
  assert.equal(snapshot.terminalCause, "controller_failure");
  assert.equal(store.events(0, 1000).filter((event) => event.type === "work_checkpoint").length, 0);
});

void test("invocation cap is strict", async () => {
  const { store } = controllerFixture();
  const manifest = store.manifest();
  const capped = { ...manifest, maxInvocations: 1 };
  const { runId: _runId, createdAt: _createdAt, ...withoutGenerated } = capped;
  const second = RunStore.create(join(store.runDir, "..", "capped"), withoutGenerated);
  const host = new FakeHost([
    {
      text: JSON.stringify({ ...complete, status: "continue", next_action: "again" }),
      steered: false,
      contextTokens: 1,
      contextWindow: 100,
    },
  ]);
  await assert.rejects(
    new CycleController(second, "/pi", () => Promise.resolve(host)).run(),
    /Maximum Pi invocations/,
  );
  assert.equal(host.prompts.length, 1);
  assert.equal(second.snapshot().status, "blocked");
  assert.equal(second.snapshot().terminalCause, "invocation_limit");
});

void test("epoch cap blocks after durable handover without creating a successor", async () => {
  const { store } = controllerFixture();
  const manifest = store.manifest();
  const {
    runId: _runId,
    createdAt: _createdAt,
    ...withoutGenerated
  } = { ...manifest, maxEpochs: 1 };
  const capped = RunStore.create(join(store.runDir, "..", "epoch-capped"), withoutGenerated);
  const host = new FakeHost([
    { text: JSON.stringify(handover), steered: true, contextTokens: 90, contextWindow: 100 },
  ]);
  await assert.rejects(
    new CycleController(capped, "/pi", () => Promise.resolve(host)).run(),
    /Maximum Pi session epochs/,
  );
  assert.equal(host.replacements, 0);
  assert.equal(capped.snapshot().status, "blocked");
  assert.equal(capped.snapshot().terminalCause, "epoch_limit");
  assert.equal(
    capped.events(0, 1000).filter((event) => event.type === "handover_written").length,
    1,
  );
});
