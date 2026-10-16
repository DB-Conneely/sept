/** Package worker contracts stay independent of internal host and native Pi declaration graphs. */
import type { Observability } from "./observability/index.js";
import { createWorker as completeWorker } from "./worker/index.js";

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

/** The shared complete-worker function; explicit public typing excludes internal host injection APIs. */
export const createWorker: (options: WorkerOptions) => Promise<Worker> = completeWorker;
