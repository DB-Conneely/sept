/** Public supplied-backend boundary; native Pi owns scheduling and the consumer owns enforcement. */
export {
  HandsBackendUnavailableError,
  type CodingToolName,
  type DockerHandsConfiguration,
  type ExecutionBackend,
  type HandsRequest,
  type HandsResources,
  type HandsToolResult,
} from "./contracts.js";
export { DockerExecutionBackend } from "./docker-backend.js";
export { BackendExecutionEnv } from "./native-env.js";
export { loadHandsConfiguration, validateDockerProfile } from "./profile.js";
export { parseHandsResources, parseHandsToolResult } from "./protocol.js";

export {
  capabilityBinding,
  defaultCapabilities,
  validateCapabilities,
  capabilityTools,
  capabilityGrants,
  admitCapabilityRequest,
} from "./capability-admission.js";

/** Local operator composition uses the same bounded transport and exact-generation cleanup owner. */
export {
  initializeCapabilityEngine,
  validateDockerConfiguration,
  revokeDockerBinding,
  revokeRecordedHandsBinding,
  reconcileDockerBinding,
  assertHandsRunProfile,
} from "./docker-control.js";
