/** Opening owns immutable profile/provenance qualification and the exclusive namespace lease before scheduling. */
import type { FSWatcher } from "node:fs";
import type { RunStore, CapabilityPolicyStore } from "../durable/index.js";
import type { DockerHandsConfiguration } from "./contracts.js";
import { DockerEngineControl } from "./docker-engine.js";
import { validateDockerConfiguration, acquireHandsLease } from "./docker-control.js";

/** Qualify before leasing; failed preflight releases every temporary Engine connection. */
export async function openHandsControl(
  configuration: DockerHandsConfiguration,
  store: RunStore,
  brainRoots: readonly string[],
  policyStore: CapabilityPolicyStore,
  controlEndpoint?: { address: string; port: number },
): Promise<{ engine: DockerEngineControl; cwd: string; release: () => void }> {
  const engine = await DockerEngineControl.open(configuration.engineSocket);
  try {
    const cwd = await validateDockerConfiguration(
      configuration,
      brainRoots,
      store.manifest().workspace,
      controlEndpoint,
      { policyPath: policyStore.path, initialize: false },
      engine,
    );
    const release = acquireHandsLease(configuration, store, brainRoots);
    return { engine, cwd, release };
  } catch (error: unknown) {
    await engine.close();
    throw error;
  }
}

/** Partial startup joins exact namespace/channel ownership before releasing its lease, even after stop failure. */
export async function closeFailedHandsOpening(
  engine: DockerEngineControl,
  release: () => void,
  watcher: FSWatcher | undefined,
  stop: () => Promise<void> | undefined,
): Promise<void> {
  watcher?.close();
  try {
    await stop();
  } finally {
    try {
      await engine.close();
    } finally {
      release();
    }
  }
}
