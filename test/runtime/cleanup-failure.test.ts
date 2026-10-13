/** Unverified cleanup cannot publish successful cancellation. */
import assert from "node:assert/strict";
import { RunStore } from "../../src/durable/index.js";
import test from "node:test";
import { CycleController } from "../../src/runtime/index.js";
import { FakeHost, RuntimeFixtureError, controllerFixture } from "./support.js";

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
  assert.match(store.snapshot().reason ?? "", /cleanup is unverified/);
  assert.equal(
    store.events().some((event) => event.type === "run_cancelled"),
    false,
  );
});
