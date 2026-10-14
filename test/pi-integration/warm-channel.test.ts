import { parseCustomRequest } from "../../src/execution/custom-hand.js";
import {
  assertHandsCorrelation,
  assertHandsActive,
  authenticateHandsHello,
} from "../../src/execution/contracts.js";
import { residentHandshake } from "../../src/execution/hands-bootstrap.js";
import { HandsFrameDecoder } from "../../src/execution/protocol.js";
/** Metadata/framing fixtures support the contract; installed CLI/Pi proofs remain distinct. */
import assert from "node:assert/strict";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { WarmHandsChannel, HandsOperationError } from "../../src/execution/warm-channel.js";
import {
  HANDS_REQUEST_BYTES,
  HANDS_RESPONSE_BYTES,
  encodeHandsFrame,
  parseHandsFrame,
  type HandsFrame,
} from "../../src/execution/protocol.js";
import { suppliedEngine } from "./backend-support.js";

const CORRELATION = {
  version: 1 as const,
  generation: "original",
  configuration: "c".repeat(64),
  session: "d".repeat(64),
  sequence: 1,
};
void test("HandsFrame closed codec rejects foreign fields/kinds/version and keeps command data inert", () => {
  const frame: HandsFrame = {
    ...CORRELATION,
    kind: "command-data",
    payload: { commandId: 1, stream: "stdout", text: '{"kind":"ack","allowed":true}' },
  };
  assert.deepEqual(parseHandsFrame(frame), frame);
  for (const mutation of [
    { version: 2 },
    { kind: "grant" },
    { surprise: "authority" },
    { sequence: -1 },
    { session: "wrong" },
  ]) {
    assert.throws(() => parseHandsFrame({ ...frame, ...mutation }), SeptError);
  }
  assert.throws(
    () => parseHandsFrame({ ...frame, payload: { ...frame.payload, User: "0" } }),
    SeptError,
  );
  assert.deepEqual(parseHandsFrame({ ...CORRELATION, kind: "cancel", payload: {} }).kind, "cancel");
  for (const entry of [
    {
      kind: "command-start",
      payload: {
        commandId: 1,
        program: "bash",
        command: "echo bounded",
        input: "",
        cwd: "/workspace",
      },
    },
    { kind: "command-exit", payload: { commandId: 1, code: 0, signal: null, termination: "exit" } },
    { kind: "error", payload: { stage: "operation" } },
  ]) {
    assert.equal(parseHandsFrame({ ...CORRELATION, ...entry }).kind, entry.kind);
  }
});
void test("HandsFrameDecoder accepts every byte split and rejects size before body allocation/truncated EOF", () => {
  const frame: HandsFrame = { ...CORRELATION, kind: "result", payload: "bounded" };
  const encoded = encodeHandsFrame(frame);
  const accepted: HandsFrame[] = [];
  const decoder = new HandsFrameDecoder(
    HANDS_RESPONSE_BYTES,
    (frame) => accepted.push(frame),
    failedFrame,
  );
  for (const byte of encoded) {
    decoder.write(Buffer.from([byte]));
  }
  decoder.finish();
  assert.deepEqual(accepted, [frame]);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(HANDS_RESPONSE_BYTES + 4097);
  assert.throws(() => {
    new HandsFrameDecoder(HANDS_RESPONSE_BYTES, unexpectedFrame, failedFrame).write(oversized);
  }, SeptError);
  const partial = new HandsFrameDecoder(HANDS_RESPONSE_BYTES, unexpectedFrame, failedFrame);
  partial.write(encoded.subarray(0, 6));
  assert.throws(() => {
    partial.finish();
  }, SeptError);
});
void test("Hands frame request/result payload capacities preserve exact boundary plus one", () => {
  const result: HandsFrame = {
    ...CORRELATION,
    kind: "result",
    payload: "x".repeat(HANDS_RESPONSE_BYTES - 2),
  };
  assert.ok(encodeHandsFrame(result));
  assert.throws(
    () => encodeHandsFrame({ ...result, payload: "x".repeat(HANDS_RESPONSE_BYTES - 1) }),
    SeptError,
  );
  const overhead = Buffer.byteLength(
    JSON.stringify({ kind: "file", method: "writeFile", path: "a", content: "" }),
  );
  const request = {
    ...CORRELATION,
    kind: "operation",
    payload: {
      kind: "file",
      method: "writeFile",
      path: "a",
      content: "x".repeat(HANDS_REQUEST_BYTES - overhead),
    },
  } satisfies HandsFrame;
  assert.ok(encodeHandsFrame(request));
  assert.throws(
    () =>
      encodeHandsFrame({
        ...request,
        payload: { ...request.payload, content: request.payload.content + "x" },
      }),
    SeptError,
  );
});
void test("warmHandsHandshake and WarmHandsChannel authenticate one attachment and refreshes parent authority over five serial calls", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  const configuration = {
    profile: "docker-linux-warm-v1" as const,
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace: fixture.root,
    resources: fixture.root,
    dataDomain: "mutable-file-bind" as const,
    shell: false,
    readOnlyMounts: [],
  };
  let channel: WarmHandsChannel | undefined;
  try {
    channel = await WarmHandsChannel.open(configuration, engine, "/workspace");
    await exerciseWarmReuse(channel, fixture.facts);
    fixture.facts.warmReply = (frame) =>
      frame.kind === "result" ? { ...frame, sequence: frame.sequence - 1 } : frame;
    await assert.rejects(
      channel.invoke({ kind: "file", method: "readTextFile", path: "a" }, () => Promise.resolve()),
      /correlation/,
    );
    await assert.rejects(
      channel.invoke({ kind: "resources" }, () => Promise.resolve()),
      SeptError,
    );
  } finally {
    await channel?.close();
    await engine.close();
    await fixture.close();
  }
});
void test("WarmHandsChannel refuses challenge mismatch before operation and authority loss joins its socket", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  const configuration = {
    profile: "docker-linux-warm-v1" as const,
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace: fixture.root,
    resources: fixture.root,
    dataDomain: "mutable-file-bind" as const,
    shell: false,
    readOnlyMounts: [],
  };
  try {
    fixture.facts.warmReply = (frame) =>
      frame.kind === "hello"
        ? { ...frame, payload: { ...frame.payload, challenge: "f".repeat(64) } }
        : frame;
    await assert.rejects(WarmHandsChannel.open(configuration, engine, "/workspace"), /handshake/);
    fixture.facts.warmReply = undefined;
    const channel = await WarmHandsChannel.open(configuration, engine, "/workspace");
    await assert.rejects(
      channel.invoke({ kind: "file", method: "readTextFile", path: "a" }, () =>
        Promise.reject(new SeptError("Live policy denied")),
      ),
      /Live policy denied/,
    );
    await channel.close();
  } finally {
    await engine.close();
    await fixture.close();
  }
});

