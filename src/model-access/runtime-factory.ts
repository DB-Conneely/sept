import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SeptError } from "../durable/index.js";
import { validateCustomConfiguration } from "./custom-configuration.js";
import { signalOptions } from "./normalization.js";

/** Optional Pi runtime ownership and cancellation controls for model access construction. */
export interface ModelAccessCreateOptions {
  runtime?: ModelRuntime;
  signal?: AbortSignal;
  allowModelNetwork?: boolean;
}

/** Construct Pi's installed runtime after validating SEPT-owned custom safety constraints. */
export async function createPodModelRuntime(
  agentDir: string,
  options: Omit<ModelAccessCreateOptions, "runtime"> = {},
): Promise<ModelRuntime> {
  const directory = resolve(agentDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  validateCustomConfiguration(directory);
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: options.allowModelNetwork ?? false,
    ...signalOptions(options.signal),
  });
  if (runtime.getError() !== undefined) {
    throw new SeptError(
      "Pi rejected the configured provider or model metadata; run sept models validate",
    );
  }
  return runtime;
}
