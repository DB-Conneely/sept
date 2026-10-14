/** Unverified cleanup cannot publish successful cancellation. */
import assert from "node:assert/strict";
import { RunStore } from "../../src/durable/index.js";
import test from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionCleanupError } from "../../src/runtime/errors.js";
import { CycleController } from "../../src/runtime/index.js";
import { FakeHost, RuntimeFixtureError, controllerFixture, sessionResponse } from "./support.js";

await test("host cleanup failure durably blocks cancellation and releases controller lease", async () => {
  const { store } = controllerFixture();
  const host = new FakeHost([]);
  host.run = () => {
    store.requestCancellation();
    return Promise.reject(new RuntimeFixtureError("interrupted native work"));
  };
  host.close = () => Promise.reject(new RuntimeFixtureError("join unverified"));
  await assert.rejects(new CycleController(store, "/pi", () => Promise.resolve(host)).run());
  assert.equal(store.snapshot().status, "blocked");
  assert.equal(new RunStore(store.runDir).snapshot().terminalCause, "controller_failure");
  assert.equal(store.blockUnverifiedCleanup().status, "blocked");
  assertReleasedLease(store);
  assert.match(store.snapshot().reason ?? "", /cleanup is unverified/);
  assert.equal(
    store.events().some((event) => event.type === "run_cancelled"),
    false,
  );
});

function assertReleasedLease(store: RunStore): void {
  const lease = join(store.runDir, "controller.lease");
  const mutex = lease + ".lock";
  assert.equal(existsSync(lease), false);
  const inode = statSync(mutex).ino;
  const release = new RunStore(store.runDir).acquireLease();
  try {
    assert.equal(existsSync(lease), true);
    assert.equal(statSync(mutex).ino, inode);
  } finally {
    release();
  }
  assert.equal(existsSync(lease), false);
  assert.equal(statSync(mutex).ino, inode);
}

function acquisitionFailure(ordering: "publication" | "abort", cleanup: "joined" | "rejected") {
  const { store } = controllerFixture();
  const host = new FakeHost([]);
  const first = new RuntimeFixtureError("PRIVATE-FIRST-CANARY");
  const second = new RuntimeFixtureError("PRIVATE-CLEANUP-CANARY");
  const calls = { closes: 0, aborts: 0 };
  host.close = () => {
    calls.closes += 1;
    return cleanup === "rejected" ? Promise.reject(second) : Promise.resolve();
  };
  host.abort = () => {
    calls.aborts += 1;
    return Promise.reject(first);
  };
  const event = store.event.bind(store);
  store.event = (type, fields) => {
    if (ordering === "publication" && type === "pi_session_started") {
      throw first;
    }
    return event(type, fields);
  };
  const controller = new CycleController(store, "/pi", () => {
    if (ordering === "abort") {
      store.requestCancellation();
    }
    return Promise.resolve(host);
  });
  return { store, host, first, second, calls, controller };
}

for (const ordering of ["publication", "abort"] as const) {
  for (const cleanup of ["joined", "rejected"] as const) {
    await test(`acquired host ${ordering} failure with ${cleanup} cleanup`, async () => {
      const { store, host, first, second, calls, controller } = acquisitionFailure(
        ordering,
        cleanup,
      );
      await assert.rejects(controller.run(), (error: unknown) => {
        if (cleanup === "rejected") {
          assert.ok(error instanceof SessionCleanupError);
          assert.equal(error.cause, first);
          assert.equal(error.cleanupCause, second);
        } else {
          assert.equal(error, first);
        }
        return true;
      });
      const persisted = new RunStore(store.runDir).snapshot();
      const joinedStatus = ordering === "abort" ? "cancelled" : "failed";
      assert.equal(persisted.status, cleanup === "rejected" ? "blocked" : joinedStatus);
      assert.deepEqual(calls, { closes: 1, aborts: ordering === "abort" ? 1 : 0 });
      assert.equal(host.prompts.length, 0);
      const types = store.events().map((entry) => entry.type);
      assert.equal(types.includes("run_cancellation_requested"), ordering === "abort");
      assert.equal(types.includes("run_cancelled"), ordering === "abort" && cleanup === "joined");
      if (cleanup === "rejected") {
        assert.equal(persisted.terminalCause, "controller_failure");
        for (const file of ["state.json", "events.jsonl", "conversation.jsonl"]) {
          assert.doesNotMatch(
            readFileSync(join(store.runDir, file), "utf8"),
            /PRIVATE-(FIRST|CLEANUP)-CANARY/,
          );
        }
      }
      assertReleasedLease(store);
    });
  }
}

await test("failed cleanup block persistence cannot certify cancellation", async () => {
  const { store, controller } = acquisitionFailure("abort", "rejected");
  store.blockUnverifiedCleanup = () => {
    throw new RuntimeFixtureError("fixture block persistence failed");
  };
  await assert.rejects(controller.run(), /fixture block persistence failed/);
  assert.equal(store.snapshot().status, "cancelling");
  assert.equal(
    store.events().some((event) => event.type === "run_cancelled"),
    false,
  );
  assertReleasedLease(store);
});

await test("normal acquisition still completes and releases authority", async () => {
  const { store } = controllerFixture();
  const host = new FakeHost([sessionResponse("complete", "done")]);
  await new CycleController(store, "/pi", () => Promise.resolve(host)).run();
  assert.equal(store.snapshot().status, "complete");
  assert.equal(host.prompts.length, 1);
  assertReleasedLease(store);
});
