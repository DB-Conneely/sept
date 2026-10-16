/** Complete worker and direct-run composition share one operator capability authority. */
import { existsSync, opendirSync } from "node:fs";
import { CapabilityPolicyStore, CapabilityPolicyDeniedError } from "../durable/index.js";
import {
  capabilityBinding,
  defaultCapabilities,
  DockerExecutionBackend,
  initializeCapabilityEngine,
  loadHandsConfiguration,
  validateCapabilities,
} from "../execution/index.js";
import { PiSessionHost } from "../pi-integration/index.js";
import type { HostFactory } from "../runtime/index.js";

function newStateRoot(root: string): boolean {
  if (!existsSync(root)) {
    return true;
  }
  const directory = opendirSync(root);
  try {
    return directory.readSync() === null;
  } finally {
    directory.closeSync();
  }
}

/** New supplied state gets safe default; unreadable old policy stays dormant and is never replaced. */
export async function initializeCapabilities(
  root: string,
  configurationPath: string | undefined,
): Promise<CapabilityPolicyStore> {
  const store = new CapabilityPolicyStore(root);
  try {
    if (store.read() !== undefined || !newStateRoot(root)) {
      return store;
    }
  } catch {
    return store;
  }
  if (configurationPath !== undefined) {
    try {
      const configuration = loadHandsConfiguration(configurationPath);
      await initializeCapabilityEngine(configuration, store.path);
      store.initialize(defaultCapabilities(), capabilityBinding(configuration));
    } catch {
      // Missing Engine authority leaves scheduling dormant; authenticated health/history still bind.
      return store;
    }
  }
  return store;
}

/** Installed admission binds current warm configuration before accepting input or preparing native state. */
export function assertCapabilityAdmission(
  store: CapabilityPolicyStore,
  configurationPath: string | undefined,
): void {
  const policy = store.read();
  if (policy === undefined || policy.denied) {
    throw new CapabilityPolicyDeniedError(
      "Operator capability configuration is required before execution",
    );
  }
  try {
    const configuration = loadHandsConfiguration(configurationPath);
    if (JSON.stringify(policy.binding) !== JSON.stringify(capabilityBinding(configuration))) {
      throw new CapabilityPolicyDeniedError(
        "Current warm configuration requires operator activation",
      );
    }
    validateCapabilities(policy, configuration);
  } catch (error: unknown) {
    if (error instanceof CapabilityPolicyDeniedError) {
      throw error;
    }
    // Unsupported supplied configuration is dormant scheduling, preserving authenticated history/health.
    throw new CapabilityPolicyDeniedError(
      "Warm hands profile configuration is unavailable or incompatible",
      {
        cause: error,
      },
    );
  }
}

/** Worker/direct composition binds the same private policy to the installed effect owner. */
export function capabilityHostFactory(
  root: string,
  configurationPath: string | undefined,
  controlEndpoint?: () => { address: string; port: number } | undefined,
): HostFactory {
  return async (manifest, store, agentDir, existing, telemetry) => {
    const configuration = loadHandsConfiguration(configurationPath);
    const backend = await DockerExecutionBackend.create(
      configuration,
      store,
      [agentDir, root],
      new CapabilityPolicyStore(root),
      controlEndpoint?.(),
    );
    return PiSessionHost.create(manifest, store, agentDir, existing, telemetry, {
      executionBackend: backend,
    });
  };
}
