/** Embeds the same complete authenticated single-slot worker used by the installed CLI. */
import { SeptError } from "../durable/index.js";
import { SeptService } from "../ingress/index.js";
import type { Observability } from "../observability/index.js";
import { packageMetadata } from "../package-metadata.js";
import {
  assertCapabilityAdmission,
  capabilityHostFactory,
  initializeCapabilities,
} from "./capabilities.js";

/** Explicit library configuration; the caller owns paths, credentials, signals and telemetry. */
export interface WorkerOptions {
  stateRoot: string;
  agentDir: string;
  workspaceRoot: string;
  token: string;
  handsConfigurationPath?: string;
  host?: string;
  port?: number;
  telemetry?: Observability;
}

/** Listener address available after binding and synchronous durable restart adoption. */
export interface WorkerAddress {
  readonly host: string;
  readonly port: number;
}

/** One ready worker; stopping settles its durable boundary without cancelling or draining tasks. */
export interface Worker {
  readonly address: WorkerAddress;
  stop(): Promise<void>;
}

function assertExplicitOptions(options: WorkerOptions): void {
  for (const value of [options.stateRoot, options.agentDir, options.workspaceRoot]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new SeptError("Worker paths must be explicitly supplied");
    }
  }
  if (typeof options.token !== "string" || options.token.length === 0) {
    throw new SeptError("SEPT_TOKEN is required; refusing to start without bearer authentication");
  }
}

/**
 * Bind before adoption and resolve after router/runtime initialization. Native Pi work launches
 * asynchronously; task projections report model/backend failures. Stop is shared and idempotent.
 */
export async function createWorker(options: WorkerOptions): Promise<Worker> {
  assertExplicitOptions(options);
  const metadata = packageMetadata();
  const policy = await initializeCapabilities(options.stateRoot, options.handsConfigurationPath);
  // The closure observes the actual bound endpoint before restart adoption can launch native work.
  const service: SeptService = new SeptService({
    stateRoot: options.stateRoot,
    agentDir: options.agentDir,
    workspaceRoot: options.workspaceRoot,
    token: options.token,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    piVersion: metadata.piVersion,
    hostFactory: capabilityHostFactory(options.stateRoot, options.handsConfigurationPath, () =>
      service.boundEndpoint(),
    ),
    capabilityAdmission: () => {
      assertCapabilityAdmission(policy, options.handsConfigurationPath);
    },
  });
  return startWorker(service);
}

async function startWorker(service: SeptService): Promise<Worker> {
  try {
    const address = Object.freeze(await service.start());
    return Object.freeze({ address, stop: () => service.stop() });
  } catch (error: unknown) {
    try {
      await service.stop();
    } catch (cleanupError: unknown) {
      throw new SeptError("Worker startup and cleanup failed", {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
}
