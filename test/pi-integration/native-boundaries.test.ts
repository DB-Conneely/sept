import { FixtureExecutionBackend, fixtureBackend } from "./backend-support.js";
/** Proves native loading, identity and admission bounds alongside installed resource acceptance. */

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ProviderDoc } from "@earendil-works/pi-durable";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import {
  readDurableAdmission,
  writeDurableAdmission,
  readInvocationAdmission,
  completeDurableAdmission,
} from "../../src/pi-integration/durable-admission.js";
import { loadTrustedExtensions } from "../../src/pi-integration/durable-extensions.js";
import { DurableInvocation } from "../../src/pi-integration/durable-invocation.js";
import { loadDurableSections } from "../../src/pi-integration/durable-resources.js";
import {
  createDurableConversation,
  openDurableRuntime,
  type OpenedDurableRuntime,
} from "../../src/pi-integration/durable-runtime.js";
import { createDurableCodingTools } from "../../src/pi-integration/durable-tools.js";
import { CycleController } from "../../src/runtime/index.js";
import {
  assistant,
  contextText,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  registerFixtureProvider,
  streamOf,
} from "./support.js";

await test("loadTrustedExtensions fails closed on legacy factories and workspace symlink/config paths", async () => {
  const legacy = fixtureDirectories("sept-native-legacy-extension-");
  mkdirSync(join(legacy.agentDir, "extensions"));
  writeFileSync(join(legacy.agentDir, "extensions", "legacy.mjs"), "export default function () {}");
  await assert.rejects(
    loadTrustedExtensions(legacy.agentDir),
    /port legacy ExtensionAPI factories/,
  );
  const escaped = fixtureDirectories("sept-native-escaped-extension-");
  mkdirSync(join(escaped.agentDir, "extensions"));
  const module = join(escaped.workspace, "untrusted.mjs");
  writeFileSync(module, "export const extension = { name: 'untrusted' };");
  symlinkSync(module, join(escaped.agentDir, "extensions", "escape.mjs"));
  await assert.rejects(loadTrustedExtensions(escaped.agentDir), /trusted agent directory/);
  const malformed = fixtureDirectories("sept-native-extension-config-");
  writeFileSync(join(malformed.agentDir, "settings.json"), JSON.stringify({ extensions: [1] }));
  await assert.rejects(loadTrustedExtensions(malformed.agentDir), /path is invalid/);
});

await test("native extension discovery accepts 64 entries and rejects entry 65 before execution", async () => {
  for (const count of [64, 65]) {
    const directories = fixtureDirectories(`sept-native-extension-${String(count)}-`);
    const directory = join(directories.agentDir, "extensions");
    mkdirSync(directory);
    for (let index = 0; index < count; index += 1) {
      writeFileSync(
        join(directory, `${String(index)}.mjs`),
        `export const extension = { name: "fixture-${String(index)}" };`,
      );
    }
    if (count === 64) {
      assert.equal((await loadTrustedExtensions(directories.agentDir)).length, 64);
    } else {
      await assert.rejects(loadTrustedExtensions(directories.agentDir), /discovery bound/);
    }
  }
});

await test("native edit preparation preserves caller input and produces the same normalized arguments twice", () => {
  const edit = createDurableCodingTools(
    new FixtureExecutionBackend("/unused-workspace", "/tmp/sept-edit-fixture"),
  ).tools?.find((tool) => tool.name === "edit");
  assert.ok(edit);
  const input = { path: "artifact.txt", edits: { oldText: "before", newText: "after" } };
  const original = structuredClone(input);
  const first = edit.prepareArguments?.(input);
  assert.deepEqual(input, original);
  assert.deepEqual(edit.prepareArguments?.(input), first);
  assert.deepEqual(input, original);
  assert.deepEqual(first, {
    path: "artifact.txt",
    edits: [{ oldText: "before", newText: "after" }],
  });
});

async function nativeIdentityBoundary(): Promise<void> {
  const directories = fixtureDirectories("sept-native-identity-");
  const models = await fixtureModelRuntime(directories.agentDir);
  registerFixtureProvider(models, "native-boundary", () =>
    streamOf(assistant([{ type: "text", text: "native finalized boundary" }], 10, "stop")),
  );
  const store = fixtureStore(directories, "native-boundary", "native identity");
  writeFileSync(join(directories.agentDir, "SYSTEM.md"), "native operator system");
  const native = await openDurableRuntime(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    {
      modelRuntime: models,
      executionBackend: fixtureBackend(models),
      extensions: [createDurableCodingTools(fixtureBackend(models))],
    },
  );
  try {
    assert.ok(native.invocation instanceof DurableInvocation);
    await assertNativeIdentity(native, store, directories.agentDir);
    assert.equal(
      (await native.invocation.run(native.harness, "native boundary")).text,
      "native finalized boundary",
    );
    admissionBounds(store, native.conversation.id);
  } finally {
    await native.harness.close(BACKGROUND_CONTEXT);
  }
}

