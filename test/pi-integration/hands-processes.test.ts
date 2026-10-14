/** Supporting exact command/lifetime tests; only installed Linux proof establishes kernel confinement and joins. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { assertHandsCommand } from "../../src/execution/hands-command-authority.js";
import { ResidentHandsCommand } from "../../src/execution/hands-command-client.js";
import {
  HandsProcessOwner,
  parseProcessIdentity,
} from "../../src/execution/hands-process-owner.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { WarmHandsChannel } from "../../src/execution/warm-channel.js";
import {
  invokeHandsOperation,
  joinHandsBeforeClose,
  stopLostHandsExecution,
} from "../../src/execution/hands-operation.js";
import { watchHandsPolicy } from "../../src/execution/capability-requests.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { suppliedEngine } from "./backend-support.js";
import type { HandsFrame, HandsCommandStart, HandsRequest } from "../../src/execution/contracts.js";
const COMMAND: HandsCommandStart = {
  commandId: 1,
  program: "bash",
  command: "echo bounded",
  cwd: "/workspace",
  input: "",
};
const PARENT: Extract<HandsFrame, { kind: "operation" }> = {
  version: 1,
  generation: "original",
  configuration: "a".repeat(64),
  session: "b".repeat(64),
  sequence: 1,
  kind: "operation",
  payload: {
    kind: "tool",
    name: "bash",
    callId: "one",
    arguments: { command: COMMAND.command, timeout: 2 },
  },
};
void test("assertHandsCommand binds actual bytes/input/cwd/pin/network/timeout to the admitted parent", () => {
  assert.deepEqual(assertHandsCommand(PARENT.payload, COMMAND, "/workspace"), {
    network: false,
    timeout: 2000,
  });
  for (const change of [
    { command: "different" },
    { input: "injected" },
    { cwd: "/proc" },
    { commandId: 2 },
  ]) {
    assert.throws(
      () => assertHandsCommand(PARENT.payload, { ...COMMAND, ...change }, "/workspace"),
      SeptError,
    );
  }
  assertCustomPin();
  assert.throws(
    () =>
      assertHandsCommand(
        {
          kind: "tool",
          name: "bash",
          callId: "invalid-budget",
          arguments: { command: COMMAND.command, timeout: -1 },
        },
        COMMAND,
        "/workspace",
      ),
    SeptError,
  );
});
function assertCustomPin(): void {
  const code = "process.stdout.write('pinned')";
  const parent: HandsRequest = {
    kind: "custom",
    callId: "custom",
    arguments: { text: "EXACT_INPUT", network: true },
    hand: {
      path: "/selected/hand/main.mjs",
      sha256: createHash("sha256").update(code).digest("hex"),
      replay: "safe",
    },
  };
  assert.deepEqual(
    assertHandsCommand(
      parent,
      { ...COMMAND, program: "custom", command: code, input: "EXACT_INPUT" },
      "/workspace",
    ),
    { network: true, timeout: 5000 },
  );
  assert.throws(() => assertHandsCommand(parent, COMMAND, "/workspace"), SeptError);
}
void test("ResidentHandsCommand keeps hostile output inert, awaits joined exit, refuses duplicate and closes lost control", async () => {
  const frames: HandsFrame[] = [];
  const client = new ResidentHandsCommand(PARENT, (frame) => {
    frames.push(frame);
  });
  const bytes: Buffer[] = [];
  const result = client.execute(COMMAND, (chunk) => {
    bytes.push(chunk);
  });
  assert.equal(frames[0]?.kind, "command-start");
  client.receive({
    ...PARENT,
    kind: "command-data",
    payload: { commandId: 1, stream: "stdout", text: '{"kind":"ack"}' },
  });
  client.receive({
    ...PARENT,
    kind: "command-exit",
    payload: { commandId: 1, code: 7, signal: null, termination: "exit" },
  });
  assert.equal((await result).code, 7);
  assert.equal(Buffer.concat(bytes).toString(), '{"kind":"ack"}');
  await assert.rejects(
    client.execute(COMMAND, () => undefined),
    SeptError,
  );
  const lost = new ResidentHandsCommand(PARENT, () => undefined);
  const pending = lost.execute(COMMAND, () => undefined);
  lost.close();
  await assert.rejects(pending, SeptError);
});
void test("HandsProcessOwner fixed UID Engine command rechecks after registration and joins exact lifetime helper", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
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
  try {
    const owner = await HandsProcessOwner.open(configuration, engine, { pid: 42, start: "123" });
    await exerciseOwnedCommand(owner);
    await owner.join();
    await joinHandsBeforeClose(owner, undefined, () =>
      Promise.reject(new SeptError("Unexpected stop")),
    );
    await exerciseOperation(owner, configuration, engine);
    assert.deepEqual(parseProcessIdentity({ pid: 42, start: "123" }), { pid: 42, start: "123" });
    assert.throws(() => parseProcessIdentity({ pid: 1, start: "123" }), SeptError);
    await assertLateRevoke(owner);
  } finally {
    await engine.close();
    await fixture.close();
  }
});
async function assertLateRevoke(owner: HandsProcessOwner): Promise<void> {
  await assert.rejects(
    owner.execute(
      COMMAND,
      {
        network: false,
        signal: new AbortController().signal,
        authorize: () => Promise.reject(new SeptError("Live parent revoked before start")),
      },
      () => Promise.resolve(),
    ),
    /Live parent revoked/,
  );
}
async function exerciseOperation(
  owner: HandsProcessOwner,
  configuration: Parameters<typeof HandsProcessOwner.open>[0],
  engine: DockerEngineControl,
): Promise<void> {
  const channel = await WarmHandsChannel.open(configuration, engine, "/workspace");
  try {
    const request: HandsRequest = { kind: "file", method: "readTextFile", path: "a" };
    assert.deepEqual(
      await invokeHandsOperation(channel, owner, request, "/workspace", () =>
        Promise.resolve(request),
      ),
      { ok: true, value: "bounded result" },
    );
  } finally {
    await channel.close();
  }
}
async function exerciseOwnedCommand(owner: HandsProcessOwner): Promise<void> {
  let authorized = false;
  const output: string[] = [];
  assert.deepEqual(
    await owner.execute(
      COMMAND,
      {
        network: false,
        signal: new AbortController().signal,
        authorize: () => {
          authorized = true;
          return Promise.resolve();
        },
      },
      (text) => {
        output.push(text);
        return Promise.resolve();
      },
    ),
    { code: 0, signal: null, termination: "exit" },
  );
  assert.equal(authorized, true);
  // Bash preserves combined native stdout/stderr; the diagnostic stream remains inert data.
  assert.equal(output.join(""), "HOSTILE_STDERR_CANARYbounded result");
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

void test("stopLostHandsExecution reports verified uncertainty and never promotes failed stop to cancellation", async () => {
  await assert.rejects(
    stopLostHandsExecution(() => Promise.resolve(), new SeptError("Lost")),
    /interrupted effects may be uncertain/,
  );
  await assert.rejects(
    stopLostHandsExecution(
      () => Promise.reject(new SeptError("Unverified")),
      new SeptError("Lost"),
    ),
    /shutdown is unverified/,
  );
});
