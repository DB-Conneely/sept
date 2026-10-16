/** Complete authenticated worker boundary for embedding in a Node application. */
export { createWorker, type Worker, type WorkerOptions, type WorkerAddress } from "./worker-api.js";
export { SeptError } from "./durable/index.js";
export type { Observability } from "./observability/index.js";
