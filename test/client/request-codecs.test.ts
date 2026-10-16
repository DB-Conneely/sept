/** Focused client authority, path, cursor and exact encoded-byte boundary contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clientConfiguration,
  conversationQuery,
  encodeEnvelope,
  requestInteger,
  requestSignal,
  runIdentifier,
} from "../../src/client/request-codecs.js";
import { createTaskClient } from "../../src/client/index.js";
import { clientFailure, TOKEN } from "./support.js";

void test("clientConfiguration restricts bearer and origin authority and representable timeout", () => {
  const options = { baseUrl: "https://example.test:444/", token: TOKEN };
  assert.deepEqual(clientConfiguration(options), {
    origin: "https://example.test:444",
    authorization: `Bearer ${TOKEN}`,
    timeoutMs: 30_000,
  });
  assert.equal(clientConfiguration({ ...options, timeoutMs: 1 }).timeoutMs, 1);
  assert.equal(
    clientConfiguration({ ...options, timeoutMs: 2_147_483_647 }).timeoutMs,
    2_147_483_647,
  );
  const urls = [
    "file:///tmp/secret",
    "http://user:url-secret@example.test",
    "http://example.test/other",
    "http://example.test/a/..",
    "http://example.test/?url-secret",
    "http://example.test/#url-secret",
    " http://example.test",
    "http://example.test\n",
    "http://[invalid",
  ];
  for (const baseUrl of urls) {
    assert.throws(() => createTaskClient({ ...options, baseUrl }), clientFailure("configuration"));
  }
  for (const token of ["", "a\r\nCANARY: exposed", "é", "white space", "x".repeat(8193)]) {
    assert.throws(() => clientConfiguration({ ...options, token }), clientFailure("configuration"));
  }
  assert.equal(
    clientConfiguration({ ...options, token: "x".repeat(8192) }).authorization.length,
    8199,
  );
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(
      () => clientConfiguration({ ...options, timeoutMs }),
      clientFailure("configuration"),
    );
  }
});

void test("runIdentifier, requestInteger and conversationQuery reject coercion and path/query injection", () => {
  assert.equal(runIdentifier("a".repeat(128)), "a".repeat(128));
  for (const runId of ["", "a".repeat(129), "../secret", "a/b", "a?x", "%2e", "a\n", "é", 3]) {
    assert.throws(() => runIdentifier(runId), clientFailure("configuration"));
  }
  assert.equal(
    requestInteger(Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  assert.throws(() => requestInteger("1", 0, 250), clientFailure("configuration"));
  assert.deepEqual(conversationQuery(undefined), { after: 0, limit: 100 });
  assert.deepEqual(conversationQuery({ after: Number.MAX_SAFE_INTEGER, limit: 250 }), {
    after: Number.MAX_SAFE_INTEGER,
    limit: 250,
  });
  for (const after of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => conversationQuery({ after }), clientFailure("configuration"));
  }
  for (const limit of [0, 251, 1.5]) {
    assert.throws(() => conversationQuery({ limit }), clientFailure("configuration"));
  }
  const controller = new AbortController();
  assert.equal(requestSignal({ signal: controller.signal }), controller.signal);
  assert.equal(requestSignal(undefined), undefined);
  for (const options of [null, 1, { signal: {} }]) {
    assert.throws(() => requestSignal(options), clientFailure("configuration"));
  }
});

void test("encodeEnvelope preserves stable identities, rejects bad framing and enforces exact UTF-8 request bytes", () => {
  const identity = { source: "source:1", eventId: "stable-id" };
  const empty = { ...identity, version: 1, kind: "task", task: { task: "" } };
  const overhead = Buffer.byteLength(JSON.stringify(empty));
  const body = { ...empty, task: { task: `é${"a".repeat(256 * 1024 - overhead - 2)}` } };
  assert.equal(Buffer.byteLength(encodeEnvelope(identity, body)), 256 * 1024);
  assert.throws(
    () => encodeEnvelope(identity, { ...body, extra: "x" }),
    clientFailure("configuration"),
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => encodeEnvelope(identity, cyclic), clientFailure("configuration"));
  for (const source of ["", " white", "a/b", "a".repeat(129)]) {
    assert.throws(
      () => encodeEnvelope({ ...identity, source }, empty),
      clientFailure("configuration"),
    );
  }
  for (const eventId of ["", " trailing ", "a\n", "a".repeat(257)]) {
    assert.throws(
      () => encodeEnvelope({ ...identity, eventId }, empty),
      clientFailure("configuration"),
    );
  }
});
