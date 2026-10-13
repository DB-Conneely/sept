/**
 * Public boundary for durable single-slot runtime coordination. Composition may construct workers or
 * controllers and classify runtime errors, but session internals, transition helpers, and admission
 * policy remain behind this mechanism boundary.
 */

export type {
  WorkerAdoption,
  WorkerRuntimeOptions,
  WorkerStatus,
  WorkerStatusResult,
} from "./contracts.js";
export { CycleController, type HostFactory } from "./controller.js";
export { RunNotFoundError, WorkerConflictError } from "./errors.js";
export { WorkerRuntime } from "./worker.js";

/** Explicit installed operator wake shares durable accepted input and existing invocation budgets. */
export { wakeRunForOperator } from "./worker-messages.js";
