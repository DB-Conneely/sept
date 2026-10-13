/** Exact durable denial/decision facts remain inert until a later matching explicitly admitted call. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CapabilityRequestStore,
  CapabilityRequestWaitingError,
  capabilityArguments,
  MAX_CAPABILITY_REQUESTS,
  MAX_CAPABILITY_REQUEST_BYTES,
  parseCapabilityBinding,
  SeptError,
  type CapabilityRequestFacts,
} from "../../src/durable/index.js";
import {
  capabilityDigest,
  parseCapabilityDecision,
  parseCapabilityRequest,
  sameCapabilityBinding,
} from "../../src/durable/capability-request-codec.js";
const SOURCE = { containerId: "a".repeat(64), generation: "source", fingerprint: "b".repeat(64) };
const TARGET = { ...SOURCE, generation: "fresh" };
function facts(callId = "original"): CapabilityRequestFacts {
  return {
    runId: "run",
    invocation: 1,
    callId,
    operation: "write",
    arguments: capabilityArguments({ path: "a", content: "exact" }),
    revision: 1,
    binding: SOURCE,
  };
}
void test("exact denial survives restart; only one later matching call can claim its fresh decision", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-request-"));
  const store = new CapabilityRequestStore(root);
  const original = store.create(facts());
  assert.equal(new CapabilityRequestStore(root).create(facts()).id, original.id);
  assert.throws(
    () => store.create({ ...facts(), arguments: capabilityArguments({ path: "b" }) }),
    /collides/,
  );
  const decision = {
    status: "approved" as const,
    revision: 2,
    binding: TARGET,
    expiresAt: Date.now() + 60_000,
  };
  store.decide(original.id, original.digest, decision);
  assert.deepEqual(store.decide(original.id, original.digest, decision), store.read()[0]);
  assert.equal(store.claim(facts()), undefined);
  const retry = { ...facts("retry"), invocation: 2, revision: 2, binding: TARGET };
  assert.equal(store.claim({ ...retry, revision: 3 }), undefined);
  assert.equal(store.claim({ ...retry, binding: SOURCE }), undefined);
  assert.equal(
    store.claim({ ...retry, arguments: capabilityArguments({ path: "changed" }) }),
    undefined,
  );
  assert.equal(store.claim(retry)?.id, original.id);
  assert.equal(new CapabilityRequestStore(root).permits(retry), true);
  assert.equal(store.claim({ ...retry, callId: "second-effect" }), undefined);
  assert.equal(store.permits({ ...retry, invocation: 3 }), false);
  assert.throws(
    () => store.decide(original.id, original.digest, { ...decision, status: "denied" }),
    /conflicts/,
  );
});
void test("denied, expired and digest-mismatched decisions never authorize a retry", () => {
  const store = new CapabilityRequestStore(mkdtempSync(join(tmpdir(), "sept-request-denied-")));
  const original = store.create(facts());
  assert.throws(
    () =>
      store.decide(original.id, "wrong", {
        status: "approved",
        revision: 2,
        binding: TARGET,
        expiresAt: Date.now() + 1000,
      }),
    /changed/,
  );
  store.decide(original.id, original.digest, {
    status: "denied",
    revision: 1,
    binding: SOURCE,
    expiresAt: Date.now() + 1000,
  });
  assert.equal(store.claim({ ...facts("retry"), invocation: 2 }), undefined);
  const expired = store.create(facts("expires"));
  store.decide(expired.id, expired.digest, {
    status: "approved",
    revision: 2,
    binding: TARGET,
    expiresAt: Date.now() - 1,
  });
  assert.equal(
    store.claim({ ...facts("retry-expired"), invocation: 2, revision: 2, binding: TARGET }),
    undefined,
  );
  assert.ok(new CapabilityRequestWaitingError(original.id) instanceof SeptError);
});
void test("request capacity32 plus one preserves every original denial and prior bytes", () => {
  const store = new CapabilityRequestStore(mkdtempSync(join(tmpdir(), "sept-request-capacity-")));
  for (let index = 0; index < MAX_CAPABILITY_REQUESTS; index += 1) {
    store.create(facts(`call-${String(index)}`));
  }
  const before = readFileSync(store.path);
  assert.throws(() => store.create(facts("overflow")), /capacity/);
  assert.deepEqual(readFileSync(store.path), before);
  assert.equal(store.read().length, MAX_CAPABILITY_REQUESTS);
});
void test("canonical exact codecs reject malformed authority, oversized content and changed digests", () => {
  const arguments_ = capabilityArguments({ b: 2, a: 1 });
  assert.equal(arguments_, capabilityArguments({ a: 1, b: 2 }));
  assert.equal(
    capabilityArguments("x".repeat(MAX_CAPABILITY_REQUEST_BYTES - 2)).length,
    MAX_CAPABILITY_REQUEST_BYTES,
  );
  assert.throws(() => capabilityArguments("x".repeat(MAX_CAPABILITY_REQUEST_BYTES - 1)), /bound/);
  assert.deepEqual(parseCapabilityBinding(SOURCE), SOURCE);
  assert.equal(sameCapabilityBinding(SOURCE, TARGET), false);
  const store = new CapabilityRequestStore(mkdtempSync(join(tmpdir(), "sept-request-codec-")));
  const selected = store.create(facts());
  assert.equal(
    parseCapabilityRequest(selected).digest,
    capabilityDigest(selected.operation, selected.arguments),
  );
  assert.throws(() => parseCapabilityRequest({ ...selected, digest: "wrong" }), /digest/);
  assert.throws(() => parseCapabilityDecision({ status: "approved", binding: SOURCE }), SeptError);
  writeFileSync(store.path, JSON.stringify({ version: 1, requests: [selected, selected] }));
  assert.throws(() => store.read(), /malformed/);
});
