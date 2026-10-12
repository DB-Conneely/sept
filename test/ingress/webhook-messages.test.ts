/**
 * Verifies operator-message admission, slot authority, exact text preservation, and idempotent
 * webhook recovery without duplicating durable queue evidence.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { listRuns, RunStore } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import { validateWebhookEvent, webhookHashes, WebhookReceipts } from "../../src/ingress/webhook.js";
import {
  BlockingHost,
  CompletingHost,
  environment,
  jsonRecord,
  post,
  postDirectMessage,
  requiredAt,
  start,
  stringField,
  waitFor,
  waitForIdle,
} from "./webhook-support.js";

void test("messages cannot activate a blocked run while another run owns the slot", async () => {
  const { workspace, stateRoot } = environment();
  const blocked = blockedRun(stateRoot, workspace, "blocked target");
  const active = RunStore.create(
    stateRoot,
    validateRequest({ task: "slot owner", workspace }, "0.85.1"),
  );
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, () => Promise.resolve(host));
  try {
    await waitFor(() => host.prompts.length === 1);
    const direct = await postDirectMessage(base, blocked.runId, "direct message must wait");
    assert.equal(direct.status, 409);
    assert.deepEqual(await direct.json(), {
      error: "single worker slot is busy; retry the message when idle",
    });
    await assertBusyWebhook(base, blocked.runId);
    assert.equal(blocked.snapshot().status, "blocked");
    assert.equal(blocked.pendingMessages().length, 0);
    assert.equal(queuedEvents(blocked), 0);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
    host.complete();
    await waitFor(() => active.snapshot().status === "complete");
    await waitForIdle(base);
    const retry = await post(base, busyEvent(blocked.runId));
    assert.equal(retry.status, 202);
    await waitFor(() => blocked.snapshot().status === "complete");
  } finally {
    host.complete();
    await service.stop();
  }
});

async function assertBusyWebhook(base: string, runId: string): Promise<void> {
  const webhook = await post(base, busyEvent(runId));
  assert.equal(webhook.status, 409);
  assert.deepEqual(await webhook.json(), {
    error: "single worker slot is busy; retry the message when idle",
  });
}

function busyEvent(runId: string): Record<string, unknown> {
  return {
    version: 1,
    eventId: "busy-blocked-target",
    source: "slack-edge",
    kind: "operator_message",
    runId,
    message: "webhook message must wait",
  };
}

void test("same-run settlement cannot reopen a blocked run before its slot clears", async () => {
  const { workspace, stateRoot } = environment();
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "settling owner", workspace }, "0.85.1"),
  );
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, () => Promise.resolve(host));
  try {
    await waitFor(() => host.prompts.length === 1);
    store.update({ status: "blocked", phase: "terminal", reason: "controller is settling" });
    const direct = await postDirectMessage(base, store.runId, "must retry after settlement");
    assert.equal(direct.status, 409);
    assert.equal(store.snapshot().status, "blocked");
    assert.equal(store.pendingMessages().length, 0);
    const webhook = await post(base, {
      ...busyEvent(store.runId),
      eventId: "same-run-settlement",
      source: "telegram-edge",
    });
    assert.equal(webhook.status, 409);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
    host.complete();
    await waitFor(() => store.snapshot().status === "complete");
  } finally {
    host.complete();
    await service.stop();
  }
});

void test("normal multiline operator messages retain tabs and line breaks", async () => {
  const { workspace, stateRoot } = environment();
  const store = blockedRun(stateRoot, workspace, "await multiline direction");
  const host = new CompletingHost();
  const { service, base } = await start(stateRoot, () => Promise.resolve(host));
  const message = "first line\n\tindented second line\r\nthird line";
  try {
    const response = await post(base, {
      version: 1,
      eventId: "multiline-message",
      source: "telegram-edge",
      kind: "operator_message",
      runId: store.runId,
      message,
    });
    assert.equal(response.status, 202);
    await waitFor(() => store.snapshot().status === "complete");
    assert.match(
      requiredAt(host.prompts, 0),
      /first line\\n\\tindented second line\\r\\nthird line/,
    );
    assert.equal(queuedEvents(store), 1);
  } finally {
    await service.stop();
  }
});

void test("hidden temporary run directories cannot be adopted", () => {
  const { workspace, stateRoot } = environment();
  const temporary = join(stateRoot, ".creating-interrupted");
  mkdirSync(temporary, { recursive: true });
  const manifest = {
    ...validateRequest({ task: "must not run", workspace }, "0.85.1"),
    runId: "hidden-run",
    createdAt: new Date().toISOString(),
  };
  const timestamp = new Date().toISOString();
  const snapshot = {
    status: "active",
    phase: "ready",
    epoch: 1,
    invocations: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(temporary, "state.json"), `${JSON.stringify(snapshot)}\n`);
  assert.deepEqual(listRuns(stateRoot), []);
});

void test("a pending receipt resumes routing after interrupted task delivery", async () => {
  const { workspace, stateRoot } = environment();
  const event = {
    version: 1,
    eventId: "interrupted-task",
    source: "http-edge",
    kind: "task",
    task: { task: "resume safely", workspace },
  };
  const validated = validateWebhookEvent(event);
  const hashes = webhookHashes(validated);
  const claim = new WebhookReceipts(stateRoot).claim(
    hashes.keyHash,
    hashes.eventHash,
    validated.kind,
  );
  assert.equal(claim.created, true);
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, () => Promise.resolve(host));
  try {
    const retry = await post(base, event);
    assert.equal(retry.status, 200);
    const result = await jsonRecord(retry);
    assert.equal(result.duplicate, true);
    assert.equal(typeof result.runId, "string");
    const store = requiredAt(listRuns(stateRoot), 0);
    assert.equal(store.runId, result.runId);
    host.complete();
    await waitFor(() => store.snapshot().status === "complete");
  } finally {
    host.complete();
    await service.stop();
  }
});

void test("operator webhook wakes once and remains duplicate after restart", async () => {
  const { workspace, stateRoot } = environment();
  const store = blockedRun(stateRoot, workspace, "await direction");
  const host = new CompletingHost();
  const event = messageEvent(store.runId);
  const firstServer = await start(stateRoot, () => Promise.resolve(host));
  let messageId = "";
  try {
    const first = await post(firstServer.base, event);
    assert.equal(first.status, 202);
    const firstBody = await jsonRecord(first);
    assert.equal(firstBody.duplicate, false);
    messageId = stringField(firstBody, "messageId");
    await waitFor(() => store.snapshot().status === "complete");
    assert.match(requiredAt(host.prompts, 0), /operator payload marker/);
    await assertDuplicateMessage(firstServer.base, event, messageId, store);
    assertPrivateMessageReceipt(stateRoot);
  } finally {
    await firstServer.service.stop();
  }
  await assertRestartDuplicate(stateRoot, event, messageId);
});

async function assertDuplicateMessage(
  base: string,
  event: Record<string, unknown>,
  messageId: string,
  store: RunStore,
): Promise<void> {
  const duplicate = await post(base, event);
  assert.equal(duplicate.status, 200);
  const body = await jsonRecord(duplicate);
  assert.equal(body.duplicate, true);
  assert.equal(body.messageId, messageId);
  assert.equal(queuedEvents(store), 1);
  const collision = await post(base, { ...event, message: "changed message" });
  assert.equal(collision.status, 409);
  assert.doesNotMatch(JSON.stringify(await collision.json()), /changed message/);
}

async function assertRestartDuplicate(
  stateRoot: string,
  event: Record<string, unknown>,
  messageId: string,
): Promise<void> {
  let hostCreations = 0;
  const server = await start(stateRoot, () => {
    hostCreations++;
    return Promise.resolve(new CompletingHost());
  });
  try {
    const retry = await post(server.base, event);
    assert.equal(retry.status, 200);
    const body = await jsonRecord(retry);
    assert.equal(body.duplicate, true);
    assert.equal(body.messageId, messageId);
    assert.equal(hostCreations, 0);
  } finally {
    await server.service.stop();
  }
}

function blockedRun(stateRoot: string, workspace: string, task: string): RunStore {
  const store = RunStore.create(stateRoot, validateRequest({ task, workspace }, "0.85.1"));
  store.update({ status: "blocked", phase: "terminal", reason: "operator direction required" });
  return store;
}

function queuedEvents(store: RunStore): number {
  return store.events(0, 1000).filter((event) => event.type === "operator_message_queued").length;
}

function messageEvent(runId: string): Record<string, unknown> {
  return {
    version: 1,
    eventId: "message-event-1",
    source: "slack-edge",
    kind: "operator_message",
    runId,
    message: "operator payload marker",
  };
}

function assertPrivateMessageReceipt(stateRoot: string): void {
  const root = join(stateRoot, "webhook-receipts");
  const receipt = readFileSync(join(root, requiredAt(readdirSync(root), 0)), "utf8");
  assert.doesNotMatch(receipt, /operator payload marker/);
}
