/** Constructs one native Harness with Pi Models and private SQLite FULL storage per durable run. */

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelImageResizeOptions } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  type Conversation,
  type Registry,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { atomicWrite, SeptError, type Manifest, type RunStore } from "../durable/index.js";
import { assertModelMetadata, createPodModelRuntime } from "../model-access/index.js";
import { NOOP_TELEMETRY, type Observability } from "../observability/index.js";
import type { PiSessionHostDependencies } from "./contracts.js";
import { DurableInvocation } from "./durable-invocation.js";
import { loadTrustedExtensions } from "./durable-extensions.js";
import { loadDurableSections } from "./durable-resources.js";
import { readDurableLocator, writeDurableLocator } from "./durable-session-files.js";
import { createDurableCodingTools } from "./durable-tools.js";
import { loadNativeSqliteDriver } from "./sqlite-driver.js";
import { assertNativeRun } from "./durable-preflight.js";

/** SEPT rollover disables compaction; native retries remain bounded. */
const HARNESS_SETTINGS = {
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
} satisfies HarnessSettings;

/** Native owners travel together so partial host construction can close every acquired resource. */
export interface OpenedDurableRuntime {
  harness: Harness;
  conversation: Conversation;
  invocation: DurableInvocation;
  sessionFile: string;
  refreshResources: () => Promise<void>;
}

/** Create a genuinely fresh conversation and provider identity from immutable run model choices. */
export function createDurableConversation(
  harness: Harness,
  manifest: Manifest,
): Promise<Conversation> {
  return harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: manifest.provider, modelId: manifest.model },
        thinkingLevel: manifest.thinking,
        cwd: manifest.workspace,
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
  harness: Harness,
  manifest: Manifest,
  existingSessionFile: string | undefined,
): Promise<Conversation> {
  if (existingSessionFile === undefined) {
    return createDurableConversation(harness, manifest);
  }
  const conversation = await harness.conversation(
    readDurableLocator(existingSessionFile).conversationId,
    BACKGROUND_CONTEXT,
  );
  if (conversation === undefined) {
    throw new SeptError("Pi Durable session locator names a missing conversation");
  }
  return conversation;
}

async function nativeRegistry(
  manifest: Manifest,
  agentDir: string,
  dependencies: PiSessionHostDependencies,
  resizeOptions: ModelImageResizeOptions | undefined,
): Promise<Registry> {
  const registry = createRegistry();
  registry.install(createDurableCodingTools(manifest.workspace, resizeOptions));
  for (const extension of [
    ...(await loadTrustedExtensions(agentDir)),
    ...(dependencies.extensions ?? []),
  ]) {
    registry.install(extension);
  }
  return registry;
}

async function refreshSections(
  registry: Registry,
  manifest: Manifest,
  agentDir: string,
  invocation: DurableInvocation,
): Promise<void> {
  registry.install(
    defineExtension({
      name: "sept",
      sections: await loadDurableSections(manifest, agentDir),
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
): Promise<Pick<OpenedDurableRuntime, "harness" | "invocation" | "refreshResources">> {
  const { models, model } = await authenticatedModels(manifest, agentDir, dependencies);
  const invocation = new DurableInvocation(manifest, store, model.contextWindow, telemetry);
  const registry = await nativeRegistry(
    manifest,
    agentDir,
    dependencies,
    model.inputLimits?.images?.resize,
  );
  const refreshResources = (): Promise<void> =>
    refreshSections(registry, manifest, agentDir, invocation);
  await refreshResources();
  const storage = await openStorage(store, telemetry);
  try {
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: HARNESS_SETTINGS,
        // Native extensions may use this environment; the parity tools still use Pi's local operations.
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? manifest.workspace, shellEnv: {} }),
        onReport: (error) => {
          invocation.report(error);
        },
      },
      BACKGROUND_CONTEXT,
    );
    invocation.bindHarness(harness);
    return { harness, invocation, refreshResources };
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

/** Open explicitly versioned native state before admitting any work; historical JSONL is untouched. */
export async function openDurableRuntime(
  manifest: Manifest,
  store: RunStore,
  agentDir: string,
  existingSessionFile?: string,
  telemetry: Observability = NOOP_TELEMETRY,
  dependencies: PiSessionHostDependencies = {},
): Promise<OpenedDurableRuntime> {
  assertNativeRun(store, telemetry);
  if (existingSessionFile !== undefined) {
    readDurableLocator(existingSessionFile);
  }
  const { harness, invocation, refreshResources } = await openHarness(
    manifest,
    store,
    agentDir,
    telemetry,
    dependencies,
  );
  try {
    const conversation = await openConversation(harness, manifest, existingSessionFile);
    invocation.bind(conversation);
    const sessionFile =
      existingSessionFile ??
      writeDurableLocator(join(store.runDir, "pi-sessions"), conversation.id);
    atomicWrite(join(store.runDir, "pi-durable-engine.json"), {
      engine: "pi-durable",
      version: "1.1.0",
      synchronous: "FULL",
    });
    store.event("pi_durable_runtime_opened", { conversationId: conversation.id });
    return { harness, conversation, invocation, sessionFile, refreshResources };
  } catch (error: unknown) {
    await harness.close(BACKGROUND_CONTEXT);
    throw error;
  }
}
