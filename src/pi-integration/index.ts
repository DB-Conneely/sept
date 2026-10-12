/**
 * Public mechanism boundary for native Pi diagnostics, prompts, rollover evidence, and session
 * lifecycle. Other SEPT mechanisms import only this barrel; implementation modules remain internal
 * so Pi authority and replacement semantics cannot be bypassed accidentally.
 */

export type { PiSessionHostDependencies, SessionHost, SessionRunResult } from "./contracts.js";
export { getAgentDir, inspectPi } from "./diagnostics.js";
export { continuationPrompt, initialPrompt, successorPrompt } from "./prompts.js";
export {
  MAX_UNUSABLE_USAGE_SAMPLES,
  initialRolloverEvidence,
  loadRolloverEvidence,
  recordUnusableSample,
  recordUsableSample,
  saveRolloverEvidence,
  type RolloverEvidence,
} from "./rollover-evidence.js";
export { decideRollover, providerContextTokens, type RolloverDecision } from "./rollover.js";
export { PiSessionHost } from "./durable-host.js";
export { findSuccessorSession } from "./durable-session-files.js";
