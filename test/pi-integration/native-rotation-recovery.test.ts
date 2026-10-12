/** Rotation replay preserves native capture and classifies actual request placement, not intent. */

import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GenerationTask, hook } from "@earendil-works/pi-durable";
import {
  parseJsonObject,
  validateHandover,
  validateWorkResponse,
} from "../../src/durable/index.js";
import type { SessionResponseValidator } from "../../src/pi-integration/index.js";
import { openDurableRuntime } from "../../src/pi-integration/durable-runtime.js";
import {
  isRotationResponse,
  recoveredRotationMessages,
  recoveredPreRotationText,
} from "../../src/pi-integration/durable-rotation-recovery.js";
import { ROTATION_STEER } from "../../src/pi-integration/prompts.js";
import { handover } from "../runtime/fixture-data.js";
import {
  assistant,
  contextText,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  registerFixtureProvider,
  streamOf,
} from "./support.js";

const validate: SessionResponseValidator = (text, kind) =>
  kind === "handover"
    ? { kind, handover: validateHandover(parseJsonObject(text)) }
    : { kind, response: validateWorkResponse(parseJsonObject(text)) };

function registerProvider(
  models: Awaited<ReturnType<typeof fixtureModelRuntime>>,
  onCall: () => void,
): void {
  registerFixtureProvider(models, "rotation-capture", (_model, context) => {
    onCall();
    const steered = contextText(context).includes(ROTATION_STEER);
    const text = steered
      ? JSON.stringify(handover)
      : JSON.stringify({
          message: "Captured direction applied.",
          control: {
            status: "continue",
            summary: "applied",
            verification: [],
            next_action: "finish",
          },
        });
    return streamOf(assistant([{ type: "text", text }], steered ? 10 : 110_000, "stop"));
  });
}

async function fixture() {
  const directories = fixtureDirectories("sept-native-rotation-capture-");
  const models = await fixtureModelRuntime(directories.agentDir);
  const store = fixtureStore(directories, "rotation-capture", "apply captured input");
  const observed: boolean[] = [];
  let calls = 0;
  registerProvider(models, () => {
    calls += 1;
  });
  const native = await openDurableRuntime(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    undefined,
    {
      modelRuntime: models,
      extensions: [
        {
          name: "observe-placement",
          hooks: [
            hook(GenerationTask, {
              afterResponse: async (_message, api) => {
                observed.push(await isRotationResponse(native.conversation, api.taskId));
              },
            }),
          ],
        },
      ],
    },
  );
  store.update({
    phase: "running",
    invocations: 1,
    activeSessionId: String(native.conversation.id),
    activeSessionFile: native.sessionFile,
  });
  return { directories, models, store, native, observed, calls: () => calls };
}

await test("native request cutoff distinguishes ordinary response from placed rotation input", async () => {
  const state = await fixture();
  try {
    await state.native.invocation.run(state.native.harness, "trigger rotation", [], validate);
    assert.deepEqual(state.observed, [false, true]);
    const progress = await recoveredPreRotationText(state.native.conversation);
    assert.equal(validateWorkResponse(parseJsonObject(progress ?? "")).control.summary, "applied");
    assert.equal(state.calls(), 2);
  } finally {
    await state.native.harness.close(BACKGROUND_CONTEXT);
  }
});

await test("settled rotation recovery keeps captured IDs and leaves later arrivals out of predecessor delivery", async () => {
  const state = await fixture();
  const captured = state.store.enqueueMessage("  captured exact\n direction  ");
  await state.native.invocation.run(state.native.harness, "trigger rotation", [captured], validate);
  const binding = await recoveredRotationMessages(state.store, state.native.conversation);
  assert.deepEqual(binding.deliveredMessageIds, [captured.id]);
  await state.native.harness.close(BACKGROUND_CONTEXT);
  const later = state.store.enqueueMessage("later successor direction");
  const recovered = await openDurableRuntime(
    state.store.manifest(),
    state.store,
    state.directories.agentDir,
    state.native.sessionFile,
    undefined,
    { modelRuntime: state.models },
  );
  try {
    const result = await recovered.invocation.run(
      recovered.harness,
      "ignored recovery prompt",
      [captured, later],
      validate,
    );
    assert.deepEqual(result.deliveredMessageIds, [captured.id]);
    assert.equal(result.requestId, "sept-invocation-1");
    assert.equal(result.text, JSON.stringify(handover));
    assert.equal(state.calls(), 2);
  } finally {
    await recovered.harness.close(BACKGROUND_CONTEXT);
  }
});
