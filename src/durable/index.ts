/**
 * Public boundary of the durable mechanism. Runtime, ingress, and composition depend on documented
 * facades and contracts here; codecs, queue internals, filesystem ordering, and lease implementation
 * remain owned below this barrel.
 */

/** Durable run facade used by lifecycle and ingress mechanisms. */
export { RunStore } from "./run-store.js";

/** Durable worker-readiness authority for drain and admission. */
export { WorkerLifecycleStore } from "./worker-lifecycle-store.js";

/** Classified errors exposed across SEPT mechanism boundaries. */
export {
  ConversationCursorExpiredError,
  ExecutionTimeoutError,
  QueueCapacityError,
  SeptError,
} from "./errors.js";

/** Public durability and bounded-resource limits. */
export {
  MAX_CONVERSATION_BYTES,
  MAX_CONVERSATION_EVENTS,
  MAX_CONVERSATION_STREAMS,
  MAX_PENDING_MESSAGE_BYTES,
  MAX_PENDING_MESSAGES,
} from "./limits.js";

/** State-root lease and atomic persistence primitives used by composition. */
export { acquireStateRootLease } from "./lease.js";
export { adaptSqliteNotice, loadNativeSqliteReader } from "./sqlite-builtin.js";
export { atomicCreate, atomicWrite, now } from "./filesystem.js";

/** Validated run discovery and agent control codecs. */
export { listRuns } from "./run-discovery.js";
export {
  parseJsonObject,
  validateHandover,
  validateWork,
  validateWorkResponse,
} from "./control-codecs.js";

/** Stable durable domain contracts shared across SEPT mechanisms. */
export {
  DEFAULTS,
  type ConversationEvent,
  type DurableHandover,
  type Handover,
  type Manifest,
  type OperatorMessage,
  type RunEvent,
  type RunPhase,
  type RunSnapshot,
  type RunStatus,
  type TaskRequest,
  type TerminalCause,
  type WorkerLifecycleState,
  type WorkerReadiness,
  type WorkControl,
  type WorkResponse,
} from "./contracts.js";

/** Bounded local operator capability authority and exact codecs. */
export {
  CapabilityPolicyStore,
  CapabilityPolicyDeniedError,
  parseCapabilityConfiguration,
  parseCapabilityBinding,
  type CapabilityRights,
  type CapabilityGrant,
  type CapabilityBinding,
  type CapabilityPolicy,
  type CapabilityConfiguration,
} from "./capability-policy.js";

/** Exact bounded operator permission facts; no task scheduler or automatic retry authority. */
export {
  CapabilityRequestStore,
  CapabilityRequestWaitingError,
  capabilityArguments,
  MAX_CAPABILITY_REQUESTS,
  MAX_CAPABILITY_REQUEST_BYTES,
  type CapabilityRequest,
  type CapabilityRequestFacts,
  type CapabilityDecision,
} from "./capability-requests.js";

/** Existing strict codecs reused to decode public task and conversation projections. */
export { validateManifest, validateSnapshot } from "./state-codecs.js";
export { validateConversationEvent } from "./evidence-codecs.js";
