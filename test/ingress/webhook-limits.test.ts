/**
 * Exercises failure privacy, final-budget races, typed terminal authority, lifecycle-log payload
 * exclusion, and bind-before-adoption startup ordering.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { listRuns, RunStore } from "../../src/durable/index.js";
import { SeptService, validateRequest } from "../../src/ingress/index.js";
import {
  AUTH,
  BlockingHost,
  COMPLETE,
  CompletingHost,
  environment,
  jsonRecord,
  post,
  postDirectMessage,
  requiredAt,
  start,
  stringField,
  waitFor,
} from "./webhook-support.js";
import { testModelAccess } from "../support/model-access.js";

void test("webhook routing failures are private and do not reserve event IDs", async () => {
  const { stateRoot } = environment();
  const { service, base } = await start(stateRoot);
  try {
    const marker = "sensitive failure payload marker";
    const response = await post(base, {
      version: 1,
      eventId: "unknown-run-event",
      source: "whatsapp-edge",
      kind: "operator_message",
      runId: "unknown",
      message: marker,
    });
    assert.equal(response.status, 404);
    assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(marker));
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
  } finally {
    await service.stop();
  }
});

void test("the final invocation rejects racing input before durable acceptance", async () => {
  const context = environment();
  const host = new BlockingHost();
  const { service, base } = await start(context.stateRoot, () => Promise.resolve(host));
  try {
    const runId = await createTask(base, {
      task: "one invocation only",
      workspace: context.workspace,
      maxInvocations: 1,
      maxEpochs: 2,
    });
    await waitFor(() => host.prompts.length === 1);
    const message = await postDirectMessage(base, runId, "must not be stranded");
    assert.equal(message.status, 409);
    assert.match(JSON.stringify(await message.json()), /exhausted/);
    const store = requiredAt(listRuns(context.stateRoot), 0);
    assert.equal(store.pendingMessages().length, 0);
    host.complete();
    await waitFor(() => store.snapshot().status === "complete");
    assert.equal(host.prompts.length, 1);
  } finally {
    host.complete();
    await service.stop();
  }
});

void test("the final session epoch rejects input that could be stranded by rotation", async () => {
  const context = environment();
  const host = new BlockingHost();
  const { service, base } = await start(context.stateRoot, () => Promise.resolve(host));
  try {
    const runId = await createTask(base, {
      task: "one epoch only",
      workspace: context.workspace,
      maxInvocations: 2,
      maxEpochs: 1,
    });
    await waitFor(() => host.prompts.length === 1);
    const message = await postDirectMessage(base, runId, "must not be stranded by rotation");
    assert.equal(message.status, 409);
    assert.match(JSON.stringify(await message.json()), /epoch limit/);
    assert.equal(requiredAt(listRuns(context.stateRoot), 0).pendingMessages().length, 0);
    host.complete();
  } finally {
    host.complete();
    await service.stop();
  }
});

void test("typed terminal causes distinguish hard limits from agent blocks", async () => {
  const { workspace, stateRoot } = environment();
  const hard = RunStore.create(
    stateRoot,
    validateRequest({ task: "hard limit", workspace }, "0.85.1"),
  );
  hard.update({
    status: "blocked",
    phase: "terminal",
    reason: "operator can help",
    terminalCause: "timeout",
  });
  const resolvable = RunStore.create(
    stateRoot,
    validateRequest({ task: "resolvable", workspace }, "0.85.1"),
  );
  resolvable.update({
    status: "blocked",
    phase: "terminal",
    reason: "remote dependency timeout reached; credentials needed",
    terminalCause: "agent_blocked",
  });
  const host = new CompletingHost();
  const { service, base } = await start(stateRoot, () => Promise.resolve(host));
  try {
    await assertRunMethodSemantics(base, hard.runId);
    const rejected = await postDirectMessage(base, hard.runId, "cannot exceed the cap");
    assert.equal(rejected.status, 409);
    assert.equal(hard.pendingMessages().length, 0);
    const accepted = await postDirectMessage(base, resolvable.runId, "dependency is now available");
    assert.equal(accepted.status, 202);
    await waitFor(() => resolvable.snapshot().status === "complete");
    assert.match(requiredAt(host.prompts, 0), /dependency is now available/);
  } finally {
    await service.stop();
  }
});

async function assertRunMethodSemantics(base: string, runId: string): Promise<void> {
  const unsupported = await fetch(`${base}/v1/tasks/${runId}/log`, {
    method: "POST",
    headers: AUTH,
  });
  assert.equal(unsupported.status, 405);
  const ignoredQuery = await fetch(`${base}/v1/tasks/${runId}/log?after=bad`, { headers: AUTH });
  assert.equal(ignoredQuery.status, 200);
}

void test("assistant terminal payload is excluded from the public lifecycle log", async () => {
  const { workspace, stateRoot } = environment();
  const marker = "ASSISTANT-CONTROL-SUMMARY-MUST-NOT-BE-LOGGED";
  const host = new CompletingHost();
  host.run = (prompt: string): Promise<typeof COMPLETE> => {
    host.prompts.push(prompt);
    return Promise.resolve({
      ...COMPLETE,
      text: JSON.stringify({
        status: "complete",
        summary: marker,
        verification: [],
        next_action: "",
      }),
    });
  };
  const { service, base } = await start(stateRoot, () => Promise.resolve(host));
  try {
    const runId = await createTask(base, { task: "log safely", workspace });
    await waitFor(() => requiredAt(listRuns(stateRoot), 0).snapshot().status === "complete");
    const log = await fetch(`${base}/v1/tasks/${runId}/log`, { headers: AUTH });
    assert.equal(log.status, 200);
    const text = await log.text();
    assert.doesNotMatch(text, new RegExp(marker));
    assert.match(text, /"textBytes":/);
  } finally {
    await service.stop();
  }
});

void test("bind failure performs no adoption or lease acquisition", async () => {
  const { root, workspace, stateRoot } = environment();
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "must not adopt", workspace }, "0.85.1"),
  );
  const blocker = createServer();
  await new Promise<void>((resolve) => {
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  const attempts = { count: 0 };
  const service = await bindFailureService(root, stateRoot, address.port, attempts);
  try {
    await assert.rejects(
      service.start(),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
    assert.equal(attempts.count, 0);
    assert.equal(store.snapshot().invocations, 0);
    assert.equal(existsSync(join(stateRoot, "worker.lease")), false);
    assert.equal(existsSync(store.leasePath), false);
  } finally {
    await close(blocker);
  }
});

async function bindFailureService(
  workspaceRoot: string,
  stateRoot: string,
  port: number,
  attempts: { count: number },
): Promise<SeptService> {
  return new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot,
    token: "test-token",
    host: "127.0.0.1",
    port,
    piVersion: "0.85.1",
    hostFactory: () => {
      attempts.count++;
      return Promise.resolve(new CompletingHost());
    },
    modelAccessService: await testModelAccess(),
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function createTask(base: string, value: unknown): Promise<string> {
  const response = await fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.equal(response.status, 202);
  return stringField(await jsonRecord(response), "runId");
}
