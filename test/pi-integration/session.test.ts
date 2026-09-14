import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RunStore } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";

interface Event { type: string; [key: string]: unknown }
class ProviderStream implements AsyncIterable<Event> {
  private events: Event[] = [];
  private resolveResult!: (value: unknown) => void;
  private resultPromise = new Promise((resolve) => { this.resolveResult = resolve; });
  push(event: Event): void { this.events.push(event); if (event.type === "done") this.resolveResult(event.message); }
  async *[Symbol.asyncIterator](): AsyncGenerator<Event> { yield* this.events; }
  result(): Promise<unknown> { return this.resultPromise; }
}

class AbortProviderStream implements AsyncIterable<Event> {
  private readonly finalMessage = { role: "assistant", content: [{ type: "text", text: "" }], api: "test-api", provider: "sept-abort", model: "fixture", usage: usage(0, 0), stopReason: "aborted", timestamp: Date.now() };
  private readonly aborted: Promise<void>;
  constructor(signal: AbortSignal | undefined, started: () => void) {
    this.aborted = new Promise((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    started();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Event> {
    yield { type: "start", partial: this.finalMessage };
    await this.aborted;
  }
  async result(): Promise<unknown> { await this.aborted; return this.finalMessage; }
}

function usage(input: number, output = 1) { return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function assistant(content: unknown[], input: number, stopReason: "toolUse" | "stop") {
  return { role: "assistant", content, api: "test-api", provider: "sept-test", model: "fixture", usage: usage(input), stopReason, timestamp: Date.now() };
}
function streamOf(message: ReturnType<typeof assistant>): ProviderStream {
  const stream = new ProviderStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason, message });
  return stream;
}

function contextText(context: { systemPrompt?: string; messages: Array<{ content: string | Array<{ type: string; text?: string }> }> }): string {
  return [context.systemPrompt ?? "", ...context.messages.map((message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""))].join("\n");
}

test("PiSessionHost abort uses Pi native cancellation for active model and tool work", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-pi-abort-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace); mkdirSync(agentDir);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  let modelStarted!: () => void;
  const activeModel = new Promise<void>((resolve) => { modelStarted = resolve; });
  modelRuntime.registerProvider("sept-abort", {
    baseUrl: "http://127.0.0.1.invalid", apiKey: "test-only", api: "test-api",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 100 }],
    streamSimple: (_model, _context, options) => new AbortProviderStream(options?.signal, modelStarted) as never,
  });
  const modelStore = RunStore.create(join(root, "model-runs"), validateRequest({ task: "abort model", workspace, provider: "sept-abort", model: "fixture", thinking: "off" }, "0.85.1"));
  const modelHost = await PiSessionHost.create(modelStore.manifest(), modelStore, agentDir, undefined, NOOP_TELEMETRY, { modelRuntime, tools: [] });
  try {
    const running = modelHost.run("wait for cancellation");
    await activeModel;
    await modelHost.abort();
    const result = await running;
    assert.equal(result.text, "");
    assert.equal(result.contextTokens, null);
  } finally { await modelHost.close(); }

  let providerCalls = 0;
  let toolStarted!: () => void;
  const activeTool = new Promise<void>((resolve) => { toolStarted = resolve; });
  let toolSignalAborted = false;
  modelRuntime.registerProvider("sept-tool-abort", {
    baseUrl: "http://127.0.0.1.invalid", apiKey: "test-only", api: "test-api",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 100 }],
    streamSimple: (_model, _context, options) => {
      providerCalls++;
      if (providerCalls === 1) return streamOf(assistant([{ type: "toolCall", id: "blocking", name: "blocking", arguments: {} }], 10, "toolUse")) as never;
      return new AbortProviderStream(options?.signal, () => {}) as never;
    },
  });
  const blocking = defineTool({
    name: "blocking", label: "blocking", description: "wait for cancellation", parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      toolStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      toolSignalAborted = signal?.aborted === true;
      throw new Error("aborted fixture tool");
    },
  });
  const toolStore = RunStore.create(join(root, "tool-runs"), validateRequest({ task: "abort tool", workspace, provider: "sept-tool-abort", model: "fixture", thinking: "off" }, "0.85.1"));
  const toolHost = await PiSessionHost.create(toolStore.manifest(), toolStore, agentDir, undefined, NOOP_TELEMETRY, { modelRuntime, customTools: [blocking], tools: ["blocking"] });
  try {
    const running = toolHost.run("use the blocking tool");
    await activeTool;
    await toolHost.abort();
    await running;
    assert.equal(toolSignalAborted, true);
    assert.equal(toolStore.logTail().includes("tool_execution_end"), true);
  } finally { await toolHost.close(); }
});

