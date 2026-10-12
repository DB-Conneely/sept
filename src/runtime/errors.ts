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
