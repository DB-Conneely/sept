/** Constructs one native NativePi.Harness with Pi Models and private SQLite FULL storage per durable run. */

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelImageResizeOptions } from "@earendil-works/pi-ai";
import * as NativePi from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BackendExecutionEnv, type ExecutionBackend } from "../execution/index.js";
import { atomicWrite, SeptError, type Manifest, type RunStore } from "../durable/index.js";
import { assertModelMetadata, createPodModelRuntime } from "../model-access/index.js";
import { NOOP_TELEMETRY, type Observability } from "../observability/index.js";
import type { PiSessionHostDependencies, OpenedDurableRuntime } from "./contracts.js";
export type { OpenedDurableRuntime } from "./contracts.js";
import { DurableInvocation } from "./durable-invocation.js";
import { loadTrustedExtensions } from "./durable-extensions.js";
import { loadDurableSections } from "./durable-resources.js";
import { readDurableLocator, writeDurableLocator } from "./durable-session-files.js";
import { createDurableCodingTools, bindNativeToolEnvironment } from "./durable-tools.js";
import { loadNativeSqliteDriver } from "./sqlite-driver.js";
import { assertNativeRun } from "./durable-preflight.js";
import {
  prepareDurableInitialization,
  readDurableInitialization,
} from "./durable-initialization.js";

/** SEPT rollover disables compaction; native retries remain bounded. */
const HARNESS_SETTINGS = {
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
} satisfies NativePi.HarnessSettings;

/** Create a genuinely fresh conversation and provider identity from immutable run model choices. */
export function createDurableConversation(
  harness: NativePi.Harness,
  manifest: Manifest,
  cwd: string,
): Promise<NativePi.Conversation> {
  return harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: manifest.provider, modelId: manifest.model },
        thinkingLevel: manifest.thinking,
        cwd,
      },
    },
    BACKGROUND_CONTEXT,
  );
}

async function openStorage(store: RunStore, telemetry: Observability): Promise<SqliteStorage> {
  const { openNodeSqliteDatabase } = await loadNativeSqliteDriver(telemetry);
  const database = await openNodeSqliteDatabase(join(store.runDir, "pi-durable.sqlite"));
  try {
    // Native commits must meet SEPT's fsync-before-publication contract, including crash recovery.
    await database.exec("PRAGMA synchronous = FULL");
    const setting = await database.get<{ synchronous: number }>("PRAGMA synchronous");
    if (setting?.synchronous !== 2) {
      throw new SeptError("Pi Durable storage did not enforce FULL synchronization");
    }
    return await SqliteStorage.open(database);
  } catch (error: unknown) {
    await database.close();
    throw error;
  }
}

async function openConversation(
  harness: NativePi.Harness,
  manifest: Manifest,
  existingSessionFile: string | undefined,
  initialConversationId: NativePi.Conversation["id"] | undefined,
  backend: ExecutionBackend,
): Promise<NativePi.Conversation> {
  if (existingSessionFile === undefined && initialConversationId === undefined) {
    return createDurableConversation(harness, manifest, backend.cwd);
  }
  const conversationId =
    existingSessionFile === undefined
      ? initialConversationId
      : readDurableLocator(existingSessionFile).conversationId;
  if (conversationId === undefined) {
    throw new SeptError("Pi Durable initial conversation identity is missing");
  }
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) {
    throw new SeptError("Pi Durable session locator names a missing conversation");
  }
  // NativePi.Harness is still paused: configure namespace before any recovered task can resume.
  await conversation.configure({ cwd: backend.cwd }, BACKGROUND_CONTEXT);
  return conversation;
}

async function nativeRegistry(
  agentDir: string,
  dependencies: PiSessionHostDependencies,
  resizeOptions: ModelImageResizeOptions | undefined,
  backend: ExecutionBackend,
  invocation: DurableInvocation,
): Promise<NativePi.Registry> {
  const registry = NativePi.createRegistry();
  registry.install(
    createDurableCodingTools(backend, resizeOptions, (error) => {
      invocation.report(error);
    }),
  );
  for (const extension of [
    ...(await loadTrustedExtensions(agentDir)),
    ...(dependencies.extensions ?? []),
  ]) {
    registry.install(
      bindNativeToolEnvironment(extension, backend, (error) => {
        invocation.report(error);
      }),
    );
  }
  return registry;
}

async function refreshSections(
  registry: NativePi.Registry,
  manifest: Manifest,
  agentDir: string,
  invocation: DurableInvocation,
  backend: ExecutionBackend,
): Promise<void> {
  registry.install(
    NativePi.defineExtension({
      name: "sept",
      sections: await loadDurableSections(manifest, agentDir, backend),
      hooks: invocation.hooks(),
    }),
  );
}

