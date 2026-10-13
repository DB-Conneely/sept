/**
 * Verifies cancellation races before invocation, during native replacement, and across restart.
 * Durable cancellation intent must precede host abort and must defeat every late native outcome.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { CapabilityRequestWaitingError, RunStore } from "../../src/durable/index.js";
import { CycleController } from "../../src/runtime/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import {
  auth,
  GateHost,
  ReplacementGateHost,
  ResultHost,
  postJson,
  responseJson,
  serviceEnvironment,
  startService,
  waitFor,
} from "./support.js";

async function assertCancelledRun(
  store: RunStore,
  host: GateHost,
  base: string,
  runId: string,
): Promise<void> {
  await waitFor(() => store.snapshot().status === "cancelled");
  assert.equal(host.aborted, 1);
  assert.equal(store.snapshot().terminalCause, "operator_cancelled");
  assert.equal(store.events(0, 1000).filter((event) => event.type === "run_completed").length, 0);
  assert.equal(store.conversation(0, 250).events.at(-1)?.type, "terminal");
  const repeated = await fetch(`${base}/v1/tasks/${runId}/cancel`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(repeated.status, 200);
  assert.equal(host.aborted, 1, "repeated cancellation must be idempotent");
  const late = await postJson(`${base}/v1/tasks/${runId}/messages`, { message: "late message" });
  assert.equal(late.status, 409);
}

void test("cancel persists intent before native-host abort and late completion cannot overwrite cancellation", async () => {
  const { root, workspace, stateRoot } = serviceEnvironment();
  let store: RunStore | undefined;
  const host = new GateHost();
  const originalAbort = host.abort.bind(host);
  host.abort = async () => {
    assert.ok(store !== undefined);
    assert.equal(store.snapshot().status, "cancelling");
    assert.equal(store.events(0, 1000).at(-1)?.type, "run_cancellation_requested");
    await originalAbort();
  };
  const started = await startService(root, stateRoot, () => Promise.resolve(host));
  try {
    const task = await postJson(`${started.base}/v1/tasks`, {
      task: "cancel active work",
      workspace,
    });
    const { runId } = await responseJson<{ runId: string }>(task);
    store = new RunStore(join(stateRoot, runId));
    const admittedStore = store;
    await waitFor(() => host.prompts.length === 1);
    const cancel = await fetch(`${started.base}/v1/tasks/${runId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.ok(cancel.status === 200 || cancel.status === 202);
    await assertCancelledRun(admittedStore, host, started.base, runId);
  } finally {
    host.complete();
    await started.service.stop();
  }
});

void test("cancellation before invocation cannot start late work", async () => {
  const before = serviceEnvironment();
  const host = new GateHost();
  let releaseFactory!: () => void;
  const factoryGate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  const first = await startService(before.root, before.stateRoot, async () => {
    await factoryGate;
    return host;
  });
  try {
    const task = await postJson(`${first.base}/v1/tasks`, {
      task: "cancel before invocation",
      workspace: before.workspace,
    });
    const { runId } = await responseJson<{ runId: string }>(task);
    const cancel = await fetch(`${first.base}/v1/tasks/${runId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(cancel.status, 202);
    releaseFactory();
    const store = new RunStore(join(before.stateRoot, runId));
    await waitFor(() => store.snapshot().status === "cancelled");
    assert.equal(host.prompts.length, 0);
    assert.equal(host.aborted, 1);
  } finally {
    releaseFactory();
    host.complete();
    await first.service.stop();
  }
});

void test("cancellation during fresh-session replacement cannot publish late work", async () => {
  const during = serviceEnvironment();
  const replacement = new ReplacementGateHost();
  const second = await startService(during.root, during.stateRoot, () =>
    Promise.resolve(replacement),
  );
  try {
    const task = await postJson(`${second.base}/v1/tasks`, {
      task: "cancel during replacement",
      workspace: during.workspace,
    });
    const { runId } = await responseJson<{ runId: string }>(task);
    await replacement.replacementStarted;
    const cancel = await fetch(`${second.base}/v1/tasks/${runId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(cancel.status, 202);
    replacement.release();
    const store = new RunStore(join(during.stateRoot, runId));
    await waitFor(() => store.snapshot().status === "cancelled");
    assert.equal(
      store.events(0, 1000).filter((event) => event.type === "successor_session_started").length,
      0,
    );
    assert.equal(
      store.events(0, 1000).filter((event) => event.type === "handover_written").length,
      1,
    );
  } finally {
    replacement.release();
    await second.service.stop();
  }
});

void test("restart completes an interrupted cancellation without opening Pi", async () => {
  const { root, workspace, stateRoot } = serviceEnvironment();
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "cancel before restart", workspace }, "0.85.1"),
  );
  store.requestCancellation();
  let opened = 0;
  const started = await startService(root, stateRoot, () => {
    opened += 1;
    return Promise.resolve(new ResultHost([]));
  });
  try {
    assert.equal(store.snapshot().status, "cancelled");
    assert.equal(opened, 0);
    const transcript = await fetch(`${started.base}/v1/tasks/${store.runId}/conversation`, {
      headers: auth,
    });
    const body = await responseJson<{ terminal: { status: string } }>(transcript);
    assert.equal(body.terminal.status, "cancelled");
  } finally {
    await started.service.stop();
  }
});

void test("cancellation during permission close wins over the later WAITING publication", async () => {
  const { workspace, stateRoot } = serviceEnvironment();
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "permission closure", workspace }, "0.85.1"),
  );
  const host = new GateHost();
  const closing = testGate();
  const entered = testGate();
  host.run = () => Promise.reject(new CapabilityRequestWaitingError("a".repeat(64)));
  host.close = () => {
    entered.release();
    return closing.promise;
  };
  const controller = new CycleController(store, workspace, () => Promise.resolve(host));
  const running = controller.run();
  await entered.promise;
  store.requestCancellation();
  await controller.abort();
  closing.release();
  await running;
  assert.equal(store.snapshot().status, "cancelled");
  assert.equal(store.snapshot().permissionRequestId, undefined);
  assert.equal(
    store.events(0, 1000).some((event) => event.type === "capability_request_waiting"),
    false,
  );
});
function testGate(): { promise: Promise<void>; release(): void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}
