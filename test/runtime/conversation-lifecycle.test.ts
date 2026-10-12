/**
 * Verifies exact conversation replay across wait, restart, wake, streaming, and queue recovery.
 * Durable conversation storage owns cursors and text; HTTP projections must preserve that evidence.
 */

import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import {
  auth,
  GateHost,
  ResultHost,
  health,
  postJson,
  responseJson,
  serviceEnvironment,
  sessionResponse,
  startService,
  waitFor,
} from "./support.js";

interface ConversationPage {
  events: { type: string; role?: string; text?: string }[];
  nextCursor: number;
  terminal: { status: string } | null;
}

async function assertWaitingReplay(base: string, runId: string, taskText: string): Promise<number> {
  assert.equal((await fetch(`${base}/v1/tasks/${runId}/conversation`)).status, 401);
  const replay = await fetch(`${base}/v1/tasks/${runId}/conversation?limit=250`, { headers: auth });
  const page = await responseJson<ConversationPage>(replay);
  assert.equal(page.events[0]?.text, taskText);
  assert.deepEqual(
    page.events.map((event) => event.type),
    ["message", "message", "state"],
  );
  assert.equal(page.events[1]?.text, "I am waiting for your follow-up.");
  assert.equal(page.terminal, null);
  return page.nextCursor;
}

async function runWaitingPhase(
  root: string,
  workspace: string,
  stateRoot: string,
): Promise<{
  runId: string;
  cursor: number;
}> {
  const host = new ResultHost([sessionResponse("waiting", "I am waiting for your follow-up.")]);
  const started = await startService(root, stateRoot, () => Promise.resolve(host));
  try {
    const taskText = "  exact initial text\nwith a second line  ";
    const task = await postJson(`${started.base}/v1/tasks`, { task: taskText, workspace });
    const { runId } = await responseJson<{ runId: string }>(task);
    await waitFor(async () => (await health(started.base)).worker === "waiting");
    const cursor = await assertWaitingReplay(started.base, runId, taskText);
    const streaming = fetch(`${started.base}/v1/tasks/${runId}/stream?after=${String(cursor)}`, {
      headers: auth,
    }).then((response) => response.text());
    await new Promise((resolve) => setTimeout(resolve, 25));
    await started.service.stop();
    assert.match(await streaming, /event: disconnect[\s\S]*server_shutdown/);
    return { runId, cursor };
  } finally {
    await started.service.stop();
  }
}

async function assertCompletionReplay(response: Response, exact: string): Promise<void> {
  const page = await responseJson<ConversationPage>(response);
  assert.equal(page.events.find((event) => event.role === "user")?.text, exact);
  assert.equal(
    page.events.find((event) => event.role === "assistant")?.text,
    "The follow-up is complete.",
  );
  assert.equal(page.terminal?.status, "complete");
}

async function assertLateCancellationAndSafeLog(
  base: string,
  stateRoot: string,
  runId: string,
): Promise<void> {
  const late = await fetch(`${base}/v1/tasks/${runId}/cancel`, { method: "POST", headers: auth });
  assert.deepEqual(await responseJson<unknown>(late), {
    runId,
    status: "complete",
    cancelled: false,
  });
  assert.doesNotMatch(
    readFileSync(join(stateRoot, runId, "agent.log"), "utf8"),
    /follow-up is complete|preserve this follow-up/,
  );
}

async function runCompletionPhase(
  root: string,
  stateRoot: string,
  runId: string,
  cursor: number,
): Promise<void> {
  const host = new ResultHost([sessionResponse("complete", "The follow-up is complete.")]);
  const started = await startService(root, stateRoot, () => Promise.resolve(host));
  try {
    assert.equal((await health(started.base)).worker, "waiting");
    const live = fetch(`${started.base}/v1/tasks/${runId}/stream?after=${String(cursor)}`, {
      headers: auth,
    }).then((response) => response.text());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const exact = "  preserve this follow-up\t\nexactly  ";
    assert.equal(
      (await postJson(`${started.base}/v1/tasks/${runId}/messages`, { message: exact })).status,
      202,
    );
    assert.match(await live, /event: message[\s\S]*event: terminal/);
    const replay = await fetch(
      `${started.base}/v1/tasks/${runId}/conversation?after=${String(cursor)}&limit=250`,
      { headers: auth },
    );
    await assertCompletionReplay(replay, exact);
    await assertLateCancellationAndSafeLog(started.base, stateRoot, runId);
  } finally {
    await started.service.stop();
  }
}

void test("conversation replay and SSE reconnect preserve exact text across wait, restart, wake, and completion", async () => {
  const { root, workspace, stateRoot } = serviceEnvironment();
  const { runId, cursor } = await runWaitingPhase(root, workspace, stateRoot);
  await runCompletionPhase(root, stateRoot, runId, cursor);
});

function projectionCount(store: RunStore, messageId: string): number {
  return store
    .events(0, 1000)
    .filter(
      (event) => event.type === "operator_conversation_recorded" && event.messageId === messageId,
    ).length;
}

async function assertInitialProjection(
  store: RunStore,
  exact: string,
  messageId: string,
  host: GateHost,
): Promise<void> {
  await waitFor(() => host.prompts.length === 1);
  const userMessages = store
    .conversation(0, 250)
    .events.filter(
      (event): event is Extract<typeof event, { type: "message" }> =>
        event.type === "message" && event.role === "user",
    );
  assert.equal(userMessages.find((event) => event.id === `operator-${messageId}`)?.text, exact);
  assert.equal(projectionCount(store, messageId), 1);
  const prompt = host.prompts[0];
  assert.ok(prompt !== undefined);
  assert.match(prompt, /accepted before the projection crash/);
}

void test("restart reconciles a durable operator queue crash before conversation projection", async () => {
  const { root, workspace, stateRoot } = serviceEnvironment();
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "recover queued conversation", workspace }, "0.85.1"),
  );
  const exact = "  accepted before the projection crash\nexactly  ";
  const message = { id: "crash-seam-message", createdAt: new Date().toISOString(), text: exact };
  appendFileSync(store.messagesPath, `${JSON.stringify(message)}\n`);
  store.event("operator_message_queued", { messageId: message.id });
  const host = new GateHost();
  const started = await startService(root, stateRoot, () => Promise.resolve(host));
  try {
    await assertInitialProjection(store, exact, message.id, host);
  } finally {
    host.complete();
    await started.service.stop();
  }
  const restarted = await startService(root, stateRoot);
  try {
    assert.equal(
      store.conversation(0, 250).events.filter((event) => event.id === `operator-${message.id}`)
        .length,
      1,
    );
    assert.equal(projectionCount(store, message.id), 1);
  } finally {
    await restarted.service.stop();
  }
});
