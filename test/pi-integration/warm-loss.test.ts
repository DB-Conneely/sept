import { watchHandsPolicy } from "../../src/execution/capability-requests.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
/** Idle loss seals the installed channel owner while ordinary native errors leave it reusable. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Duplex } from "node:stream";
import { EngineControlError } from "../../src/execution/contracts.js";
import { SeptError } from "../../src/durable/index.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { WarmHandsChannel, HandsOperationError } from "../../src/execution/warm-channel.js";
import { suppliedEngine, engineFrame } from "./backend-support.js";
import { encodeHandsFrame } from "../../src/execution/protocol.js";
void test("WarmHandsChannel idle loss synchronously seals its caller once and ordinary errors preserve it", async () => {
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
  const channel = await WarmHandsChannel.open(configuration, engine, "/workspace", () => {
    observed?.();
  });
  let observed: (() => void) | undefined;
  try {
    await assertIdleChannelLoss(channel, fixture, (resolve) => {
      observed = resolve;
    });
  } finally {
    await channel.close();
    await engine.close();
    await fixture.close();
  }
});

async function assertIdleChannelLoss(
  channel: WarmHandsChannel,
  fixture: Awaited<ReturnType<typeof suppliedEngine>>,
  observe: (resolve: () => void) => void,
): Promise<void> {
  let losses = 0;
  const lost = new Promise<void>((resolve) => {
    observe(() => {
      losses += 1;
      resolve();
    });
  });
  fixture.facts.warmReply = (frame) =>
    frame.kind === "result" ? { ...frame, kind: "error", payload: { stage: "operation" } } : frame;
  await assert.rejects(
    channel.invoke({ kind: "resources" }, () => Promise.resolve()),
    HandsOperationError,
  );
  assert.equal(losses, 0);
  await fixture.close();
  await lost;
  assert.equal(losses, 1);
  await assert.rejects(
    channel.invoke({ kind: "resources" }, () => Promise.resolve()),
    SeptError,
  );
  assert.equal(losses, 1);
}

void test("handshake and live channel preserve joined attachment overflow facts before RPC loss fallback", async () => {
  for (const phase of ["opening", "live"] as const) {
    await assertAttachmentLoss(phase);
  }
});
void test("WarmHandsChannel keeps an early native result pending until command join, including failure", async () => {
  await assertEarlyResult(false);
  await assertEarlyResult(true);
});
async function assertEarlyResult(fail: boolean): Promise<void> {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  let socket: Duplex | undefined;
  fixture.facts.residentAttachment = (attached) => {
    socket = attached;
    return true;
  };
  fixture.facts.warmReply = (frame) => {
    if (frame.kind !== "result") {
      return frame;
    }
    queueMicrotask(() => socket?.write(engineFrame(1, encodeHandsFrame(frame))));
    return {
      ...frame,
      kind: "command-start",
      payload: { commandId: 1, program: "bash", command: "true", input: "", cwd: "/workspace" },
    };
  };
  const configuration = {
    profile: "docker-linux-warm-v1" as const,
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace: fixture.root,
    resources: fixture.root,
    dataDomain: "private" as const,
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    shell: true,
    readOnlyMounts: [],
  };
  const channel = await WarmHandsChannel.open(configuration, engine, "/workspace");
  try {
    await holdEarlyResult(channel, fail);
  } finally {
    await channel.close();
    await engine.close();
    await fixture.close();
  }
}
async function holdEarlyResult(channel: WarmHandsChannel, fail: boolean): Promise<void> {
  let observeStart: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    observeStart = resolve;
  });
  let finish: () => void = () => undefined;
  const joined = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let settled = false;
  const pending = channel.invoke(
    { kind: "tool", name: "bash", callId: "early", arguments: { command: "true" } },
    () => Promise.resolve(),
    async (_command, output) => {
      await output("inert stderr", "stderr");
      observeStart();
      await joined;
      if (fail) {
        throw new SeptError("joined command failed");
      }
      return { code: 0, signal: null, termination: "exit" };
    },
  );
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  if (fail) {
    await assert.rejects(pending, /joined command failed/);
  } else {
    assert.ok(await pending);
  }
}
async function assertAttachmentLoss(phase: "opening" | "live"): Promise<void> {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  let socket: Duplex | undefined;
  fixture.facts.residentAttachment = (attached) => {
    socket = attached;
    if (phase === "opening") {
      attached.write(overflowHeader());
      return false;
    }
    return true;
  };
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
    if (phase === "opening") {
      await assert.rejects(
        WarmHandsChannel.open(configuration, engine, "/workspace"),
        joinedOverflow,
      );
    } else {
      await assertLiveOverflow(configuration, engine, () => socket);
    }
  } finally {
    await engine.close();
    await fixture.close();
  }
}
function overflowHeader(): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(4 * 1024 * 1024 + 65537, 4);
  return header;
}
function joinedOverflow(error: unknown): boolean {
  assert.ok(error instanceof EngineControlError);
  assert.equal(error.facts.stage, "exec-stream");
  assert.equal(error.facts.overflow, true);
  assert.equal(error.facts.requestJoined, true);
  assert.equal(error.facts.attachmentClosed, true);
  assert.equal(error.facts.signal, null);
  return true;
}

async function assertLiveOverflow(
  configuration: Parameters<typeof WarmHandsChannel.open>[0],
  engine: DockerEngineControl,
  attached: () => Duplex | undefined,
): Promise<void> {
  let observe: ((error: Error) => void) | undefined;
  const lost = new Promise<Error>((resolve) => {
    observe = resolve;
  });
  const channel = await WarmHandsChannel.open(configuration, engine, "/workspace", (error) =>
    observe?.(error),
  );
  const socket = attached();
  assert.ok(socket);
  socket.write(overflowHeader());
  joinedOverflow(await lost);
  await channel.release();
  await channel.close();
}

void test("watchHandsPolicy seals live authority after changed policy bytes and its owner closes the watcher", async () => {
  const fixture = await suppliedEngine();
  let complete: () => void = () => undefined;
  const sealed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const watcher = watchHandsPolicy(
    join(fixture.root, "policy.json"),
    () => {
      throw new SeptError("Revoked");
    },
    () => {
      complete();
      return Promise.resolve();
    },
  );
  try {
    writeFileSync(join(fixture.root, "policy.json"), "denied");
    await sealed;
  } finally {
    watcher.close();
    await fixture.close();
  }
});
