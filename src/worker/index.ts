/** Complete-worker composition boundary; capability helpers remain internal package mechanisms. */
export { createWorker, type Worker, type WorkerOptions, type WorkerAddress } from "./worker.js";
export {
  initializeCapabilities,
  assertCapabilityAdmission,
  capabilityHostFactory,
} from "./capabilities.js";
