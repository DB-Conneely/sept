/**
 * Verifies durable drain authority for active and waiting resident runs. The authenticated service
 * is the admission boundary; WorkerRuntime owns readiness transitions and durable settlement.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import {
  auth,
  GateHost,
  health,
  parseWorkerReadiness,
  postJson,
  responseJson,
  serviceEnvironment,
  startService,
  waitFor,
} from "./support.js";

async function beginDrain(
  base: string,
  workspace: string,
  stateRoot: string,
  host: GateHost,
): Promise<string> {
  const task = await postJson(`${base}/v1/tasks`, { task: "drain this active task", workspace });
  const { runId } = await responseJson<{ runId: string }>(task);
  await waitFor(() => host.prompts.length === 1);
  const queued = await postJson(`${base}/v1/tasks/${runId}/messages`, {
    message: "queued before drain",
  });
  assert.equal(queued.status, 202);
  assert.equal((await fetch(`${base}/v1/drain`, { method: "POST" })).status, 401);
  const drain = await fetch(`${base}/v1/drain`, { method: "POST", headers: auth });
  assert.equal(drain.status, 202);
  assert.equal((await responseJson<{ readiness: string }>(drain)).readiness, "draining");
  const repeat = await fetch(`${base}/v1/drain`, { method: "POST", headers: auth });
  assert.equal((await responseJson<{ readiness: string }>(repeat)).readiness, "draining");
  const durable = parseWorkerReadiness(readFileSync(join(stateRoot, "worker-state.json"), "utf8"));
  assert.equal(durable.readiness, "draining");
  return runId;
}

async function assertDrainRejectsAdmission(
  base: string,
  workspace: string,
  runId: string,
): Promise<void> {
  assert.equal(
    (await postJson(`${base}/v1/tasks`, { task: "must be rejected", workspace })).status,
    409,
  );
  assert.equal(
    (await postJson(`${base}/v1/tasks/${runId}/messages`, { message: "too late" })).status,
    409,
  );
  const webhook = await postJson(`${base}/v1/webhooks`, {
    version: 1,
    eventId: "late",
    source: "test",
    kind: "operator_message",
    runId,
    message: "also too late",
  });
  assert.equal(webhook.status, 409);
}

async function settleDrain(
  base: string,
  stateRoot: string,
  runId: string,
  host: GateHost,
): Promise<void> {
  host.complete();
  await waitFor(async () => (await health(base)).readiness === "drained");
  assert.equal(host.prompts.length, 2, "input accepted before drain must be delivered");
  const prompt = host.prompts[1];
  assert.ok(prompt !== undefined);
  assert.match(prompt, /queued before drain/);
  assert.equal(new RunStore(join(stateRoot, runId)).snapshot().status, "complete");
}

void test("authenticated drain is durable, idempotent, rejects admission, and settles preaccepted input before restart", async () => {
  const { root, workspace, stateRoot } = serviceEnvironment();
  const host = new GateHost();
  const first = await startService(root, stateRoot, () => Promise.resolve(host));
  try {
    const runId = await beginDrain(first.base, workspace, stateRoot, host);
    await assertDrainRejectsAdmission(first.base, workspace, runId);
    await settleDrain(first.base, stateRoot, runId, host);
  } finally {
    host.complete();
    await first.service.stop();
  }
  const restarted = await startService(root, stateRoot);
  try {
    const state = await health(restarted.base);
    assert.equal(state.readiness, "drained");
    assert.equal(state.acceptingWork, false);
    assert.equal(
      (
        await postJson(`${restarted.base}/v1/tasks`, {
          task: "restart must not clear drain",
          workspace,
        })
      ).status,
      409,
    );
  } finally {
    await restarted.service.stop();
  }
});

void test("drain of a waiting run reaches drained without waking or releasing its resident slot", async () => {
  const { root, workspace, stateRoot } = serviceEnvironment();
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "already waiting", workspace }, "0.85.1"),
  );
  store.update({ status: "waiting", phase: "waiting", reason: "coherent wait" });
  const started = await startService(root, stateRoot);
  try {
    const drain = await fetch(`${started.base}/v1/drain`, { method: "POST", headers: auth });
    assert.equal(drain.status, 202);
    const state = await responseJson<{ readiness: string; worker: string; activeRunId: string }>(
      drain,
    );
    assert.equal(state.readiness, "drained");
    assert.equal(state.worker, "waiting");
    assert.equal(state.activeRunId, store.runId);
    assert.equal(store.snapshot().status, "waiting");
    const cancel = await fetch(`${started.base}/v1/tasks/${store.runId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(cancel.status, 200);
    assert.equal(store.snapshot().status, "cancelled");
    assert.equal((await health(started.base)).readiness, "drained");
  } finally {
    await started.service.stop();
  }
});
