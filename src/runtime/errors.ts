/**
 * Defines caller-classifiable runtime failures. Runtime and transport layers may map these classes to
 * bounded responses without parsing messages; no credential, payload, or filesystem detail belongs
 * in their public text.
 */

import { SeptError } from "../durable/index.js";

/** Indicates that worker authority, readiness, capacity, or run state rejects an operation. */
export class WorkerConflictError extends SeptError {}

/** Indicates that no durable run with the requested public identity exists. */
export class RunNotFoundError extends SeptError {}

/** Transfers failed acquired-host cleanup to the controller before ownership could be returned. */
export class SessionCleanupError extends SeptError {
  public constructor(
    originalCause: unknown,
    public readonly cleanupCause: unknown,
  ) {
    // Causes remain in memory for trusted classification, never in durable/public error text.
    super("Native session opening failed and execution cleanup is unverified", {
      cause: originalCause,
    });
  }
}
