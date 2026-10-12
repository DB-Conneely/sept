/**
 * Exercises runtime collaborator exports at their owning module boundaries. These focused checks
 * supplement end-to-end controller tests without granting tests alternate lifecycle authority.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RunStore } from "../../src/durable/index.js";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { RuntimeInvocationLoop } from "../../src/runtime/invocation-loop.js";
import { RunNotFoundError, WorkerConflictError } from "../../src/runtime/errors.js";
import {
  enforceEpochLimit,
  enforceInvocationLimits,
  runWithActiveDeadline,
  reconcileActiveDeadline,
  RuntimeLimitError,
  updateRuntimeSnapshot,
} from "../../src/runtime/runtime-state.js";
import { RuntimeSessionLifecycle } from "../../src/runtime/session-lifecycle.js";
import { RuntimeTransitions } from "../../src/runtime/transitions.js";
import { WorkerExecutionSlot } from "../../src/runtime/worker-execution.js";
import { WorkerMessages } from "../../src/runtime/worker-messages.js";
import {
  assertMessageAdmission,
  assertWorkspaceConfined,
} from "../../src/runtime/worker-policy.js";
import { recoverWorkerResident } from "../../src/runtime/worker-recovery.js";
import { FakeHost, complete, controllerFixture, serviceEnvironment } from "./support.js";

void test("runtime collaborators expose classifiable construction contracts", () => {
  assert.equal(typeof RuntimeInvocationLoop, "function");
  assert.equal(typeof RuntimeSessionLifecycle, "function");
  assert.equal(typeof RuntimeTransitions, "function");
  assert.equal(typeof WorkerExecutionSlot, "function");
  assert.equal(typeof WorkerMessages, "function");
  assert.ok(new WorkerConflictError("conflict") instanceof Error);
  assert.ok(new RunNotFoundError("missing") instanceof Error);
  assert.ok(new RuntimeLimitError("timeout", "bounded") instanceof Error);
});

void test("runtime snapshot updates clear optional authority fields and enforce configured limits", () => {
  const { store } = controllerFixture();
  updateRuntimeSnapshot(store, {
    status: "blocked",
    phase: "terminal",
    reason: "temporary",
    terminalCause: "agent_blocked",
  });
  const cleared = updateRuntimeSnapshot(store, {
    status: "active",
    phase: "ready",
    reason: undefined,
    terminalCause: undefined,
  });
  assert.equal(cleared.reason, undefined);
  assert.equal(cleared.terminalCause, undefined);
  const manifest = store.manifest();
  assert.throws(() => {
    enforceEpochLimit({ ...manifest, maxEpochs: 1 }, { ...cleared, epoch: 1 });
  }, RuntimeLimitError);
  assert.throws(() => {
    enforceInvocationLimits({ ...manifest, maxInvocations: 1 }, { ...cleared, invocations: 1 });
  }, RuntimeLimitError);
});

void test("active deadline delegates to one host invocation and records active time", async () => {
  const { store } = controllerFixture();
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 1, contextWindow: 100 },
  ]);
  const result = await runWithActiveDeadline(store, host, "prompt", store.manifest());
  assert.equal(result.steered, false);
  assert.equal(host.prompts.length, 1);
  assert.ok(store.snapshot().activeMilliseconds >= 0);
});

void test("message admission rejects same-run blocked settlement and workspace escape", () => {
  const { root, store } = controllerFixture();
  updateRuntimeSnapshot(store, { status: "blocked", phase: "terminal" });
  assert.throws(
    () =>
      assertMessageAdmission(store, false, {
        readiness: "accepting",
        stopping: false,
        initialized: true,
        activeRunId: store.runId,
        residentRunId: store.runId,
      }),
    WorkerConflictError,
  );
  assert.throws(() => {
    assertWorkspaceConfined(store.manifest().workspace, `${root}/elsewhere`);
  });
});

void test("worker recovery reports no resident for an empty state root", () => {
  const { stateRoot } = serviceEnvironment();
  const result = recoverWorkerResident(stateRoot, NOOP_TELEMETRY, () => {
    return;
  });
  assert.equal(result.resident, undefined);
  assert.equal(result.adoption, "none");
});

void test("waiting resident ownership blocks another dormant run and pending duplicate repair", () => {
  const { store } = controllerFixture();
  updateRuntimeSnapshot(store, { status: "blocked", phase: "terminal" });
  assert.throws(
    () =>
      assertMessageAdmission(store, false, {
        readiness: "accepting",
        stopping: false,
        initialized: true,
        activeRunId: undefined,
        residentRunId: "other-waiting-run",
      }),
    WorkerConflictError,
  );
});

void test("interrupted active budget is debited once and dormant waiting has no start to charge", () => {
  const { store } = controllerFixture();
  store.update({ activeMilliseconds: 100, activeStartedAt: Date.now() - 500 });
  reconcileActiveDeadline(store);
  const charged = store.snapshot().activeMilliseconds;
  assert.ok(charged >= 600);
  assert.equal(store.snapshot().activeStartedAt, undefined);
  reconcileActiveDeadline(store);
  assert.equal(store.snapshot().activeMilliseconds, charged);
  store.update({ status: "waiting", phase: "waiting" });
  reconcileActiveDeadline(store);
  assert.equal(store.snapshot().activeMilliseconds, charged);
});

void test("unconsumed duplicate repairs projection and wake while consumed duplicate stays inert", () => {
  for (const status of ["waiting", "blocked"] as const) {
    const { store } = controllerFixture();
    store.update({ status, phase: status === "waiting" ? "waiting" : "terminal" });
    let launches = 0;
    const messages = new WorkerMessages(
      NOOP_TELEMETRY,
      (target, consumed) =>
        assertMessageAdmission(target, consumed, {
          readiness: "accepting",
          stopping: false,
          initialized: true,
          activeRunId: undefined,
          residentRunId: status === "waiting" ? target.runId : undefined,
        }),
      () => {
        launches += 1;
      },
    );
    const restoreProjection = interruptProjection(store);
    assert.throws(() => messages.send(store, "exact retry text", "retry"));
    assert.equal(store.pendingMessages().length, 1);
    assert.equal(launches, 0);
    restoreProjection();
    messages.send(store, "exact retry text", "retry");
    assert.equal(store.snapshot().status, "active");
    assert.equal(launches, 1);
    store.checkpoint(
      { status: "complete", summary: "done", verification: [], next_action: "" },
      store.pendingMessages(),
      "fixture",
    );
    store.update({ status: "complete", phase: "terminal" });
    messages.send(store, "exact retry text", "retry");
    assert.equal(launches, 1);
  }
});

void test("failed running-state publication closes the acquired host before controller ownership", async () => {
  const { store } = controllerFixture();
  const host = new FakeHost([]);
  let closed = 0;
  host.close = () => {
    closed += 1;
    return Promise.resolve();
  };
  const update = store.update.bind(store);
  store.update = (patch) => {
    if (patch.phase === "running") {
      throw new WorkerConflictError("fixture publication failure");
    }
    return update(patch);
  };
  const lifecycle = new RuntimeSessionLifecycle(
    store,
    "/pi",
    () => Promise.resolve(host),
    NOOP_TELEMETRY,
    () => false,
  );
  await assert.rejects(lifecycle.open(store.manifest()), /fixture publication failure/);
  assert.equal(closed, 1);
});

function interruptProjection(store: RunStore): () => void {
  const event = store.event.bind(store);
  store.event = (type, fields) => {
    if (type === "operator_conversation_recorded") {
      throw new WorkerConflictError("fixture interrupted projection marker");
    }
    return event(type, fields);
  };
  return () => {
    store.event = event;
  };
}
