import { fixtureBackend } from "./backend-support.js";
/** Critical failures seal actual native dispatch before/after a tool effect, without hook self-await. */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { SeptError } from "../../src/durable/index.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import { DurableGuard } from "../../src/pi-integration/durable-guard.js";
import { openDurableRuntime } from "../../src/pi-integration/durable-runtime.js";
import { CycleController } from "../../src/runtime/index.js";
import {
  assistant,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  registerFixtureProvider,
  streamOf,
} from "./support.js";
import { complete, handover } from "../runtime/fixture-data.js";

async function criticalFixture() {
  const directories = fixtureDirectories("sept-native-critical-");
  const models = await fixtureModelRuntime(directories.agentDir);
  const store = fixtureStore(directories, "critical", "critical tool dispatch");
  let calls = 0;
  registerFixtureProvider(models, "critical", () => {
    calls += 1;
    return streamOf(
      assistant(
        [
          {
            type: "toolCall",
            id: "effect",
            name: "write",
            arguments: { path: "effect.txt", content: "effect happened" },
          },
        ],
        10,
        "toolUse",
      ),
    );
  });
  return {
    directories,
    models,
    store,
    calls: () => calls,
    effect: join(directories.workspace, "effect.txt"),
  };
}

await test("critical usage persistence failure prevents the native tool effect and next generation", async () => {
  const fixture = await criticalFixture();
  const event = fixture.store.event.bind(fixture.store);
  fixture.store.event = (type, fields) => {
    if (type === "context_sample") {
      throw new SeptError("fixture critical usage persistence failure");
    }
    return event(type, fields);
  };
  const controller = new CycleController(
    fixture.store,
    fixture.directories.agentDir,
    (manifest, store, agent, existing, telemetry) =>
      PiSessionHost.create(manifest, store, agent, existing, telemetry, {
        modelRuntime: fixture.models,
        executionBackend: fixtureBackend(fixture.models),
      }),
  );
  await assert.rejects(controller.run(), /critical usage persistence failure/);
  assert.equal(fixture.calls(), 1);
  assert.equal(existsSync(fixture.effect), false);
  assert.equal(fixture.store.snapshot().status, "failed");
  assert.equal(existsSync(fixture.store.leasePath), false);
});

await test("ordinary native afterTool failure stops subsequent generation after an already-dispatched effect", async () => {
  const fixture = await criticalFixture();
  const extension = defineExtension({
    name: "critical-after-effect",
    hooks: [
      hook(ToolTask, {
        afterTool: () => {
          throw new SeptError("fixture critical after-tool failure");
        },
      }),
    ],
  });
  const controller = new CycleController(
    fixture.store,
    fixture.directories.agentDir,
    (manifest, store, agent, existing, telemetry) =>
      PiSessionHost.create(manifest, store, agent, existing, telemetry, {
        modelRuntime: fixture.models,
        executionBackend: fixtureBackend(fixture.models),
        extensions: [extension],
      }),
  );
  await assert.rejects(controller.run(), /critical after-tool failure/);
  assert.equal(fixture.calls(), 1);
  assert.equal(readFileSync(fixture.effect, "utf8"), "effect happened");
  assert.equal(fixture.store.snapshot().status, "failed");
  assert.equal(existsSync(fixture.store.leasePath), false);
});

await test("DurableGuard seals and signals the real Harness synchronously then joins outside the task", async () => {
  const fixture = await criticalFixture();
  const native = await openDurableRuntime(
    fixture.store.manifest(),
    fixture.store,
    fixture.directories.agentDir,
    undefined,
    undefined,
    { modelRuntime: fixture.models, executionBackend: fixtureBackend(fixture.models) },
  );
  const guard = new DurableGuard();
  guard.bind(native.harness);
  guard.assertHealthy();
  guard.report(new SeptError("fixture critical guard failure"));
  assert.throws(() => {
    native.harness.resume();
  });
  await assert.rejects(guard.settle(), /critical guard failure/);
  await native.harness.close(BACKGROUND_CONTEXT);
  assert.equal(fixture.calls(), 0);
});

async function publicationFixture() {
  const directories = fixtureDirectories("sept-native-publication-failure-");
  const models = await fixtureModelRuntime(directories.agentDir);
  const store = fixtureStore(directories, "publication", "publication failure before successor");
  const progress = {
    message: "pre-rotation progress",
    control: { status: "continue", summary: "rotate", verification: [], next_action: "handover" },
  };
  const responses = [JSON.stringify(progress), JSON.stringify(handover), JSON.stringify(complete)];
  let calls = 0;
  registerFixtureProvider(models, "publication", () => {
    const text = responses[calls];
    assert.ok(text);
    calls += 1;
    return streamOf(assistant([{ type: "text", text }], calls === 1 ? 110_000 : 10, "stop"));
  });
  store.conversationMessage = () => {
    throw new SeptError("fixture publication persistence failure");
  };
  const controller = new CycleController(
    store,
    directories.agentDir,
    (manifest, store, agent, existing, telemetry) =>
      PiSessionHost.create(manifest, store, agent, existing, telemetry, {
        modelRuntime: models,
        executionBackend: fixtureBackend(models),
      }),
  );
  return { store, controller, calls: () => calls };
}

await test("pre-rotation publication persistence failure stops before handover authority or successor creation", async () => {
  const fixture = await publicationFixture();
  await assert.rejects(fixture.controller.run(), /publication persistence failure/);
  assert.equal(fixture.calls(), 2);
  assert.equal(fixture.store.snapshot().epoch, 1);
  assert.equal(fixture.store.snapshot().status, "failed");
  assert.equal(fixture.store.latestHandover(), undefined);
  assert.equal(existsSync(fixture.store.leasePath), false);
});
