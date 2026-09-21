import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentSession, ModelRuntime, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RunStore } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import { ROTATION_STEER } from "../../src/pi-integration/prompts.js";
import { CycleController } from "../../src/runtime/index.js";

interface Event {
  type: string;
  [key: string]: unknown;
}
class ProviderStream implements AsyncIterable<Event> {
  private events: Event[] = [];
  private resolveResult!: (value: unknown) => void;
  private resultPromise = new Promise((resolve) => {
    this.resolveResult = resolve;
  });
  push(event: Event): void {
    this.events.push(event);
    if (event.type === "done") this.resolveResult(event.message);
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Event> {
    yield* this.events;
  }
  result(): Promise<unknown> {
    return this.resultPromise;
  }
}

class AbortProviderStream implements AsyncIterable<Event> {
  private readonly finalMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "test-api",
    provider: "sept-abort",
    model: "fixture",
    usage: usage(0, 0),
    stopReason: "aborted",
    timestamp: Date.now(),
  };
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
  async result(): Promise<unknown> {
    await this.aborted;
    return this.finalMessage;
  }
}

function usage(input: number, output = 1) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function assistant(content: unknown[], input: number, stopReason: "toolUse" | "stop") {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "sept-test",
    model: "fixture",
    usage: usage(input),
    stopReason,
    timestamp: Date.now(),
  };
}
function streamOf(message: ReturnType<typeof assistant>): ProviderStream {
  const stream = new ProviderStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason, message });
  return stream;
}

function contextText(context: {
  systemPrompt?: string;
  messages: Array<{ content: string | Array<{ type: string; text?: string }> }>;
}): string {
  return [
    context.systemPrompt ?? "",
    ...context.messages.map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join(""),
    ),
  ].join("\n");
}

test("PiSessionHost abort uses Pi native cancellation for active model and tool work", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-pi-abort-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace);
  mkdirSync(agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let modelStarted!: () => void;
  const activeModel = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  modelRuntime.registerProvider("sept-abort", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only",
    api: "test-api",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 100,
      },
    ],
    streamSimple: (_model, _context, options) =>
      new AbortProviderStream(options?.signal, modelStarted) as never,
  });
  const modelStore = RunStore.create(
    join(root, "model-runs"),
    validateRequest(
      { task: "abort model", workspace, provider: "sept-abort", model: "fixture", thinking: "off" },
      "0.85.1",
    ),
  );
  const modelHost = await PiSessionHost.create(
    modelStore.manifest(),
    modelStore,
    agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime, tools: [] },
  );
  try {
    const running = modelHost.run("wait for cancellation");
    await activeModel;
    await modelHost.abort();
    const result = await running;
    assert.equal(result.text, "");
    assert.equal(result.contextTokens, null);
  } finally {
    await modelHost.close();
  }

  let providerCalls = 0;
  let toolStarted!: () => void;
  const activeTool = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  let toolSignalAborted = false;
  modelRuntime.registerProvider("sept-tool-abort", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only",
    api: "test-api",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 100,
      },
    ],
    streamSimple: (_model, _context, options) => {
      providerCalls++;
      if (providerCalls === 1)
        return streamOf(
          assistant(
            [{ type: "toolCall", id: "blocking", name: "blocking", arguments: {} }],
            10,
            "toolUse",
          ),
        ) as never;
      return new AbortProviderStream(options?.signal, () => {}) as never;
    },
  });
  const blocking = defineTool({
    name: "blocking",
    label: "blocking",
    description: "wait for cancellation",
    parameters: Type.Object({}),
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
  const toolStore = RunStore.create(
    join(root, "tool-runs"),
    validateRequest(
      {
        task: "abort tool",
        workspace,
        provider: "sept-tool-abort",
        model: "fixture",
        thinking: "off",
      },
      "0.85.1",
    ),
  );
  const toolHost = await PiSessionHost.create(
    toolStore.manifest(),
    toolStore,
    agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime, customTools: [blocking], tools: ["blocking"] },
  );
  try {
    const running = toolHost.run("use the blocking tool");
    await activeTool;
    await toolHost.abort();
    await running;
    assert.equal(toolSignalAborted, true);
    assert.equal(toolStore.logTail().includes("tool_execution_end"), true);
  } finally {
    await toolHost.close();
  }
});

