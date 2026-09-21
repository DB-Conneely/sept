/**
 * Owns the final allowlist and bounds applied before operational facts reach logs or spans. All
 * observability producers depend inward on this sanitization boundary; unknown keys, non-finite
 * numbers, control-bearing labels, and oversized values must not escape to an external sink.
 */

import type { Attributes } from "@opentelemetry/api";
import type { SafeTelemetryFields } from "./contract.js";

/**
 * Resource keys permitted from operator environment configuration.
 * The closed list excludes credentials, command arguments, paths, and high-cardinality identity.
 */
export const SAFE_RESOURCE_KEYS = [
  "service.namespace",
  "deployment.environment.name",
  "container.name",
  "container.id",
] as const;

const SAFE_ATTRIBUTE_KEYS = new Set([
  "duration_ms",
  "error.type",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "sept.adoption",
  "sept.context.pressure",
  "sept.context.tokens",
  "sept.context.window",
  "sept.epoch",
  "sept.invocation",
  "sept.lifecycle",
  "sept.outcome",
  "sept.queue.depth",
  "sept.rotation",
  "sept.run.id",
  "sept.run.phase",
  "sept.run.state",
  "sept.webhook.duplicate",
  "sept.webhook.kind",
  "sept.worker.state",
  "telemetry.signal",
]);

/**
 * Normalize an unknown operational label to a bounded control-character-free string.
 * Malformed, empty, or oversized input returns the caller-owned safe fallback and never throws.
 */
export function boundedString(value: unknown, fallback: string, max = 128): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const clean = value.trim();
  const valid = clean.length > 0 && clean.length <= max && !/[\u0000-\u001f\u007f]/.test(clean);
  return valid ? clean : fallback;
}

/**
 * Parse an operator integer only when it is canonical and inside inclusive hard bounds.
 * Invalid environment input cannot expand queues or deadlines and resolves to the safe fallback.
 */
export function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  const valid = Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
  return valid ? parsed : fallback;
}

/**
 * Classify an unknown failure by bounded error name only.
 * Messages, stacks, causes, hostile thrown values, and attached payloads never cross telemetry.
 */
export function errorType(error: unknown): string {
  return error instanceof Error ? boundedString(error.name, "Error", 64) : "NonError";
}

/**
 * Project candidate fields into OpenTelemetry attributes using a closed key allowlist.
 * Undefined and non-finite values are dropped; malformed or oversized strings become `unknown`,
 * preventing payload leakage and unbounded values when a caller violates the field contract.
 */
export function safeAttributes(fields: SafeTelemetryFields): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    const finite = typeof value !== "number" || Number.isFinite(value);
    if (!SAFE_ATTRIBUTE_KEYS.has(key) || value === undefined || !finite) {
      continue;
    }
    result[key] = typeof value === "string" ? boundedString(value, "unknown", 128) : value;
  }
  return result;
}

/**
 * Convert allowlisted dotted attributes to flat Pino field names.
 * Sanitization is deliberately repeated at the sink boundary so logs never trust caller typing.
 */
export function logFields(fields: SafeTelemetryFields): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(safeAttributes(fields))) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key.replaceAll(".", "_")] = value;
    }
  }
  return output;
}