async function assertNativeIdentity(
  native: OpenedDurableRuntime,
  store: ReturnType<typeof fixtureStore>,
  agentDir: string,
): Promise<void> {
  const agent = await native.conversation.agent(BACKGROUND_CONTEXT);
  assert.equal(agent.tools.find((tool) => tool.name === "read")?.replay, "safe");
  assert.equal(agent.tools.find((tool) => tool.name === "bash")?.replay, "unsafe");
  const sections = await loadDurableSections(store.manifest(), agentDir, native.backend);
  const rendered: (string | undefined)[] = [];
  for (const section of sections) {
    rendered.push(
      await section.render(
        {
          agent,
          conversationId: native.conversation.id,
          env: undefined,
          shown: {},
          read: native.harness,
        },
        BACKGROUND_CONTEXT,
      ),
    );
  }
  assert.ok(rendered.includes("native operator system"));
  await assertFreshProviderIdentity(native, store);
}

async function assertFreshProviderIdentity(
  native: OpenedDurableRuntime,
  store: ReturnType<typeof fixtureStore>,
): Promise<void> {
  const successor = await createDurableConversation(
    native.harness,
    store.manifest(),
    native.backend.cwd,
  );
  assert.notEqual(successor.id, native.conversation.id);
  const predecessorIdentity = await native.harness.snapshot(
    ProviderDoc,
    native.conversation.id,
    BACKGROUND_CONTEXT,
  );
  const successorIdentity = await native.harness.snapshot(
    ProviderDoc,
    successor.id,
    BACKGROUND_CONTEXT,
  );
  assert.ok(predecessorIdentity?.sessionId);
  assert.ok(successorIdentity?.sessionId);
  assert.notEqual(successorIdentity.sessionId, predecessorIdentity.sessionId);
}

function admissionBounds(
  store: ReturnType<typeof fixtureStore>,
  conversationId: Parameters<typeof writeDurableAdmission>[1],
): void {
  const messages = Array.from({ length: 64 }, (_, index) => ({
    id: `message-${String(index)}`,
    text: "bounded fixture",
    createdAt: new Date().toISOString(),
  }));
  writeDurableAdmission(store, conversationId, "sept-invocation-1", messages, "captured prompt");
  assert.equal(readInvocationAdmission(store)?.prompt, "captured prompt");
  completeDurableAdmission(store, "sept-invocation-1");
  assert.equal(readInvocationAdmission(store)?.checkpointed, true);
  assert.equal(readDurableAdmission(store, conversationId, "sept-invocation-1").length, 64);
  assert.throws(
    () => readDurableAdmission(store, conversationId, "sept-invocation-2"),
    /does not match/,
  );
  assert.throws(() => {
    writeDurableAdmission(
      store,
      conversationId,
      "sept-invocation-1",
      [...messages, { id: "extra", text: "extra", createdAt: new Date().toISOString() }],
      "captured prompt",
    );
  }, /exceed their bound/);
  malformedAdmission(store, conversationId);
}

function malformedAdmission(
  store: ReturnType<typeof fixtureStore>,
  conversationId: Parameters<typeof writeDurableAdmission>[1],
): void {
  writeFileSync(
    join(store.runDir, "pi-durable-admission.json"),
    JSON.stringify({
      formatVersion: 1,
      conversationId: 1.5,
      requestId: "sept-invocation-1",
      operatorMessageIds: [],
    }),
  );
  assert.throws(
    () => readDurableAdmission(store, conversationId, "sept-invocation-1"),
    /conversation identity is invalid/,
  );
}

await test(
  "openDurableRuntime binds DurableInvocation and creates distinct durable conversation/provider identities",
  nativeIdentityBoundary,
);

async function capturedInputRace(): Promise<void> {
  const directories = fixtureDirectories("sept-native-captured-input-");
  const models = await fixtureModelRuntime(directories.agentDir);
  const store = fixtureStore(directories, "native-race", "capture exact operator input");
  const captured = store.enqueueMessage("CAPTURED-OPERATOR-DIRECTION");
  let calls = 0;
  registerFixtureProvider(models, "native-race", (_model, context) => {
    calls += 1;
    const text = contextText(context);
    if (calls === 1) {
      assert.match(text, /CAPTURED-OPERATOR-DIRECTION/);
      assert.doesNotMatch(text, /LATE-OPERATOR-DIRECTION/);
    } else {
      assert.match(text, /LATE-OPERATOR-DIRECTION/);
    }
    const textResult = JSON.stringify({
      message: "captured direction handled",
      control: { status: "complete", summary: "complete", verification: [], next_action: "" },
    });
    return streamOf(assistant([{ type: "text", text: textResult }], 10, "stop"));
  });
  await raceController(store, directories.agentDir, models, captured.id).run();
  assert.equal(calls, 2);
  assert.equal(store.snapshot().status, "complete");
  assert.deepEqual(store.pendingMessages(), []);
}

function raceController(
  store: ReturnType<typeof fixtureStore>,
  agentDir: string,
  models: ModelRuntime,
  capturedId: string,
): CycleController {
  return new CycleController(
    store,
    agentDir,
    async (manifest, runStore, agentDir, existing, telemetry) => {
      const host = await PiSessionHost.create(manifest, runStore, agentDir, existing, telemetry, {
        modelRuntime: models,
        executionBackend: fixtureBackend(models),
      });
      const run = host.run.bind(host);
      host.run = (prompt, messages, validate) => {
        if (store.snapshot().invocations === 1) {
          store.enqueueMessage("LATE-OPERATOR-DIRECTION");
          assert.deepEqual(
            messages?.map((message) => message.id),
            [capturedId],
          );
        }
        return run(prompt, messages, validate);
      };
      return host;
    },
  );
}

await test(
  "operator input arriving after capture is delivered next, never marked in the earlier native admission",
  capturedInputRace,
);
