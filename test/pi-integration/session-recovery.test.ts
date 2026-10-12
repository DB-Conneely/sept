/**
 * Verifies restart recovery at both sides of the native rotation boundary. Completed handovers are
 * reused without provider work; interrupted handovers resume without duplicate steer, become
 * durable before native fresh-session replacement, and preserve public progress exactly once.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import { ROTATION_STEER } from "../../src/pi-integration/prompts.js";
import { CycleController } from "../../src/runtime/index.js";
import {
  AbortProviderStream,
  PiFixtureError,
  assistant,
  contextText,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  fixtureStream,
  registerFixtureProvider,
  streamOf,
  type PiFixtureDirectories,
} from "./support.js";

interface InterruptedPredecessor {
  predecessorId: string;
  predecessorFile: string;
}

function handoverText(summary: string, nextAction: string): string {
  return JSON.stringify({
    handover_summary: summary,
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
    next_action: nextAction,
  });
}

async function completedPredecessor(
  directories: PiFixtureDirectories,
  runtime: ModelRuntime,
  store: ReturnType<typeof fixtureStore>,
): Promise<string> {
  const first = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: runtime, tools: [] },
  );
  const rotated = await first.run("trigger rotation");
  const sessionFile = first.sessionFile;
  assert.equal(rotated.steered, true);
  assert.ok(sessionFile);
  await first.close();
  return sessionFile;
}

async function exerciseCompletedRecovery(): Promise<void> {
  const directories = fixtureDirectories("sept-pi-rotation-restart-");
  const runtime = await fixtureModelRuntime(directories.agentDir);
  const handover = handoverText("durable", "continue");
  let calls = 0;
  registerFixtureProvider(runtime, "sept-restart", () => {
    calls += 1;
    const text = calls === 1 ? "pre-rotation progress" : handover;
    return streamOf(assistant([{ type: "text", text }], calls === 1 ? 110_000 : 10, "stop"));
  });
  const store = fixtureStore(directories, "sept-restart", "restart rotation");
  const sessionFile = await completedPredecessor(directories, runtime, store);
  assert.equal(calls, 2);
  const resumed = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    sessionFile,
    NOOP_TELEMETRY,
    { modelRuntime: runtime, tools: [] },
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
}

await test(
  "durable rotation reuses an already completed Pi steer after restart without duplicate steering",
  exerciseCompletedRecovery,
);

function interruptedResponses(): { progress: string; handover: string; complete: string } {
  const progress = JSON.stringify({
    message: "Public progress survives the interrupted handover.",
    control: {
      status: "continue",
      summary: "rotate next",
      verification: ["progress complete"],
      next_action: "prepare handover",
    },
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
  return { progress, handover: handoverText("recovered interrupted handover", "finish"), complete };
}

function registerInterruptedProvider(
  runtime: ModelRuntime,
  responses: ReturnType<typeof interruptedResponses>,
  contexts: string[],
  handoverStarted: () => void,
  calls: { count: number },
): void {
  registerFixtureProvider(runtime, "sept-interrupted", (_model, context, options) => {
    calls.count += 1;
    contexts.push(contextText(context));
    if (calls.count === 1) {
      return streamOf(assistant([{ type: "text", text: responses.progress }], 110_000, "stop"));
    }
    if (calls.count === 2) {
      return fixtureStream(new AbortProviderStream(options?.signal, handoverStarted));
    }
    if (calls.count === 3) {
      return streamOf(assistant([{ type: "text", text: responses.handover }], 10, "stop"));
    }
    return streamOf(assistant([{ type: "text", text: responses.complete }], 10, "stop"));
  });
}

async function interruptPredecessor(
  directories: PiFixtureDirectories,
  runtime: ModelRuntime,
  store: ReturnType<typeof fixtureStore>,
  handoverStarted: Promise<void>,
): Promise<InterruptedPredecessor> {
  const first = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: runtime, tools: [] },
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
  return { predecessorId, predecessorFile };
}

async function recoverWithController(
  directories: PiFixtureDirectories,
  runtime: ModelRuntime,
  store: ReturnType<typeof fixtureStore>,
): Promise<void> {
  const controller = new CycleController(
    store,
    directories.agentDir,
    (manifest, runStore, directory, existing, telemetry) =>
      PiSessionHost.create(manifest, runStore, directory, existing, telemetry, {
        modelRuntime: runtime,
        tools: [],
      }),
  );
  await controller.run();
}

function assertRecoveredEvidence(
  store: ReturnType<typeof fixtureStore>,
  predecessorId: string,
  contexts: string[],
  calls: number,
  nativeSteers: number,
): void {
  const events = store.events(0, 1000);
  const handoverIndex = events.findIndex((event) => event.type === "handover_written");
  const successorIndex = events.findIndex((event) => event.type === "successor_session_started");
  const successor = events[successorIndex];
  const recoveryContext = contexts[2];
  assert.ok(successor !== undefined && "successorId" in successor);
  assert.ok(recoveryContext !== undefined);
  assert.equal(nativeSteers, 1);
  assert.equal(events.filter((event) => event.type === "rotation_steer_queued").length, 1);
  assert.equal(recoveryContext.split(ROTATION_STEER).length - 1, 1);
  assert.match(recoveryContext, /SEPT_CONTEXT_ROTATION_RECOVERY/);
  assert.ok(handoverIndex >= 0 && handoverIndex < successorIndex);
  assert.notEqual(successor.successorId, predecessorId);
  const conversation = store
    .conversation(0, 100)
    .events.flatMap((event) =>
      event.type === "message" && event.role === "assistant" ? [event.text] : [],
    );
  assert.deepEqual(conversation, [
    "Public progress survives the interrupted handover.",
    "recovered rotation completed",
  ]);
  assert.equal(store.snapshot().epoch, 2);
  assert.equal(store.snapshot().status, "complete");
  assert.equal(calls, 4);
}

await test("interrupted runPiInvocation recovery uses one native steer and durable handover before successor", async () => {
  const directories = fixtureDirectories("sept-pi-rotation-interrupted-");
  const runtime = await fixtureModelRuntime(directories.agentDir);
  const responses = interruptedResponses();
  const contexts: string[] = [];
  const calls = { count: 0 };
  let signalStarted: () => void = () => {
    throw new PiFixtureError("handover start resolver missing");
  };
  const handoverStarted = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  registerInterruptedProvider(runtime, responses, contexts, signalStarted, calls);
  const store = fixtureStore(directories, "sept-interrupted", "recover interrupted rotation");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The prototype function is restored verbatim after a dynamic-this spy.
  const originalSteer = AgentSession.prototype.steer;
  let nativeSteers = 0;
  AgentSession.prototype.steer = function (text, images) {
    nativeSteers += 1;
    return originalSteer.call(this, text, images);
  };
  try {
    const predecessor = await interruptPredecessor(directories, runtime, store, handoverStarted);
    await recoverWithController(directories, runtime, store);
    assertRecoveredEvidence(store, predecessor.predecessorId, contexts, calls.count, nativeSteers);
  } finally {
    AgentSession.prototype.steer = originalSteer;
  }
});
