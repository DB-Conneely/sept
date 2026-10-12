/**
 * Verifies strict conversation cursor, retention, stream-capacity, and backpressure bounds. Durable
 * storage owns replay validity; ingress must fail closed rather than emit partial or ambiguous data.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_CONVERSATION_EVENTS,
  RunStore,
  validateWorkResponse,
} from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import {
  auth,
  postJson,
  responseJson,
  ResultHost,
  serviceEnvironment,
  sessionResponse,
  startService,
  waitFor,
} from "./support.js";

async function assertInvalidCursors(
  base: string,
  runId: string,
  terminalCursor: number,
): Promise<void> {
  const queries = [
    "after=-1",
    "after=1junk",
    "after=1.5",
    "after=",
    "after=0&after=0",
    "limit=0",
    "limit=251",
    "limit=2x",
    `after=${String(terminalCursor + 1)}`,
  ];
  for (const query of queries) {
    const result = await fetch(`${base}/v1/tasks/${runId}/conversation?${query}`, {
      headers: auth,
    });
    assert.equal(result.status, 400, query);
  }
  const stream = await fetch(`${base}/v1/tasks/${runId}/stream?after=1junk`, { headers: auth });
  assert.equal(stream.status, 400);
}

void test("conversation cursors are strict and terminal metadata remains authoritative", async () => {
  const { root, workspace, stateRoot } = serviceEnvironment();
  const host = new ResultHost([sessionResponse("complete", "Terminal replay is complete.")]);
  const started = await startService(root, stateRoot, () => Promise.resolve(host));
  try {
    const task = await postJson(`${started.base}/v1/tasks`, {
      task: "strict terminal replay",
      workspace,
    });
    const { runId } = await responseJson<{ runId: string }>(task);
    await waitFor(() => new RunStore(join(stateRoot, runId)).snapshot().status === "complete");
    const full = await fetch(`${started.base}/v1/tasks/${runId}/conversation?limit=250`, {
      headers: auth,
    });
    const { nextCursor } = await responseJson<{ nextCursor: number }>(full);
    const replay = await fetch(
      `${started.base}/v1/tasks/${runId}/conversation?after=${String(nextCursor)}&limit=1`,
      { headers: auth },
    );
    const terminal = await responseJson<{ events: unknown[]; terminal: { status: string } }>(
      replay,
    );
    assert.deepEqual(terminal.events, []);
    assert.equal(terminal.terminal.status, "complete");
    const stream = await fetch(
      `${started.base}/v1/tasks/${runId}/stream?after=${String(nextCursor)}`,
      { headers: auth },
    );
    assert.match(
      await stream.text(),
      /"reason":"terminal"[\s\S]*"terminal":\{"status":"complete"\}/,
    );
    await assertInvalidCursors(started.base, runId, nextCursor);
  } finally {
    await started.service.stop();
  }
});

void test("SSE rejects expired replay", async () => {
  const environment = serviceEnvironment();
  const store = RunStore.create(
    environment.stateRoot,
    validateRequest({ task: "expire replay", workspace: environment.workspace }, "0.85.1"),
  );
  store.update({ status: "waiting", phase: "waiting", reason: "hold" });
  for (let index = 0; index < MAX_CONVERSATION_EVENTS + 2; index += 1) {
    store.conversationMessage(`expired-${String(index)}`, "assistant", `event ${String(index)}`);
  }
  const started = await startService(environment.root, environment.stateRoot);
  try {
    const conversation = await fetch(
      `${started.base}/v1/tasks/${store.runId}/conversation?after=0`,
      { headers: auth },
    );
    const stream = await fetch(`${started.base}/v1/tasks/${store.runId}/stream?after=0`, {
      headers: auth,
    });
    assert.equal(conversation.status, 410);
    assert.equal(stream.status, 410);
  } finally {
    await started.service.stop();
  }
});

void test("SSE closes replay on bounded backpressure", async () => {
  const environment = serviceEnvironment();
  const store = RunStore.create(
    environment.stateRoot,
    validateRequest({ task: "backpressure replay", workspace: environment.workspace }, "0.85.1"),
  );
  store.update({ status: "waiting", phase: "waiting", reason: "hold" });
  for (let index = 0; index < 120; index += 1) {
    store.conversationMessage(
      `pressure-${String(index)}`,
      "assistant",
      `${String(index)}:${"x".repeat(20_000)}`,
    );
  }
  const started = await startService(environment.root, environment.stateRoot);
  try {
    const stream = await fetch(`${started.base}/v1/tasks/${store.runId}/stream?after=0`, {
      headers: auth,
    });
    assert.match(await stream.text(), /"reason":"backpressure"/);
  } finally {
    await started.service.stop();
  }
});

void test("SSE enforces stream capacity", async () => {
  const environment = serviceEnvironment();
  const store = RunStore.create(
    environment.stateRoot,
    validateRequest({ task: "stream capacity", workspace: environment.workspace }, "0.85.1"),
  );
  store.update({ status: "waiting", phase: "waiting", reason: "hold" });
  const started = await startService(environment.root, environment.stateRoot);
  const streams: Response[] = [];
  try {
    for (let index = 0; index < 32; index += 1) {
      const stream = await fetch(`${started.base}/v1/tasks/${store.runId}/stream?after=0`, {
        headers: auth,
      });
      assert.equal(stream.status, 200);
      streams.push(stream);
    }
    const overflow = await fetch(`${started.base}/v1/tasks/${store.runId}/stream?after=0`, {
      headers: auth,
    });
    assert.equal(overflow.status, 409);
  } finally {
    await Promise.all(streams.map((stream) => stream.body?.cancel() ?? Promise.resolve()));
    await started.service.stop();
  }
});

void test("conversation retention expires old cursors and assistant filtering fails closed", () => {
  const { workspace, stateRoot } = serviceEnvironment();
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "retention", workspace }, "0.85.1"),
  );
  for (let index = 0; index < MAX_CONVERSATION_EVENTS + 2; index += 1) {
    store.conversationMessage(
      `assistant-retention-${String(index)}`,
      "assistant",
      `safe update ${String(index)}`,
    );
  }
  assert.ok(store.conversation(MAX_CONVERSATION_EVENTS, 250).events.length > 0);
  assert.throws(() => store.conversation(0, 10), /cursor expired/);
  assert.ok(readFileSync(store.conversationPath).byteLength <= 4 * 1024 * 1024);
  assert.throws(
    () =>
      validateWorkResponse({
        message: "Authorization: Bearer exposed-secret",
        control: { status: "complete", summary: "done", verification: [], next_action: "" },
      }),
    /safe conversation filter/,
  );
  assert.equal(existsSync(store.conversationPath), true);
});
