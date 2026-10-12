/**
 * Exercises runtime collaborator exports at their owning module boundaries. These focused checks
 * supplement end-to-end controller tests without granting tests alternate lifecycle authority.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { RuntimeInvocationLoop } from "../../src/runtime/invocation-loop.js";
import { RunNotFoundError, WorkerConflictError } from "../../src/runtime/errors.js";
import {
  enforceEpochLimit,
  enforceInvocationLimits,
  runWithActiveDeadline,
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
