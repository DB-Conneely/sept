/**
 * Exercises the installed native Pi lifecycle through the production host: untrusted project
 * loading, finalized-usage rotation after atomic tools, native fresh-session replacement, and
 * fail-closed handling of persistently unusable usage. Hosts are always disposed by their owners.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { defineTool, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { PiSessionHost, type SessionHost } from "../../src/pi-integration/index.js";
import {
  assistant,
  contextText,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  registerFixtureProvider,
  streamOf,
  usage,
  type PiFixtureDirectories,
} from "./support.js";

function registerLifecycleProvider(
  runtime: ModelRuntime,
  calls: string[],
  toolsFinished: string[],
): void {
  let providerCalls = 0;
  registerFixtureProvider(runtime, "sept-test", (_model, context) => {
    providerCalls += 1;
    const text = contextText(context);
    calls.push(text);
    if (providerCalls === 1) {
      return streamOf(assistant([{ type: "text", text: '{"status":"continue"}' }], 10, "stop"));
    }
    if (providerCalls === 2) {
      return streamOf(
        assistant(
          [
            { type: "toolCall", id: "a", name: "atomic", arguments: { name: "a" } },
            { type: "toolCall", id: "b", name: "atomic", arguments: { name: "b" } },
          ],
          110_000,
          "toolUse",
        ),
      );
    }
    if (providerCalls === 3) {
      assert.deepEqual(toolsFinished.toSorted(), ["a", "b"]);
      assert.match(text, /SEPT_CONTEXT_ROTATION/);
      return streamOf(assistant([{ type: "text", text: '{"handover":true}' }], 10, "stop"));
    }
    assert.match(text, /fresh successor/i);
    return streamOf(assistant([{ type: "text", text: '{"status":"complete"}' }], 10, "stop"));
  });
}

function atomicTool(toolsFinished: string[]) {
  return defineTool({
    name: "atomic",
    label: "atomic",
    description: "atomic test tool",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, parameters) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      toolsFinished.push(parameters.name);
      return { content: [{ type: "text", text: `finished ${parameters.name}` }], details: {} };
    },
  });
}

async function createLifecycleHost(
  directories: PiFixtureDirectories,
  sentinel: string,
  calls: string[],
  toolsFinished: string[],
): Promise<{ host: PiSessionHost; store: ReturnType<typeof fixtureStore> }> {
  mkdirSync(join(directories.workspace, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(directories.workspace, ".pi", "extensions", "sentinel.ts"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default function () {}\n`,
  );
  writeFileSync(join(directories.workspace, "AGENTS.md"), "PROJECT-CONTEXT-MARKER\n");
  const runtime = await fixtureModelRuntime(directories.agentDir);
  registerLifecycleProvider(runtime, calls, toolsFinished);
  const store = fixtureStore(directories, "sept-test", "exercise production host");
  const tool = atomicTool(toolsFinished);
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: runtime, customTools: [tool], tools: ["atomic"] },
  );
  return { host, store };
}

async function exerciseRotation(
  host: SessionHost,
  store: ReturnType<typeof fixtureStore>,
  calls: string[],
  toolsFinished: string[],
  sentinel: string,
): Promise<void> {
  assert.equal(existsSync(sentinel), false, "project-local extension code must not execute");
  const localHeuristicProbe = await host.run("x".repeat(100_000));
  assert.equal(localHeuristicProbe.steered, false, "local text length must not trigger rotation");
  assert.equal(localHeuristicProbe.contextTokens, 11);
  assert.match(calls[0] ?? "", /PROJECT-CONTEXT-MARKER/);
  const rotated = await host.run("perform the atomic batch");
  assert.equal(rotated.steered, true);
  assert.deepEqual(toolsFinished.toSorted(), ["a", "b"]);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "rotation_steer_queued").length,
    1,
  );
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "pi_compaction_violation").length,
    0,
  );
}

async function exerciseFreshSession(host: SessionHost, sentinel: string): Promise<void> {
  const predecessor = host.sessionId;
  const replacement = await host.newSession();
  assert.equal(replacement.predecessorId, predecessor);
  assert.notEqual(replacement.successorId, predecessor);
  const successor = await host.run("fresh successor receives full handover");
  assert.equal(successor.steered, false);
  assert.equal(existsSync(sentinel), false);
}

await test("production PiSessionHost uses real SDK lifecycle, native steer/newSession, and untrusted resources", async () => {
  const directories = fixtureDirectories("sept-pi-host-");
  const sentinel = join(directories.root, "project-extension-executed");
  const calls: string[] = [];
  const toolsFinished: string[] = [];
  const { host, store } = await createLifecycleHost(directories, sentinel, calls, toolsFinished);
  try {
    await exerciseRotation(host, store, calls, toolsFinished, sentinel);
    await exerciseFreshSession(host, sentinel);
    assert.equal(calls.length, 4);
  } finally {
    await host.close();
  }
});

function unusableAssistant(content: unknown[], stopReason: "toolUse" | "stop") {
  return { ...assistant(content, 0, stopReason), usage: usage(0, 0) };
}

function registerUnusableProvider(runtime: ModelRuntime, counts: { provider: number }): void {
  registerFixtureProvider(runtime, "sept-unusable", () => {
    counts.provider += 1;
    const message =
      counts.provider <= 3
        ? unusableAssistant(
            [
              {
                type: "toolCall",
                id: `step-${String(counts.provider)}`,
                name: "step",
                arguments: {},
              },
            ],
            "toolUse",
          )
        : unusableAssistant([{ type: "text", text: "finished active work" }], "stop");
    return streamOf(message);
  });
}

function countingStep(counts: { tool: number }) {
  return defineTool({
    name: "step",
    label: "step",
    description: "complete active work",
    parameters: Type.Object({}),
    execute: () => {
      counts.tool += 1;
      return Promise.resolve({ content: [{ type: "text", text: "done" }], details: {} });
    },
  });
}

async function exerciseUnusableUsage(): Promise<void> {
  const directories = fixtureDirectories("sept-pi-unusable-");
  const runtime = await fixtureModelRuntime(directories.agentDir);
  const counts = { provider: 0, tool: 0 };
  registerUnusableProvider(runtime, counts);
  const step = countingStep(counts);
  const store = fixtureStore(directories, "sept-unusable", "usage compatibility");
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: runtime, customTools: [step], tools: ["step"] },
  );
  try {
    await assert.rejects(
      host.run("finish the active tool chain"),
      /incompatible with safe autonomous rollover/,
    );
    assert.deepEqual(counts, { provider: 4, tool: 3 });
    assert.equal(
      store.events(0, 1000).filter((event) => event.type === "context_sample_deferred").length,
      4,
    );
  } finally {
    await host.close();
  }
}

await test(
  "persistent unusable finalized usage blocks only after the active Pi invocation reaches a safe seam",
  exerciseUnusableUsage,
);
