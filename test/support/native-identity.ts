/** Domain fixtures carry real native identity/schema while injected hosts own deterministic responses. */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { atomicWrite, type RunStore } from "../../src/durable/index.js";
import type { SessionHost } from "../../src/pi-integration/index.js";
import {
  readDurableLocator,
  writeDurableLocator,
} from "../../src/pi-integration/durable-session-files.js";
import type { HostFactory } from "../../src/runtime/index.js";
import { fixtureModelRuntime, PiFixtureError } from "../pi-integration/support.js";

interface NativeIdentity {
  sessionId: string;
  sessionFile: string;
}

/** Create/reopen committed native metadata without submitting a model or running a tool. */
export async function nativeFixtureIdentity(
  store: RunStore,
  existing?: string,
  parent?: string,
): Promise<NativeIdentity> {
  const harness = await openFixtureHarness(store);
  try {
    const conversation =
      existing === undefined
        ? await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT)
        : await harness.conversation(
            readDurableLocator(existing).conversationId,
            BACKGROUND_CONTEXT,
          );
    if (conversation === undefined) {
      throw new PiFixtureError("native fixture conversation disappeared");
    }
    const sessionFile =
      existing ?? writeDurableLocator(join(store.runDir, "pi-sessions"), conversation.id, parent);
    atomicWrite(join(store.runDir, "pi-durable-engine.json"), {
      engine: "pi-durable",
      version: "1.1.0",
      synchronous: "FULL",
    });
    return { sessionId: String(conversation.id), sessionFile };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

async function openFixtureHarness(store: RunStore): Promise<Harness> {
  const agent = join(store.runDir, "fixture-agent");
  if (!existsSync(agent)) {
    mkdirSync(agent);
  }
  const models = await fixtureModelRuntime(agent);
  const database = await openNodeSqliteDatabase(join(store.runDir, "pi-durable.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const storage = await SqliteStorage.open(database);
  try {
    return await Harness.open(
      storage,
      { models, registry: createRegistry(), settings: { compaction: { enabled: false } } },
      BACKGROUND_CONTEXT,
    );
  } catch (error: unknown) {
    await storage.close(BACKGROUND_CONTEXT);
    throw error;
  }
}

/** Wrap only test-owned response factories; published/recovered identities remain genuine native state. */
export function nativeFixtureFactory(factory: HostFactory): HostFactory {
  return async (manifest, store, agent, existing, telemetry) => {
    const host = await factory(manifest, store, agent, existing, telemetry);
    let identity = await nativeFixtureIdentity(store, existing);
    return {
      get sessionId(): string {
        return identity.sessionId;
      },
      get sessionFile(): string {
        return identity.sessionFile;
      },
      run: (...args: Parameters<SessionHost["run"]>) => host.run(...args),
      abort: () => host.abort(),
      close: () => host.close(),
      newSession: async (): ReturnType<SessionHost["newSession"]> => {
        await host.newSession();
        const predecessor = identity;
        identity = await nativeFixtureIdentity(store, undefined, predecessor.sessionFile);
        return {
          predecessorId: predecessor.sessionId,
          predecessorFile: predecessor.sessionFile,
          successorId: identity.sessionId,
          successorFile: identity.sessionFile,
        };
      },
    } satisfies SessionHost;
  };
}