test("production PiSessionHost uses the real SDK lifecycle, native steer/newSession, and untrusted project resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-pi-host-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
  mkdirSync(agentDir);
  const sentinel = join(root, "project-extension-executed");
  writeFileSync(
    join(workspace, ".pi", "extensions", "sentinel.ts"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default function () {}\n`,
  );
  writeFileSync(join(workspace, "AGENTS.md"), "PROJECT-CONTEXT-MARKER\n");

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const calls: string[] = [];
  const toolsFinished: string[] = [];
  let providerCalls = 0;
  modelRuntime.registerProvider("sept-test", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only",
    api: "test-api",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 100,
      },
    ],
    streamSimple: (_model, context) => {
      providerCalls++;
      const text = contextText(context as never);
      calls.push(text);
      if (providerCalls === 1)
        return streamOf(
          assistant([{ type: "text", text: JSON.stringify({ status: "continue" }) }], 10, "stop"),
        ) as never;
      if (providerCalls === 2)
        return streamOf(
          assistant(
            [
              { type: "toolCall", id: "a", name: "atomic", arguments: { name: "a" } },
              { type: "toolCall", id: "b", name: "atomic", arguments: { name: "b" } },
            ],
            110_000,
            "toolUse",
          ),
        ) as never;
      if (providerCalls === 3) {
        assert.deepEqual(toolsFinished.sort(), ["a", "b"]);
        assert.match(text, /SEPT_CONTEXT_ROTATION/);
        return streamOf(
          assistant([{ type: "text", text: JSON.stringify({ handover: true }) }], 10, "stop"),
        ) as never;
      }
      assert.match(text, /fresh successor/i);
      return streamOf(
        assistant([{ type: "text", text: JSON.stringify({ status: "complete" }) }], 10, "stop"),
      ) as never;
    },
  });

  const atomic = defineTool({
    name: "atomic",
    label: "atomic",
    description: "atomic test tool",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      toolsFinished.push(params.name);
      return { content: [{ type: "text", text: `finished ${params.name}` }], details: {} };
    },
  });
  const stateRoot = join(root, "runs");
  const store = RunStore.create(
    stateRoot,
    validateRequest(
      {
        task: "exercise production host",
        workspace,
        provider: "sept-test",
        model: "fixture",
        thinking: "off",
      },
      "0.85.1",
    ),
  );
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime, customTools: [atomic], tools: ["atomic"] },
  );
  try {
    assert.equal(existsSync(sentinel), false, "project-local extension code must not execute");
    const localHeuristicProbe = await host.run("x".repeat(100_000));
    assert.equal(localHeuristicProbe.steered, false, "local text length must not trigger rotation");
    assert.equal(localHeuristicProbe.contextTokens, 11);
    assert.match(
      calls[0],
      /PROJECT-CONTEXT-MARKER/,
      "untrusted mode must retain project context files",
    );

    const rotated = await host.run("perform the atomic batch");
    assert.equal(rotated.steered, true);
    assert.equal(providerCalls, 3);
    assert.deepEqual(toolsFinished.sort(), ["a", "b"]);
    assert.equal(
      store.events(0, 1000).filter((event) => event.type === "rotation_steer_queued").length,
      1,
    );
    assert.equal(
      store.events(0, 1000).filter((event) => event.type === "pi_compaction_violation").length,
      0,
    );

    const predecessor = host.sessionId;
    const replacement = await host.newSession();
    assert.equal(replacement.predecessorId, predecessor);
    assert.notEqual(replacement.successorId, predecessor);
    const successor = await host.run("fresh successor receives full handover");
    assert.equal(successor.steered, false);
    assert.equal(providerCalls, 4);
    assert.equal(existsSync(sentinel), false);
  } finally {
    await host.close();
  }
});

test("persistent unusable finalized usage blocks only after the active Pi invocation reaches a safe seam", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-pi-unusable-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace);
  mkdirSync(agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let calls = 0;
  let tools = 0;
  const unusable = (content: unknown[], stopReason: "toolUse" | "stop") => ({
    role: "assistant",
    content,
    api: "test-api",
    provider: "sept-unusable",
    model: "fixture",
    usage: usage(0, 0),
    stopReason,
    timestamp: Date.now(),
  });
  modelRuntime.registerProvider("sept-unusable", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only",
    api: "test-api",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 100,
      },
    ],
    streamSimple: () => {
      calls++;
      if (calls <= 3)
        return streamOf(
          unusable(
            [{ type: "toolCall", id: `step-${calls}`, name: "step", arguments: {} }],
            "toolUse",
          ) as never,
        ) as never;
      return streamOf(
        unusable([{ type: "text", text: "finished active work" }], "stop") as never,
      ) as never;
    },
  });
  const step = defineTool({
    name: "step",
    label: "step",
    description: "complete active work",
    parameters: Type.Object({}),
    async execute() {
      tools++;
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  });
  const store = RunStore.create(
    join(root, "runs"),
    validateRequest(
      {
        task: "usage compatibility",
        workspace,
        provider: "sept-unusable",
        model: "fixture",
        thinking: "off",
      },
      "0.85.1",
    ),
  );
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime, customTools: [step], tools: ["step"] },
  );
  try {
    await assert.rejects(
      host.run("finish the active tool chain"),
      /incompatible with safe autonomous rollover/,
    );
    assert.equal(tools, 3);
    assert.equal(calls, 4);
    assert.equal(
      store.events(0, 1000).filter((event) => event.type === "context_sample_deferred").length,
      4,
    );
  } finally {
    await host.close();
  }
});

test("a durable rotation flag reuses an already completed Pi steer after restart without duplicate steering", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-pi-rotation-restart-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace);
  mkdirSync(agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let calls = 0;
  const handover = JSON.stringify({
    handover_summary: "durable",
    entry_state_and_done: "continue",
    completed: [],
    in_flight: [],
    not_started: [],
    decisions: [],
    rejected_approaches: [],
    verification: [],
    uncertainties: [],
    references: [],
    lessons: [],
    next_action: "continue",
  });
  modelRuntime.registerProvider("sept-restart", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only",
    api: "test-api",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 100,
      },
    ],
    streamSimple: () => {
      calls++;
      return streamOf(
        assistant(
          [{ type: "text", text: calls === 1 ? "pre-rotation progress" : handover }],
          calls === 1 ? 110_000 : 10,
          "stop",
        ),
      ) as never;
    },
  });
  const store = RunStore.create(
    join(root, "runs"),
    validateRequest(
      {
        task: "restart rotation",
        workspace,
        provider: "sept-restart",
        model: "fixture",
        thinking: "off",
      },
      "0.85.1",
    ),
  );
  const first = await PiSessionHost.create(
    store.manifest(),
    store,
    agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime, tools: [] },
  );
  const rotated = await first.run("trigger rotation");
  const sessionFile = first.sessionFile;
  assert.equal(rotated.steered, true);
  assert.equal(calls, 2);
  assert.ok(sessionFile);
  await first.close();

  const resumed = await PiSessionHost.create(
    store.manifest(),
    store,
    agentDir,
    sessionFile,
    NOOP_TELEMETRY,
    { modelRuntime, tools: [] },
  );
  try {
    const recovered = await resumed.run("must not become another provider call");
    assert.equal(recovered.text, handover);
    assert.equal(recovered.preRotationText, "pre-rotation progress");
    assert.equal(recovered.steered, true);
    assert.equal(calls, 2);
    assert.equal(
      store.events(0, 1000).filter((event) => event.type === "rotation_steer_queued").length,
      1,
    );
  } finally {
    await resumed.close();
  }
});

test("restart after an interrupted steered handover uses one native steer, commits handover first, and creates a fresh successor", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-pi-rotation-interrupted-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace);
  mkdirSync(agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const progressMessage = "Public progress survives the interrupted handover.";
  const progress = JSON.stringify({
    message: progressMessage,
    control: {
      status: "continue",
      summary: "rotate next",
      verification: ["progress complete"],
      next_action: "prepare handover",
    },
  });
  const handover = JSON.stringify({
    handover_summary: "recovered interrupted handover",
    entry_state_and_done: "continue in a fresh session",
    completed: ["native steer persisted"],
    in_flight: [],
    not_started: ["finish"],
    decisions: [],
    rejected_approaches: [],
    verification: ["recovered"],
    uncertainties: [],
    references: [],
    lessons: [],
    next_action: "finish",
  });
  const complete = JSON.stringify({
    message: "recovered rotation completed",
    control: {
      status: "complete",
      summary: "done",
      verification: ["fresh successor"],
      next_action: "",
    },
  });
  let calls = 0;
  let handoverCallStarted!: () => void;
  const handoverStarted = new Promise<void>((resolve) => {
    handoverCallStarted = resolve;
  });
  const contexts: string[] = [];
  modelRuntime.registerProvider("sept-interrupted", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only",
    api: "test-api",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 100,
      },
    ],
    streamSimple: (_model, context, options) => {
      calls++;
      contexts.push(contextText(context as never));
      if (calls === 1)
        return streamOf(assistant([{ type: "text", text: progress }], 110_000, "stop")) as never;
      if (calls === 2)
        return new AbortProviderStream(options?.signal, handoverCallStarted) as never;
      if (calls === 3)
        return streamOf(assistant([{ type: "text", text: handover }], 10, "stop")) as never;
      return streamOf(assistant([{ type: "text", text: complete }], 10, "stop")) as never;
    },
  });
  const store = RunStore.create(
    join(root, "runs"),
    validateRequest(
      {
        task: "recover interrupted rotation",
        workspace,
        provider: "sept-interrupted",
        model: "fixture",
        thinking: "off",
      },
      "0.85.1",
    ),
  );
  const originalSteer = AgentSession.prototype.steer;
  let nativeSteers = 0;
  AgentSession.prototype.steer = function (text, images) {
    nativeSteers++;
    return originalSteer.call(this, text, images);
  };
  try {
    const first = await PiSessionHost.create(
      store.manifest(),
      store,
      agentDir,
      undefined,
      NOOP_TELEMETRY,
      { modelRuntime, tools: [] },
    );
    const interruptedRun = first.run("trigger the interrupted rotation");
    await handoverStarted;
    await first.abort();
    const interrupted = await interruptedRun;
    const predecessorId = first.sessionId;
    const predecessorFile = first.sessionFile;
    assert.equal(interrupted.steered, true);
    assert.equal(interrupted.text, "");
    assert.ok(predecessorFile);
    store.update({
      phase: "running",
      invocations: 1,
      activeSessionId: predecessorId,
      activeSessionFile: predecessorFile,
    });
    await first.close();

    const controller = new CycleController(
      store,
      agentDir,
      (manifest, runStore, directory, existing, telemetry) =>
        PiSessionHost.create(manifest, runStore, directory, existing, telemetry, {
          modelRuntime,
          tools: [],
        }),
    );
    await controller.run();

    const events = store.events(0, 1000);
    const handoverIndex = events.findIndex((event) => event.type === "handover_written");
    const successorIndex = events.findIndex((event) => event.type === "successor_session_started");
    const successor = events[successorIndex] as { successorId?: string };
    assert.equal(nativeSteers, 1);
    assert.equal(events.filter((event) => event.type === "rotation_steer_queued").length, 1);
    assert.equal(
      contexts[2].split(ROTATION_STEER).length - 1,
      1,
      "restart must not inject the steer text a second time",
    );
    assert.match(contexts[2], /SEPT_CONTEXT_ROTATION_RECOVERY/);
    assert.ok(
      handoverIndex >= 0 && handoverIndex < successorIndex,
      "durable handover must precede fresh-session replacement",
    );
    assert.notEqual(successor.successorId, predecessorId);
    const assistantConversation = store
      .conversation(0, 100)
      .events.flatMap((event) =>
        event.type === "message" && event.role === "assistant" ? [event.text] : [],
      );
    assert.deepEqual(
      assistantConversation,
      [progressMessage, "recovered rotation completed"],
      "pre-rotation public progress must appear exactly once before successor completion",
    );
    assert.equal(store.snapshot().epoch, 2);
    assert.equal(store.snapshot().status, "complete");
    assert.equal(calls, 4);
  } finally {
    AgentSession.prototype.steer = originalSteer;
  }
});
