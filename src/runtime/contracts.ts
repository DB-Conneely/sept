/**
 * Defines transport-independent worker composition and status contracts. Runtime owns the resident
 * slot and controller; callers may inject only the native host factory and observability boundary,
 * never mutable run authority.
 */

import type { Observability } from "../observability/index.js";
import type { WorkerReadiness } from "../durable/index.js";
import type { HostFactory } from "./controller.js";

/** Construction inputs for one state-root-owning worker runtime. */
export interface WorkerRuntimeOptions {
  stateRoot: string;
  agentDir: string;
  hostFactory?: HostFactory;
  workspaceRoot?: string;
  observability?: Observability;
}

/** Restart outcome after durable resident-run reconciliation. */
export type WorkerAdoption = "none" | "active" | "waiting" | "wake_recovered";

/** Occupancy projection for the worker's single resident execution slot. */
export type WorkerStatus = "idle" | "busy" | "waiting";

/** Credential-free worker status exposed to authenticated composition layers. */
export interface WorkerStatusResult {
  worker: WorkerStatus;
  readiness: WorkerReadiness;
  acceptingWork: boolean;
  activeRunId: string | null;
}
