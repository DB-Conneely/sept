/** Joined loss and result acceptance preserve bounded engine/cancel/uncertainty facts. */
import assert from "node:assert/strict";
import test from "node:test";
import { assertHandsAvailable } from "../../src/execution/hands-loss.js";
import { SeptError } from "../../src/durable/index.js";
import { EngineControlError, HandsBackendUnavailableError } from "../../src/execution/contracts.js";
import {
  stopLostHandsExecution,
  invokeAdmittedHands,
} from "../../src/execution/hands-operation.js";
void test("HandsBackendUnavailableError retains typed uncertainty/actual Engine facts only after closure", async () => {
  const engine = EngineControlError.at("exec-exit", Date.now() - 20, { code: 137, timeout: true });
  const facts = {
    stage: "effect" as const,
    operation: "tool" as const,
    elapsedMs: 24,
    cancelled: false,
    authorityLost: true as const,
    effectsUncertain: true,
  };
  await assert.rejects(
    stopLostHandsExecution(() => Promise.resolve(), engine, facts),
    (error: unknown) => {
      assert.ok(error instanceof HandsBackendUnavailableError);
      assert.ok(error.facts);
      assert.ok(error.facts.engine);
      assert.equal(error.facts.namespaceStopped, true);
      assert.equal(error.facts.effectsUncertain, true);
      assert.equal(error.facts.engine.code, 137);
      assert.equal(error.facts.engine.signal, null);
      assert.equal(error.facts.engine.timeout, true);
      return true;
    },
  );
  await assert.rejects(
    stopLostHandsExecution(() => Promise.reject(new SeptError("join failed")), engine, facts),
    (error: unknown) => {
      assert.ok(error instanceof HandsBackendUnavailableError);
      assert.ok(error.facts);
      assert.equal(error.facts.namespaceStopped, false);
      assert.equal(error.facts.effectsUncertain, true);
      return true;
    },
  );
});

void test("invokeAdmittedHands preserves result-boundary uncertainty after verified exact stop", async () => {
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  await assert.rejects(
    invokeAdmittedHands(
      BACKGROUND_CONTEXT,
      { kind: "resources" },
      {
        dispatch: (stage) => {
          stage("result");
          return Promise.reject(EngineControlError.at("rpc-lost", Date.now()));
        },
        stop: () => Promise.resolve(),
        loss: () => undefined,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof HandsBackendUnavailableError);
      assert.ok(error.facts);
      assert.equal(error.facts.stage, "result");
      assert.equal(error.facts.namespaceStopped, true);
      return true;
    },
  );
});

void test("assertHandsAvailable seals admission before stop acknowledgment without claiming new effects", () => {
  const owner = { unavailable: false, cancelled: false, namespaceStopped: false, loss: undefined };
  assertHandsAvailable(owner);
  assert.throws(
    () => {
      assertHandsAvailable({ ...owner, unavailable: true });
    },
    (error: unknown) => {
      assert.ok(error instanceof HandsBackendUnavailableError);
      assert.ok(error.facts);
      assert.equal(error.facts.namespaceStopped, false);
      assert.equal(error.facts.effectsUncertain, false);
      return true;
    },
  );
});
