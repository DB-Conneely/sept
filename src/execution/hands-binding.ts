/** Captures exact run ownership only after opening has requalified immutable kernel/lifetime receipts. */
import { join } from "node:path";
import type { RunStore } from "../durable/index.js";
import type { DockerHandsConfiguration } from "./contracts.js";
import type { DockerEngineControl } from "./docker-engine.js";
import {
  readBoundedHandsRecord as readBinding,
  namespaceLifetimePath,
  readNamespaceLifetime,
} from "./profile-configuration.js";

/** Same-generation re-entry must match this complete captured run receipt before native scheduling. */
export function qualifiedRunBinding(
  store: RunStore,
  configuration: DockerHandsConfiguration,
  cwd: string,
  engine: DockerEngineControl,
  policyPath: string,
): Record<string, unknown> {
  return {
    kernel: readBinding(
      join(namespaceLifetimePath(policyPath, configuration), "..", "kernel.json"),
    ),
    profile: configuration.profile,
    containerId: configuration.containerId,
    generation: configuration.generation,
    daemonId: engine.daemonId,
    socketIdentity: engine.socketIdentity,
    cwd,
    runId: store.runId,
    lifetime: readNamespaceLifetime(configuration, engine, policyPath),
  };
}
