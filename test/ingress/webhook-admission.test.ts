/**
 * Verifies webhook authentication, hostile-input bounds, idempotent task admission, and durable
 * payload exclusion through the installed HTTP service.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { listRuns } from "../../src/durable/index.js";
import {
  AUTH,
  BlockingHost,
  environment,
  jsonRecord,
  post,
  requiredAt,
  start,
  stringField,
  waitFor,
} from "./webhook-support.js";

void test("webhook authenticates before parsing or creating durable state", async () => {
  const { stateRoot } = environment();
  const { service, base } = await start(stateRoot);
  try {
    const response = await fetch(`${base}/v1/webhooks`, { method: "POST", body: "not-json" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
  } finally {
    await service.stop();
  }
});

void test("webhook enforces content type, exact schema, and body and string limits", async () => {
  const { stateRoot } = environment();
  const { service, base } = await start(stateRoot);
  try {
    await assertRejectedBodies(base);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
  } finally {
    await service.stop();
  }
});

async function assertRejectedBodies(base: string): Promise<void> {
  const wrongType = await fetch(`${base}/v1/webhooks`, {
    method: "POST",
    headers: AUTH,
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  const unknownField = await post(base, {
    version: 1,
    eventId: "one",
    source: "http",
    kind: "task",
    task: { task: "safe" },
    extra: true,
  });
  assert.equal(unknownField.status, 400);
  const unknownTaskField = await post(base, {
    version: 1,
    eventId: "nested",
    source: "http",
    kind: "task",
    task: { task: "safe", providerPayload: {} },
  });
  assert.equal(unknownTaskField.status, 400);
  await assertRejectedMessageBodies(base);
}

async function assertRejectedMessageBodies(base: string): Promise<void> {
  const oversized = await post(base, {
    version: 1,
    eventId: "two",
    source: "http",
    kind: "operator_message",
    runId: "missing",
    message: "x".repeat(32_769),
  });
  assert.equal(oversized.status, 400);
  const unsafeControl = await post(base, {
    version: 1,
    eventId: "control",
    source: "http",
    kind: "operator_message",
    runId: "missing",
    message: "before\u0000after",
  });
  assert.equal(unsafeControl.status, 400);
  const oversizedBody = await fetch(`${base}/v1/webhooks`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(256 * 1024) }),
  });
  assert.equal(oversizedBody.status, 413);
}

void test("task webhooks route once, reject collisions, and preserve the single slot", async () => {
  const { workspace, stateRoot } = environment();
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, () => Promise.resolve(host));
  const event = {
    version: 1,
    eventId: "task-event-1",
    source: "monitoring",
    kind: "task",
    task: { task: "task payload marker", role: "maintainer", workspace },
  };
  try {
    const first = await post(base, event);
    const firstBody = await assertFirstDelivery(first);
    await assertDuplicateAndCollision(base, event, firstBody.runId);
    const store = requiredAt(listRuns(stateRoot), 0);
    assert.equal(store.runId, firstBody.runId);
    assert.equal(store.manifest().task, "task payload marker");
    assertReceiptIsPrivate(stateRoot);
    host.complete();
    await waitFor(() => store.snapshot().status === "complete");
    renameSync(workspace, `${workspace}-moved`);
    const lateDuplicate = await post(base, event);
    assert.equal(lateDuplicate.status, 200);
    assert.equal((await jsonRecord(lateDuplicate)).duplicate, true);
  } finally {
    host.complete();
    await service.stop();
  }
});

async function assertFirstDelivery(response: Response): Promise<{ runId: string }> {
  assert.equal(response.status, 202);
  const body = await jsonRecord(response);
  assert.deepEqual(
    { duplicate: body.duplicate, kind: body.kind, status: body.status },
    { duplicate: false, kind: "task", status: "active" },
  );
  return { runId: stringField(body, "runId") };
}

async function assertDuplicateAndCollision(
  base: string,
  event: Record<string, unknown>,
  runId: string,
): Promise<void> {
  const duplicate = await post(base, event);
  assert.equal(duplicate.status, 200);
  const duplicateBody = await jsonRecord(duplicate);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.runId, runId);
  const collision = await post(base, {
    ...event,
    task: { task: "different task" },
  });
  assert.equal(collision.status, 409);
  assert.deepEqual(await collision.json(), { error: "webhook event key collision" });
  const busy = await post(base, { ...event, eventId: "task-event-2" });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: "single worker slot is busy" });
}

function assertReceiptIsPrivate(stateRoot: string): void {
  const receiptRoot = join(stateRoot, "webhook-receipts");
  const receiptFiles = readdirSync(receiptRoot);
  assert.equal(receiptFiles.length, 1);
  assert.equal(statSync(receiptRoot).mode & 0o777, 0o700);
  const receiptPath = join(receiptRoot, requiredAt(receiptFiles, 0));
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(receiptPath, "utf8"), /task payload marker/);
}
