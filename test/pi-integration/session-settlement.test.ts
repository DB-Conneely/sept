/** Replays real native settlement across domain checkpoints without duplicating accepted input/work. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  PiSessionHost,
  initialPrompt,
  continuationPrompt,
} from "../../src/pi-integration/index.js";
import { CycleController } from "../../src/runtime/index.js";
import { DurableSubmission } from "../../src/pi-integration/durable-submission.js";
import { readInvocationAdmission } from "../../src/pi-integration/durable-admission.js";
import {
  assistant,
  contextText,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  registerFixtureProvider,
  streamOf,
} from "./support.js";
import { AbortProviderStream, fixtureStream, PiFixtureError } from "./support.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const complete = JSON.stringify({
  message: "Settled native work is reused.",
  control: { status: "complete", summary: "done", verification: [], next_action: "" },
});

async function settledFixture(startingInvocation = 1) {
  const directories = fixtureDirectories("sept-native-settled-");
  const models = await fixtureModelRuntime(directories.agentDir);
  const store = fixtureStore(directories, "settlement", "settlement boundary");
  let calls = 0;
  const contexts: string[] = [];
  registerFixtureProvider(models, "settlement", (_model, context) => {
    calls += 1;
    contexts.push(contextText(context));
    return streamOf(assistant([{ type: "text", text: complete }], 10, "stop"));
  });
  const factory: ConstructorParameters<typeof CycleController>[2] = (
    manifest,
    store,
    agent,
    existing,
    telemetry,
  ) => PiSessionHost.create(manifest, store, agent, existing, telemetry, { modelRuntime: models });
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    undefined,
    { modelRuntime: models },
  );
  store.update({
    phase: "running",
    invocations: startingInvocation,
    activeSessionId: host.sessionId,
    activeSessionFile: host.sessionFile,
  });
  return { directories, store, host, factory, calls: () => calls, contexts };
}

await test("DurableSubmission reuses done native work before the domain checkpoint at the invocation limit", async () => {
  const fixture = await settledFixture(100);
  const result = await fixture.host.run(initialPrompt(fixture.store.manifest()), []);
  assert.equal(result.text, complete);
  await fixture.host.close();
  await new CycleController(fixture.store, fixture.directories.agentDir, fixture.factory).run();
  assert.equal(fixture.calls(), 1);
  assert.equal(fixture.store.snapshot().invocations, 100);
  assert.equal(fixture.store.snapshot().status, "complete");
  assert.equal(readInvocationAdmission(fixture.store)?.checkpointed, true);
  assert.equal(
    fixture.store
      .conversation()
      .events.filter((event) => event.type === "message" && event.role === "assistant").length,
    1,
  );
  assert.equal(typeof DurableSubmission, "function");
});

await test("settled recovery delivers the exact before/after-admission messages once before consumption", async () => {
  const fixture = await settledFixture();
  const first = fixture.store.enqueueMessage("  before\n  admission  ");
  const prompt = continuationPrompt(
    { status: "continue", summary: "apply", verification: [], next_action: "apply" },
    [first],
  );
  await fixture.host.run(prompt, [first]);
  await fixture.host.close();
  const second = fixture.store.enqueueMessage("  after\n  admission  ");
  await new CycleController(fixture.store, fixture.directories.agentDir, fixture.factory).run();
  assert.equal(fixture.calls(), 2);
  assert.equal(fixture.contexts[0]?.split("before\\n  admission").length, 2);
  assert.equal(fixture.contexts[1]?.split("before\\n  admission").length, 2);
  assert.equal(fixture.contexts[1].split("after\\n  admission").length, 2);
  assert.deepEqual(fixture.store.pendingMessages(), []);
  const checkpoints = fixture.store
    .events(0, 1000)
    .filter((event) => event.type === "work_checkpoint");
  assert.deepEqual(checkpoints.at(-1)?.messageIds, [first.id, second.id]);
});

async function unansweredFixture() {
  const directories = fixtureDirectories("sept-native-unanswered-");
  const models = await fixtureModelRuntime(directories.agentDir);
  const store = fixtureStore(directories, "unanswered", "unanswered boundary");
  let calls = 0;
  let markStarted: () => void = () => {
    throw new PiFixtureError("unanswered start resolver missing");
  };
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  registerFixtureProvider(models, "unanswered", (_model, _context, options) => {
    calls += 1;
    return fixtureStream(new AbortProviderStream(options?.signal, markStarted));
  });
  const factory: ConstructorParameters<typeof CycleController>[2] = (
    manifest,
    store,
    agent,
    existing,
    telemetry,
  ) => PiSessionHost.create(manifest, store, agent, existing, telemetry, { modelRuntime: models });
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    undefined,
    { modelRuntime: models },
  );
  store.update({
    phase: "running",
    invocations: 1,
    activeSessionId: host.sessionId,
    activeSessionFile: host.sessionFile,
  });
  return { directories, store, host, factory, started, calls: () => calls };
}

await test("unanswered native work rejects recovery before forwarding accepted later input or generating again", async () => {
  const fixture = await unansweredFixture();
  const running = assert.rejects(
    fixture.host.run("interrupt before the domain settlement"),
    /did not finish successfully/,
  );
  await fixture.started;
  await fixture.host.abort();
  await running;
  await fixture.host.close();
  const message = fixture.store.enqueueMessage("accepted before domain failure was published");
  await assert.rejects(
    new CycleController(fixture.store, fixture.directories.agentDir, fixture.factory).run(),
    /did not finish successfully/,
  );
  assert.equal(fixture.calls(), 1);
  assert.deepEqual(
    fixture.store.pendingMessages().map((pending) => pending.id),
    [message.id],
  );
  const database = new DatabaseSync(join(fixture.store.runDir, "pi-durable.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 1);
  } finally {
    database.close();
  }
});