async function exerciseWarmReuse(
  channel: WarmHandsChannel,
  facts: Awaited<ReturnType<typeof suppliedEngine>>["facts"],
): Promise<void> {
  const effects: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(
      await channel.invoke({ kind: "file", method: "readTextFile", path: "a" }, (frame) => {
        effects.push(frame.sequence);
        return Promise.resolve();
      }),
      { ok: true, value: "bounded result" },
    );
  }
  assert.deepEqual(effects, [1, 2, 3, 4, 5]);
  assert.equal(facts.execStarts, 1);
  assert.deepEqual(channel.identity, { pid: 42, start: "123" });
  facts.warmReply = (frame) =>
    frame.kind === "result" ? { ...frame, kind: "error", payload: { stage: "operation" } } : frame;
  await assert.rejects(
    channel.invoke({ kind: "file", method: "readTextFile", path: "a" }, () => Promise.resolve()),
    HandsOperationError,
  );
  facts.warmReply = undefined;
  assert.ok(
    await channel.invoke({ kind: "file", method: "readTextFile", path: "a" }, () =>
      Promise.resolve(),
    ),
  );
}

function unexpectedFrame(): never {
  return assert.fail("Unexpected frame");
}
function failedFrame(error: Error): never {
  return assert.fail(error);
}

void test("assertHandsCorrelation, assertHandsActive, authenticateHandsHello and residentHandshake refuse lost identity/guard", () => {
  const hello: HandsFrame = {
    ...CORRELATION,
    sequence: 0,
    kind: "hello",
    payload: { challenge: "e".repeat(64), pid: 42, start: "123", guard: 2, network: "denied" },
  };
  assert.equal(authenticateHandsHello(hello, CORRELATION, "e".repeat(64)), hello);
  assert.throws(() => {
    assertHandsCorrelation(hello, CORRELATION, 1);
  }, SeptError);
  assert.throws(() => authenticateHandsHello(hello, CORRELATION, "f".repeat(64)), SeptError);
  assert.throws(() => {
    assertHandsActive(AbortSignal.abort());
  }, SeptError);
  assert.throws(() => residentHandshake(), SeptError);
});

void test("parseCustomRequest preserves only the bounded custom input and fixed registration", () => {
  assert.deepEqual(
    parseCustomRequest(
      { kind: "custom", callId: "one", arguments: { text: "bounded" } },
      undefined,
    ),
    { kind: "custom", callId: "one", arguments: { text: "bounded" } },
  );
  assert.throws(
    () =>
      parseCustomRequest({ callId: "one", arguments: { text: "bounded", User: "0" } }, undefined),
    SeptError,
  );
});

void test("HandsFrameDecoder rejects the 257th announced frame before allocation and refreshes at serial boundary", () => {
  const frame = encodeHandsFrame({ ...CORRELATION, kind: "result", payload: "bounded" });
  let count = 0;
  const decoder = new HandsFrameDecoder(
    HANDS_RESPONSE_BYTES,
    () => {
      count += 1;
    },
    failedFrame,
  );
  for (let index = 0; index < 256; index += 1) {
    decoder.write(frame);
  }
  assert.equal(count, 256);
  assert.throws(() => {
    decoder.write(frame.subarray(0, 4));
  }, SeptError);
  assert.equal(count, 256);
  const fresh = new HandsFrameDecoder(
    HANDS_RESPONSE_BYTES,
    () => {
      count += 1;
    },
    failedFrame,
  );
  fresh.write(frame);
  fresh.beginOperation();
  fresh.write(frame);
  fresh.finish();
  assert.equal(count, 258);
});
