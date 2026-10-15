/** Supporting public owner/native termination races; installed image evidence owns actual confinement. */
import assert from "node:assert/strict";
import test from "node:test";
import type { PassThrough } from "node:stream";
import { SeptError } from "../../src/durable/index.js";
import type { DockerHandsConfiguration, HandsCommandExit } from "../../src/execution/contracts.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { HandsNativeChild } from "../../src/execution/hands-native-child.js";
import { HandsProcessOwner } from "../../src/execution/hands-process-owner.js";
import { suppliedEngine, engineFrame } from "./backend-support.js";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
type TerminationOrder = "limit-only" | "limit-before-overflow" | "overflow-before-limit";

void test("HandsProcessOwner preserves fatal overflow in both native kill orders and permits ordinary limit success", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  try {
    const owner = await HandsProcessOwner.open(configuration(fixture), engine, {
      pid: 42,
      start: "123",
    });
    for (const order of ["limit-only", "limit-before-overflow", "overflow-before-limit"] as const) {
      await exerciseNativeTermination(owner, engine, fixture, order);
    }
  } finally {
    try {
      await engine.close();
    } finally {
      await fixture.close();
    }
  }
});

function configuration(
  fixture: Awaited<ReturnType<typeof suppliedEngine>>,
): DockerHandsConfiguration {
  return {
    profile: "docker-linux-warm-v1",
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace: fixture.root,
    resources: fixture.root,
    dataDomain: "private",
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    shell: true,
    readOnlyMounts: [],
  };
}

async function exerciseNativeTermination(
  owner: HandsProcessOwner,
  engine: DockerEngineControl,
  fixture: Awaited<ReturnType<typeof suppliedEngine>>,
  order: TerminationOrder,
): Promise<void> {
  const first = Buffer.from("first match\n");
  fixture.facts.commandChunks = [engineFrame(1, first)];
  if (order !== "limit-only") {
    fixture.facts.commandChunks.push(
      engineFrame(1, Buffer.alloc(OUTPUT_LIMIT - first.length)),
      engineFrame(2, "x"),
    );
  }
  const exits: HandsCommandExit[] = [];
  const child = nativeChild(owner, exits);
  const restore = observeAttachment(engine, child, order);
  const errors: Error[] = [];
  child.on("error", (error: Error) => errors.push(error));
  child.stdout.on("data", () => {
    if (order !== "overflow-before-limit") {
      child.kill();
    }
  });
  child.stderr.resume();
  try {
    await new Promise<void>((resolve) => child.once("close", resolve));
    assert.equal(child.killed, true);
    assert.equal(exits[0]?.termination, order === "limit-only" ? "aborted" : "overflow");
    assert.equal(errors.length, order === "limit-only" ? 0 : 1);
    assert.ok(errors.every((error) => error instanceof SeptError));
    assert.equal(child.stdout.readableEnded, true);
    assert.equal(child.stderr.readableEnded, true);
    restore.assertJoined();
  } finally {
    restore.close();
  }
}

function nativeChild(owner: HandsProcessOwner, exits: HandsCommandExit[]): HandsNativeChild {
  return new HandsNativeChild(
    async (command, output, signal) => {
      assert.ok(signal);
      const exit = await owner.execute(
        { ...command, commandId: 1 },
        { network: false, signal, authorize: () => Promise.resolve() },
        (text, stream) => {
          output(Buffer.from(text), stream);
          return Promise.resolve();
        },
      );
      exits.push(exit);
      return exit;
    },
    "rg",
    [],
    "/workspace",
  );
}

function observeAttachment(
  engine: DockerEngineControl,
  child: HandsNativeChild,
  order: TerminationOrder,
): { close: () => void; assertJoined: () => void } {
  const attach = engine.attach.bind(engine);
  const exec = engine.exec.bind(engine);
  let namespaceJoins = 0;
  let attachmentJoined = false;
  engine.exec = async (id, execution) => {
    if (execution.command.includes("--join")) {
      namespaceJoins += 1;
    }
    return exec(id, execution);
  };
  engine.attach = async (id, execution) => {
    const attachment = await attach(id, execution);
    if (execution.commandOutput === true) {
      void attachment.joined.then(() => {
        attachmentJoined = true;
      });
      killAfterOverflow(attachment.output, child, order);
    }
    return attachment;
  };
  return {
    close: () => {
      engine.attach = attach;
      engine.exec = exec;
    },
    assertJoined: () => {
      assert.equal(namespaceJoins, 1);
      assert.equal(attachmentJoined, true);
    },
  };
}

function killAfterOverflow(
  output: PassThrough,
  child: HandsNativeChild,
  order: TerminationOrder,
): void {
  const chunks: AsyncIterator<unknown> = output[Symbol.asyncIterator]();
  output[Symbol.asyncIterator] = async function* () {
    let bytes = 0;
    for await (const raw of { [Symbol.asyncIterator]: () => chunks }) {
      const chunk: unknown = raw;
      assert.ok(typeof chunk === "object" && chunk !== null && "data" in chunk);
      assert.ok(Buffer.isBuffer(chunk.data));
      bytes += chunk.data.length;
      yield chunk;
      // Resume only after the owner has admitted or refused this exact chunk.
      if (bytes > OUTPUT_LIMIT && order === "overflow-before-limit") {
        child.kill();
      }
    }
    return undefined;
  };
}
