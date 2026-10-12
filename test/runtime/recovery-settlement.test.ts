/** Failed handover recovery holds its resident authority without automatic relaunch. */
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { WorkerRuntime } from "../../src/runtime/index.js";
import { nativeFixtureIdentity } from "../support/native-identity.js";
import { controllerFixture, handover, waitFor } from "./support.js";

await test("persistent handover-open failure makes one attempt and keeps recovery intent for restart", async () => {
  const { root, store } = controllerFixture();
  const identity = await nativeFixtureIdentity(store);
  store.update({
    phase: "running",
    activeSessionId: identity.sessionId,
    activeSessionFile: identity.sessionFile,
  });
  store.persistHandover(1, identity.sessionId, identity.sessionFile, handover, []);
  let attempts = 0;
  const worker = new WorkerRuntime({
    stateRoot: join(root, "runs"),
    agentDir: "/pi",
    workspaceRoot: realpathSync(root),
    hostFactory: () => {
      attempts += 1;
      return Promise.reject(new SeptError("fixture persistent native open failure"));
    },
  });
  worker.initialize();
  try {
    await waitFor(() => attempts === 1 && !existsSync(store.leasePath));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(attempts, 1);
    assert.equal(store.snapshot().status, "active");
    assert.equal(store.snapshot().phase, "handover_durable");
    assert.equal(worker.status().activeRunId, store.runId);
    assert.equal(worker.status().worker, "busy");
    assert.throws(() => {
      worker.assertTaskAvailable();
    }, /single worker slot is busy/);
  } finally {
    await worker.stop();
  }
  assert.equal(existsSync(join(root, "runs", "worker.lease")), false);
});