test("production PiSessionHost uses the real SDK lifecycle, native steer/newSession, and untrusted project resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-pi-host-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
  mkdirSync(agentDir);
  const sentinel = join(root, "project-extension-executed");
  writeFileSync(join(workspace, ".pi", "extensions", "sentinel.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default function () {}\n`);
  writeFileSync(join(workspace, "AGENTS.md"), "PROJECT-CONTEXT-MARKER\n");

  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const calls: string[] = [];
  const toolsFinished: string[] = [];
  let providerCalls = 0;
  modelRuntime.registerProvider("sept-test", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only",
    api: "test-api",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 100 }],
    streamSimple: (_model, context) => {
      providerCalls++;
      const text = contextText(context as never);
      calls.push(text);
      if (providerCalls === 1) return streamOf(assistant([{ type: "text", text: JSON.stringify({ status: "continue" }) }], 10, "stop")) as never;
      if (providerCalls === 2) return streamOf(assistant([
        { type: "toolCall", id: "a", name: "atomic", arguments: { name: "a" } },
        { type: "toolCall", id: "b", name: "atomic", arguments: { name: "b" } },
      ], 110_000, "toolUse")) as never;
      if (providerCalls === 3) {
        assert.deepEqual(toolsFinished.sort(), ["a", "b"]);
        assert.match(text, /SEPT_CONTEXT_ROTATION/);
        return streamOf(assistant([{ type: "text", text: JSON.stringify({ handover: true }) }], 10, "stop")) as never;
      }
      assert.match(text, /fresh successor/i);
      return streamOf(assistant([{ type: "text", text: JSON.stringify({ status: "complete" }) }], 10, "stop")) as never;
    },
  });

  const atomic = defineTool({
    name: "atomic", label: "atomic", description: "atomic test tool", parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) { await new Promise((resolve) => setTimeout(resolve, 5)); toolsFinished.push(params.name); return { content: [{ type: "text", text: `finished ${params.name}` }], details: {} }; },
  });
  const stateRoot = join(root, "runs");
  const store = RunStore.create(stateRoot, validateRequest({ task: "exercise production host", workspace, provider: "sept-test", model: "fixture", thinking: "off" }, "0.85.1"));
  const host = await PiSessionHost.create(store.manifest(), store, agentDir, undefined, NOOP_TELEMETRY, { modelRuntime, customTools: [atomic], tools: ["atomic"] });
  try {
    assert.equal(existsSync(sentinel), false, "project-local extension code must not execute");
    const localHeuristicProbe = await host.run("x".repeat(100_000));
    assert.equal(localHeuristicProbe.steered, false, "local text length must not trigger rotation");
    assert.equal(localHeuristicProbe.contextTokens, 11);
    assert.match(calls[0], /PROJECT-CONTEXT-MARKER/, "untrusted mode must retain project context files");

    const rotated = await host.run("perform the atomic batch");
    assert.equal(rotated.steered, true);
    assert.equal(providerCalls, 3);
    assert.deepEqual(toolsFinished.sort(), ["a", "b"]);
    assert.equal(store.events(0, 1000).filter((event) => event.type === "rotation_steer_queued").length, 1);
    assert.equal(store.events(0, 1000).filter((event) => event.type === "pi_compaction_violation").length, 0);

    const predecessor = host.sessionId;
    const replacement = await host.newSession();
    assert.equal(replacement.predecessorId, predecessor);
    assert.notEqual(replacement.successorId, predecessor);
    const successor = await host.run("fresh successor receives full handover");
    assert.equal(successor.steered, false);
    assert.equal(providerCalls, 4);
    assert.equal(existsSync(sentinel), false);
  } finally { await host.close(); }
});
