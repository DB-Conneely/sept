/**
 * Verifies exact operator text, strict request schemas, canonical workspace confinement, restart
 * adoption safety, and bounded message-queue backpressure.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_PENDING_MESSAGES, RunStore } from "../../src/durable/index.js";
import { SeptService, validateRequest } from "../../src/ingress/index.js";
import {
  AUTH,
  BlockingHost,
  CompletingHost,
  environment,
  jsonRecord,
  post,
  postDirectMessage,
  start,
  stringField,
  waitFor,
} from "./webhook-support.js";
import { testModelAccess } from "../support/model-access.js";

void test("validation preserves edge whitespace and rejects schema/control mismatches", async () => {
  const { workspace, stateRoot } = environment();
  const outside = mkdtempSync(join(tmpdir(), "sept-workspace-escape-"));
  const link = join(workspace, "escape");
  symlinkSync(outside, link);
  const directStore = blockedRun(stateRoot, workspace, "direct exact");
  const webhookStore = blockedRun(stateRoot, workspace, "webhook exact");
  const hosts = [new CompletingHost(), new CompletingHost()];
  const { service, base } = await start(stateRoot, () => {
    const host = hosts.shift();
    assert.ok(host);
    return Promise.resolve(host);
  });
  const exactDirect = "  direct edge\t\n";
  const exactWebhook = "\n\twebhook edge  ";
  try {
    await assertRejectedDirectRequests(base, workspace, link, directStore.runId);
    const direct = await postDirectMessage(base, directStore.runId, exactDirect);
    assert.equal(direct.status, 202);
    const directId = stringField(await jsonRecord(direct), "messageId");
    await waitFor(() => directStore.snapshot().status === "complete");
    assert.equal(directStore.operatorMessage(directId)?.text, exactDirect);
    await assertExactWebhook(base, webhookStore, exactWebhook);
  } finally {
    await service.stop();
  }
});

async function assertRejectedDirectRequests(
  base: string,
  workspace: string,
  escape: string,
  runId: string,
): Promise<void> {
  const requests = [
    { task: "x", workspace, typo: true },
    { task: "x", workspace: join(workspace, "missing") },
    { task: "x", workspace: escape },
    { task: "bad\u0000task", workspace },
  ];
  for (const value of requests) {
    assert.equal((await taskRequest(base, value)).status, 400);
  }
  const unknownMessage = await fetch(`${base}/v1/tasks/${runId}/messages`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "valid", extra: true }),
  });
  assert.equal(unknownMessage.status, 400);
  assert.equal((await postDirectMessage(base, runId, "bad\u0000message")).status, 400);
}

async function assertExactWebhook(
  base: string,
  store: RunStore,
  exactWebhook: string,
): Promise<void> {
  const webhook = await post(base, {
    version: 1,
    eventId: "exact-edge",
    source: "edge",
    kind: "operator_message",
    runId: store.runId,
    message: exactWebhook,
  });
  assert.equal(webhook.status, 202);
  const messageId = stringField(await jsonRecord(webhook), "messageId");
  await waitFor(() => store.snapshot().status === "complete");
  assert.equal(store.operatorMessage(messageId)?.text, exactWebhook);
}

void test("workspace confinement rejects files, outside paths, and symlink escapes", async () => {
  const { root, workspace, stateRoot } = environment();
  const assignedRoot = join(root, "assigned");
  const assigned = join(assignedRoot, "repo");
  const outside = join(root, "outside");
  mkdirSync(assigned, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(assignedRoot, "file"), "not a directory");
  symlinkSync(outside, join(assignedRoot, "escape"));
  const service = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: assignedRoot,
    token: "test-token",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    hostFactory: () => Promise.resolve(new BlockingHost()),
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  const base = `http://${address.host}:${String(address.port)}`;
  try {
    const candidates = [
      workspace,
      outside,
      join(assignedRoot, "file"),
      join(assignedRoot, "escape"),
    ];
    for (const candidate of candidates) {
      const response = await taskRequest(base, { task: "reject path", workspace: candidate });
      assert.equal(response.status, 400, candidate);
    }
  } finally {
    await service.stop();
  }
});

void test("restart adoption rejects a workspace symlink escape before host creation", async () => {
  const { root, stateRoot } = environment();
  const assignedRoot = join(root, "assigned");
  const assigned = join(assignedRoot, "repo");
  const outside = join(root, "outside-adoption");
  const escape = join(assignedRoot, "escape-adoption");
  mkdirSync(assigned, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, escape);
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "resident escape", workspace: assigned }, "0.85.1"),
  );
  const manifest: unknown = JSON.parse(readFileSync(store.manifestPath, "utf8"));
  assert.ok(isRecord(manifest));
  writeFileSync(store.manifestPath, `${JSON.stringify({ ...manifest, workspace: escape })}\n`);
  let creations = 0;
  const service = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: assignedRoot,
    token: "test-token",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    hostFactory: () => {
      creations++;
      return Promise.resolve(new CompletingHost());
    },
    modelAccessService: await testModelAccess(),
  });
  await assert.rejects(service.start(), /outside the configured workspace root/);
  assert.equal(creations, 0);
  assert.equal(store.snapshot().invocations, 0);
  assert.equal(existsSync(join(stateRoot, "worker.lease")), false);
});

void test("queue saturation returns capacity without mutating lifecycle state", async () => {
  const { workspace, stateRoot } = environment();
  const store = blockedRun(stateRoot, workspace, "bounded queue");
  for (let index = 0; index < MAX_PENDING_MESSAGES; index++) {
    store.enqueueMessage(`queued-${String(index)}`);
  }
  const { service, base } = await start(stateRoot);
  try {
    const response = await postDirectMessage(base, store.runId, "one too many");
    assert.equal(response.status, 429);
    assert.equal(store.snapshot().status, "blocked");
    assert.equal(store.pendingMessages().length, MAX_PENDING_MESSAGES);
  } finally {
    await service.stop();
  }
});

function blockedRun(stateRoot: string, workspace: string, task: string): RunStore {
  const store = RunStore.create(stateRoot, validateRequest({ task, workspace }, "0.85.1"));
  store.update({
    status: "blocked",
    phase: "terminal",
    reason: "input needed",
    terminalCause: "agent_blocked",
  });
  return store;
}

function taskRequest(base: string, value: unknown): Promise<Response> {
  return fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