async function openHarness(
  manifest: Manifest,
  store: RunStore,
  agentDir: string,
  telemetry: Observability,
  dependencies: PiSessionHostDependencies,
): Promise<Pick<OpenedDurableRuntime, "harness" | "invocation" | "refreshResources" | "backend">> {
  const backend = dependencies.executionBackend;
  if (backend === undefined) {
    throw new SeptError("A supported supplied hands backend is required");
  }
  const { models, model } = await authenticatedModels(manifest, agentDir, dependencies);
  const invocation = new DurableInvocation(
    manifest,
    store,
    model.contextWindow,
    telemetry,
    backend,
  );
  const registry = await nativeRegistry(
    agentDir,
    dependencies,
    model.inputLimits?.images?.resize,
    backend,
    invocation,
  );
  const refreshResources = (): Promise<void> =>
    refreshSections(registry, manifest, agentDir, invocation, backend);
  await refreshResources();
  const harness = await openConfiguredHarness(
    store,
    telemetry,
    models,
    registry,
    backend,
    invocation,
  );
  return { harness, invocation, refreshResources, backend };
}

async function openConfiguredHarness(
  store: RunStore,
  telemetry: Observability,
  models: NonNullable<PiSessionHostDependencies["modelRuntime"]>,
  registry: NativePi.Registry,
  backend: ExecutionBackend,
  invocation: DurableInvocation,
): Promise<NativePi.Harness> {
  const storage = await openStorage(store, telemetry);
  try {
    const harness = await NativePi.Harness.open(
      storage,
      {
        models,
        registry,
        settings: HARNESS_SETTINGS,
        // Initial dispatch and replay share this supplied effect owner, never a local fallback.
        env: () =>
          new BackendExecutionEnv(backend, (error) => {
            invocation.report(error);
          }),
        onReport: (error) => {
          invocation.report(error);
        },
      },
      BACKGROUND_CONTEXT,
    );
    invocation.bindHarness(harness);
    return harness;
  } catch (error: unknown) {
    await storage.close(BACKGROUND_CONTEXT);
    throw error;
  }
}

async function authenticatedModels(
  manifest: Manifest,
  agentDir: string,
  dependencies: PiSessionHostDependencies,
) {
  const models = dependencies.modelRuntime ?? (await createPodModelRuntime(agentDir));
  const model = models.getModel(manifest.provider, manifest.model);
  if (model === undefined) {
    throw new SeptError("Pi Durable model selection is unavailable");
  }
  assertModelMetadata(model);
  try {
    if (
      (await models.getAuth(manifest.provider, { signal: AbortSignal.timeout(15_000) })) ===
      undefined
    ) {
      throw new SeptError("Pi provider authentication is unavailable; run sept auth status");
    }
  } catch (error: unknown) {
    throw new SeptError("Pi provider authentication could not be resolved; run sept auth status", {
      cause: error,
    });
  }
  return { models, model };
}

function prepareRuntime(
  store: RunStore,
  existingSessionFile: string | undefined,
  telemetry: Observability,
): NativePi.Conversation["id"] | undefined {
  assertNativeRun(store, telemetry);
  if (existingSessionFile !== undefined) {
    readDurableLocator(existingSessionFile);
  }
  const initial = readDurableInitialization(store, telemetry);
  prepareDurableInitialization(store);
  return initial?.conversationId;
}

async function bindNativeConversation(
  harness: NativePi.Harness,
  invocation: DurableInvocation,
  manifest: Manifest,
  store: RunStore,
  backend: ExecutionBackend,
  existingSessionFile: string | undefined,
  initialConversationId: NativePi.Conversation["id"] | undefined,
): Promise<Pick<OpenedDurableRuntime, "conversation" | "sessionFile">> {
  const conversation = await openConversation(
    harness,
    manifest,
    existingSessionFile,
    initialConversationId,
    backend,
  );
  invocation.bind(conversation);
  const sessionFile =
    existingSessionFile ?? writeDurableLocator(join(store.runDir, "pi-sessions"), conversation.id);
  atomicWrite(join(store.runDir, "pi-durable-engine.json"), {
    engine: "pi-durable",
    version: "1.1.0",
    synchronous: "FULL",
  });
  store.event("pi_durable_runtime_opened", { conversationId: conversation.id });
  return { conversation, sessionFile };
}

/** Open explicitly versioned native state before admitting any work; historical JSONL is untouched. */
export async function openDurableRuntime(
  manifest: Manifest,
  store: RunStore,
  agentDir: string,
  existingSessionFile?: string,
  telemetry: Observability = NOOP_TELEMETRY,
  dependencies: PiSessionHostDependencies = {},
): Promise<OpenedDurableRuntime> {
  const initialConversationId = prepareRuntime(store, existingSessionFile, telemetry);
  const { harness, invocation, refreshResources, backend } = await openHarness(
    manifest,
    store,
    agentDir,
    telemetry,
    dependencies,
  );
  try {
    const { conversation, sessionFile } = await bindNativeConversation(
      harness,
      invocation,
      manifest,
      store,
      backend,
      existingSessionFile,
      initialConversationId,
    );
    return {
      harness,
      conversation,
      invocation,
      sessionFile,
      refreshResources,
      backend,
    };
  } catch (error: unknown) {
    await harness.close(BACKGROUND_CONTEXT);
    throw error;
  }
}
