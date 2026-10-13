import { fixtureBackend } from "./backend-support.js";
/**
 * Verifies that the production PiSessionHost delegates cancellation to native Pi for both active
 * model requests and in-flight tools. Each fixture owns and closes its host, while assertions cover
 * cancellation races only through public results and durable event evidence.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import {
  AbortProviderStream,
  PiFixtureError,
  assistant,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  fixtureStream,
  registerFixtureProvider,
  streamOf,
} from "./support.js";

async function exerciseModelCancellation(): Promise<void> {
  const directories = fixtureDirectories("sept-pi-abort-");
  const runtime = await fixtureModelRuntime(directories.agentDir);
  let markStarted: () => void = () => {
    throw new PiFixtureError("model start resolver was not initialized");
  };
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  registerFixtureProvider(runtime, "sept-abort", (_model, _context, options) =>
    fixtureStream(new AbortProviderStream(options?.signal, markStarted)),
  );
  const store = fixtureStore(directories, "sept-abort", "abort model", "model-runs");
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: runtime, executionBackend: fixtureBackend(runtime) },
  );
  try {
    const running = assert.rejects(
      host.run("wait for cancellation"),
      /did not finish successfully/,
    );
    await started;
    await host.abort();
    await running;
    assert.equal(
      store.events(0, 1000).some((event) => event.type === "context_sample"),
      false,
    );
  } finally {
    await host.close();
  }
}

function blockingTool(markStarted: () => void, markAborted: () => void) {
  return defineTool({
    name: "blocking",
    description: "wait for cancellation",
    parameters: Type.Object({}),
    async execute(_params, _api, context) {
      const signal = context.abortSignal;
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
        } else {
          signal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        }
      });
      if (signal?.aborted) {
        markAborted();
      }
      throw new PiFixtureError("fixture tool was cancelled");
    },
  });
}

function registerToolAbortProvider(runtime: ModelRuntime): void {
  let providerCalls = 0;
  registerFixtureProvider(runtime, "sept-tool-abort", (_model, _context, options) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return streamOf(
        assistant(
          [{ type: "toolCall", id: "blocking", name: "blocking", arguments: {} }],
          10,
          "toolUse",
        ),
      );
    }
    return fixtureStream(new AbortProviderStream(options?.signal, () => undefined));
  });
}

async function exerciseToolCancellation(): Promise<void> {
  const directories = fixtureDirectories("sept-pi-tool-abort-");
  const runtime = await fixtureModelRuntime(directories.agentDir);
  registerToolAbortProvider(runtime);
  let startedResolve: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let signalAborted = false;
  const tool = blockingTool(startedResolve, () => {
    signalAborted = true;
  });
  const store = fixtureStore(directories, "sept-tool-abort", "abort tool", "tool-runs");
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    {
      modelRuntime: runtime,
      executionBackend: fixtureBackend(runtime),
      extensions: [defineExtension({ name: "blocking-fixture", tools: [tool] })],
    },
  );
  try {
    const running = assert.rejects(
      host.run("use the blocking tool"),
      /did not finish successfully/,
    );
    await started;
    await host.abort();
    await running;
    assert.equal(signalAborted, true);
    assert.equal(store.logTail().includes("tool_execution_end"), true);
  } finally {
    await host.close();
  }
}

await test("PiSessionHost abort uses Pi native cancellation for active model and tool work", async () => {
  await exerciseModelCancellation();
  await exerciseToolCancellation();
});
