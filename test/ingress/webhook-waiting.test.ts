/**
 * Verifies dormant waiting-run ownership, restart adoption, durable wake recovery, and the
 * controller-settlement race through installed ingress composition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { listRuns, RunStore, SeptError } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import {
  AUTH,
  CompletingHost,
  environment,
  jsonRecord,
  post,
  postDirectMessage,
  requiredAt,
  SettlingWaitingHost,
  start,
  stringField,
  WaitingHost,
  waitFor,
  waitForWorker,
} from "./webhook-support.js";

void test("waiting webhook wakes the same Pi session exactly once", async () => {
  const { workspace, stateRoot } = environment();
  const firstHost = new WaitingHost();
  const secondHost = new CompletingHost();
  const hosts = [firstHost, secondHost];
  const opened: (string | undefined)[] = [];
  let creations = 0;
  const { service, base } = await start(stateRoot, (_manifest, _store, _agentDir, existing) => {
    opened.push(existing);
    const host = hosts[creations++];
    if (host === undefined) {
      return Promise.reject(new SeptError("duplicate controller"));
    }
    return Promise.resolve(host);
  });
  try {
    const runId = await createTask(base, workspace, "wait for authenticated observations");
    const store = runById(stateRoot, runId);
    await waitForWorker(base, "waiting");
    assert.equal(store.snapshot().status, "waiting");
    assert.equal(firstHost.prompts.length, 1);
    assert.equal(creations, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(firstHost.prompts.length, 1, "waiting must not invoke Pi again");
    await wakeAndAssertDuplicate(base, runId);
    await waitFor(() => store.snapshot().status === "complete");
    assert.equal(creations, 2);
    assert.deepEqual(opened, [undefined, "/tmp/webhook-test-session.jsonl"]);
    assert.match(requiredAt(secondHost.prompts, 0), /bounded observation payload/);
    assert.equal(store.pendingMessages().length, 0);
    assert.equal(eventCount(store, "operator_message_queued"), 1);
    assert.equal(eventCount(store, "pi_session_resumed"), 1);
  } finally {
    await service.stop();
  }
});

async function wakeAndAssertDuplicate(base: string, runId: string): Promise<void> {
  const event = {
    version: 1,
    eventId: "waiting-wake-1",
    source: "monitoring-edge",
    kind: "operator_message",
    runId,
    message: "bounded observation payload",
  };
  const wake = await post(base, event);
  assert.equal(wake.status, 202);
  const wakeBody = await jsonRecord(wake);
  assert.equal(wakeBody.duplicate, false);
  assert.equal(typeof wakeBody.messageId, "string");
  const duplicate = await post(base, event);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), {
    kind: "operator_message",
    runId,
    messageId: wakeBody.messageId,
    duplicate: true,
  });
}

void test("worker restart keeps a waiting run dormant with its slot and session", async () => {
  const { workspace, stateRoot } = environment();
  const store = waitingRun(stateRoot, workspace, "remain asleep", "pi-dormant");
  let creations = 0;
  const { service, base } = await start(stateRoot, () => {
    creations++;
    return Promise.resolve(new CompletingHost());
  });
  try {
    await waitForWorker(base, "waiting");
    const health = await fetch(`${base}/health`, { headers: AUTH });
    assert.deepEqual(await health.json(), {
      status: "ok",
      worker: "waiting",
      readiness: "accepting",
      acceptingWork: true,
      activeRunId: store.runId,
      runtime: "pi-sdk",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(creations, 0);
    const newTask = await taskRequest(base, {
      task: "must not displace waiting run",
      workspace,
    });
    assert.equal(newTask.status, 409);
  } finally {
    await service.stop();
  }
});

void test("restart recovers a queued waiting wake and adopts the existing session", async () => {
  const { workspace, stateRoot } = environment();
  const store = waitingRun(stateRoot, workspace, "recover wake", "webhook-test-session");
  const message = store.enqueueMessage("accepted before the wake transition committed");
  const host = new CompletingHost();
  let opened: string | undefined;
  const { service } = await start(stateRoot, (_manifest, _store, _agentDir, existing) => {
    opened = existing;
    return Promise.resolve(host);
  });
  try {
    await waitFor(() => store.snapshot().status === "complete");
    assert.equal(opened, "/tmp/webhook-test-session.jsonl");
    assert.match(requiredAt(host.prompts, 0), /accepted before the wake transition committed/);
    assert.equal(store.pendingMessages().length, 0);
    assert.deepEqual(
      store.events(0, 1000).find((event) => event.type === "run_wake_recovered")?.messageIds,
      [message.id],
    );
  } finally {
    await service.stop();
  }
});

void test("message during waiting settlement launches no overlapping controller", async () => {
  const { workspace, stateRoot } = environment();
  const firstHost = new SettlingWaitingHost();
  const secondHost = new CompletingHost();
  let creations = 0;
  let reopenedExisting: string | undefined;
  const { service, base } = await start(stateRoot, (_manifest, _store, _agentDir, existing) => {
    creations++;
    if (creations === 1) {
      return Promise.resolve(firstHost);
    }
    if (creations === 2) {
      reopenedExisting = existing;
      return Promise.resolve(secondHost);
    }
    return Promise.reject(new SeptError("overlapping or duplicate controller"));
  });
  try {
    const runId = await createTask(base, workspace, "exercise waiting transition race");
    const store = runById(stateRoot, runId);
    await firstHost.closeStarted;
    assert.equal(store.snapshot().status, "waiting");
    const wake = await postDirectMessage(base, runId, "arrived while old runtime was closing");
    assert.equal(wake.status, 202);
    assert.equal(store.snapshot().status, "active");
    assert.equal(creations, 1, "the settling controller must retain exclusive ownership");
    firstHost.release();
    await waitFor(() => store.snapshot().status === "complete");
    assert.equal(creations, 2);
    assert.equal(reopenedExisting, "/tmp/webhook-test-session.jsonl");
    assert.match(requiredAt(secondHost.prompts, 0), /arrived while old runtime was closing/);
    assert.equal(store.pendingMessages().length, 0);
  } finally {
    firstHost.release();
    await service.stop();
  }
});

function waitingRun(
  stateRoot: string,
  workspace: string,
  task: string,
  sessionId: string,
): RunStore {
  const store = RunStore.create(stateRoot, validateRequest({ task, workspace }, "0.85.1"));
  store.update({
    status: "waiting",
    phase: "waiting",
    activeSessionId: sessionId,
    activeSessionFile: "/tmp/webhook-test-session.jsonl",
    reason: "waiting for input",
  });
  return store;
}

async function createTask(base: string, workspace: string, task: string): Promise<string> {
  const response = await taskRequest(base, { task, workspace });
  assert.equal(response.status, 202);
  return stringField(await jsonRecord(response), "runId");
}

function taskRequest(base: string, value: unknown): Promise<Response> {
  return fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

function runById(stateRoot: string, runId: string): RunStore {
  const store = listRuns(stateRoot).find((candidate) => candidate.runId === runId);
  assert.ok(store);
  return store;
}

function eventCount(store: RunStore, type: string): number {
  return store.events(0, 1000).filter((event) => event.type === type).length;
}
