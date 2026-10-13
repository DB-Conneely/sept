/** Bounded permission facts codec; no persistence, scheduling or authority activation. */
import { createHash } from "node:crypto";
import { SeptError } from "./errors.js";
import { parseCapabilityBinding, type CapabilityBinding } from "./capability-policy.js";
import {
  boundedInteger,
  boundedString,
  enumValue,
  exactKeys,
  unknownRecord,
} from "./validation-primitives.js";
/** A request closes active native work; only an explicit later invocation can retry. */
export class CapabilityRequestWaitingError extends SeptError {
  public constructor(public readonly requestId: string) {
    super("Exact permission request awaits a local operator decision and explicit retry");
  }
}
/** Bounded local request storage refuses the next entry rather than dropping old denied-call facts. */
export const MAX_CAPABILITY_REQUESTS = 32;
/** Exact argument content is bounded before hashing or durable allocation. */
export const MAX_CAPABILITY_REQUEST_BYTES = 64 * 1024;
/** Trusted native identity plus exact work-visible operation; arguments cannot choose authority. */
export interface CapabilityRequestFacts {
  runId: string;
  invocation: number;
  callId: string;
  operation: string;
  arguments: string;
  revision: number;
  binding: CapabilityBinding;
}
/** An approval binds a denied source request to one explicitly selected fresh target and one retry. */
export interface CapabilityDecision {
  status: "approved" | "denied";
  revision: number;
  binding: CapabilityBinding;
  expiresAt: number;
  retry?: { invocation: number; callId: string };
}
/** Immutable original denial and optional operator decision; original calls never become approved. */
export interface CapabilityRequest extends CapabilityRequestFacts {
  id: string;
  digest: string;
  expiresAt: number;
  decision?: CapabilityDecision;
}
function identity(value: unknown): string {
  const result = boundedString(value, 1, 256, "permission identity");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw new SeptError("Permission identity is malformed");
  }
  return result;
}
function canonical(value: unknown, depth: number): unknown {
  if (depth > 16) {
    throw new SeptError("Permission arguments exceed nesting bound");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value) && value.length <= 1024) {
    return value.map((entry: unknown) => canonical(entry, depth + 1));
  }
  const input = unknownRecord(value, "permission arguments");
  const keys = Object.keys(input).sort();
  if (keys.length > 128) {
    throw new SeptError("Permission arguments exceed key bound");
  }
  return Object.fromEntries(keys.map((key) => [key, canonical(input[key], depth + 1)]));
}
/** Canonical bounded JSON makes reordered keys equal and changed operation/content distinct. */
export function capabilityArguments(value: unknown): string {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > MAX_CAPABILITY_REQUEST_BYTES) {
    throw new SeptError("Permission arguments exceed their bound");
  }
  return JSON.stringify(canonical(value, 0));
}
/** Bind exact operation and canonical argument bytes. */
export function capabilityDigest(operation: string, arguments_: string): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, arguments_]))
    .digest("hex");
}
/** Decode an exact bounded operator decision, without activating authority. */
export function parseCapabilityDecision(value: unknown): CapabilityDecision {
  const input = unknownRecord(value, "permission decision");
  exactKeys(
    input,
    ["status", "revision", "binding", "expiresAt"],
    ["retry"],
    "permission decision",
  );
  const retry =
    input.retry === undefined ? undefined : unknownRecord(input.retry, "permission retry");
  if (retry !== undefined) {
    exactKeys(retry, ["invocation", "callId"], [], "permission retry");
  }
  return {
    status: enumValue(input.status, ["approved", "denied"], "permission decision"),
    revision: boundedInteger(input.revision, 1, Number.MAX_SAFE_INTEGER - 1, "permission revision"),
    binding: parseCapabilityBinding(input.binding),
    expiresAt: boundedInteger(input.expiresAt, 1, Number.MAX_SAFE_INTEGER, "permission expiry"),
    ...(retry === undefined
      ? {}
      : {
          retry: {
            invocation: boundedInteger(
              retry.invocation,
              1,
              Number.MAX_SAFE_INTEGER,
              "retry invocation",
            ),
            callId: identity(retry.callId),
          },
        }),
  };
}
function requestRecord(value: unknown): Record<string, unknown> {
  const input = unknownRecord(value, "permission request");
  exactKeys(
    input,
    [
      "id",
      "digest",
      "runId",
      "invocation",
      "callId",
      "operation",
      "arguments",
      "revision",
      "binding",
      "expiresAt",
    ],
    ["decision"],
    "permission request",
  );
  return input;
}
/** Decode immutable original denial and exact decision facts. */
export function parseCapabilityRequest(value: unknown): CapabilityRequest {
  const input = requestRecord(value);
  const operation = boundedString(input.operation, 1, 256, "permission operation");
  const arguments_ = boundedString(
    input.arguments,
    1,
    MAX_CAPABILITY_REQUEST_BYTES,
    "permission arguments",
  );
  const checked = capabilityArguments(JSON.parse(arguments_));
  if (checked !== arguments_ || input.digest !== capabilityDigest(operation, arguments_)) {
    throw new SeptError("Permission request digest differs from exact content");
  }
  return {
    id: identity(input.id),
    digest: input.digest,
    runId: identity(input.runId),
    invocation: boundedInteger(
      input.invocation,
      1,
      Number.MAX_SAFE_INTEGER,
      "permission invocation",
    ),
    callId: identity(input.callId),
    operation,
    arguments: arguments_,
    revision: boundedInteger(input.revision, 1, Number.MAX_SAFE_INTEGER - 1, "permission revision"),
    binding: parseCapabilityBinding(input.binding),
    expiresAt: boundedInteger(input.expiresAt, 1, Number.MAX_SAFE_INTEGER, "permission expiry"),
    ...(input.decision === undefined ? {} : { decision: parseCapabilityDecision(input.decision) }),
  };
}
/** Complete namespace identity comparison, including supplied root fingerprint. */
export function sameCapabilityBinding(left: CapabilityBinding, right: CapabilityBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
