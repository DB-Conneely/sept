/** Supporting codec capacity regressions; native installed effects are exercised separately. */
import assert from "node:assert/strict";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { HANDS_REQUEST_BYTES, parseHandsFrame } from "../../src/execution/protocol.js";

const CORRELATION = {
  version: 1,
  generation: "source",
  configuration: "a".repeat(64),
  session: "b".repeat(64),
  sequence: 1,
  kind: "command-start",
};

void test("HandsCommandStart exact codec bounds argv independently from path and aggregate capacity", () => {
  const payload = { commandId: 1, program: "rg", argv: ["x".repeat(4097)], cwd: "/workspace" };
  assert.deepEqual(parseHandsFrame({ ...CORRELATION, payload }).payload, payload);
  assert.doesNotThrow(() =>
    parseHandsFrame({
      ...CORRELATION,
      payload: { ...payload, argv: Array<string>(120).fill("x") },
    }),
  );
  for (const mutation of [
    { argv: Array<string>(121).fill("x") },
    { argv: ["nul\0pattern"] },
    { argv: ["x".repeat(HANDS_REQUEST_BYTES)] },
    { cwd: "x".repeat(4097) },
    { cwd: "/tmp\0suffix" },
    { commandId: 2 },
    { program: "sh" },
    { input: "injected" },
    { env: {} },
  ]) {
    assert.throws(
      () => parseHandsFrame({ ...CORRELATION, payload: { ...payload, ...mutation } }),
      SeptError,
    );
  }
  const { argv: _argv, ...missing } = payload;
  assert.throws(() => parseHandsFrame({ ...CORRELATION, payload: missing }), SeptError);
});

void test("HandsCommandStart accepts exactly 512 KiB serialized payload and refuses one byte beyond", () => {
  const template = { commandId: 1, program: "rg", argv: [""], cwd: "/workspace" };
  const overhead = Buffer.byteLength(JSON.stringify(template));
  const argument = "x".repeat(HANDS_REQUEST_BYTES - overhead);
  const payload = { ...template, argv: [argument] };
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), HANDS_REQUEST_BYTES);
  assert.deepEqual(parseHandsFrame({ ...CORRELATION, payload }).payload, payload);
  const oversized = { ...payload, argv: [`${argument}x`] };
  assert.equal(Buffer.byteLength(JSON.stringify(oversized)), HANDS_REQUEST_BYTES + 1);
  assert.throws(() => parseHandsFrame({ ...CORRELATION, payload: oversized }), SeptError);
});
