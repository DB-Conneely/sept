/** Idle loss seals the installed channel owner while ordinary native errors leave it reusable. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Duplex } from "node:stream";
import { EngineControlError } from "../../src/execution/contracts.js";
import { SeptError } from "../../src/durable/index.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { WarmHandsChannel, HandsOperationError } from "../../src/execution/warm-channel.js";
import { suppliedEngine } from "./backend-support.js";
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
