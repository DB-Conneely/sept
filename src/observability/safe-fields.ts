import type { Attributes } from "@opentelemetry/api";
import type { SafeTelemetryFields } from "./contract.js";

export const SAFE_RESOURCE_KEYS = [
  "service.namespace",
  "deployment.environment.name",
  "container.name",
  "container.id",
] as const;

const SAFE_ATTRIBUTE_KEYS = new Set([
  "duration_ms", "error.type", "http.request.method", "http.response.status_code", "http.route",
  "sept.adoption", "sept.context.pressure", "sept.context.tokens", "sept.context.window", "sept.epoch",
  "sept.invocation", "sept.lifecycle", "sept.outcome", "sept.queue.depth", "sept.rotation", "sept.run.id",
  "sept.run.phase", "sept.run.state", "sept.webhook.duplicate", "sept.webhook.kind", "sept.worker.state",
  "telemetry.signal",
]);

export function boundedString(value: unknown, fallback: string, max = 128): string {
  if (typeof value !== "string") return fallback;
  const clean = value.trim();
  return clean && clean.length <= max && !/[\u0000-\u001f\u007f]/.test(clean) ? clean : fallback;
}

export function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function errorType(error: unknown): string {
  return error instanceof Error ? boundedString(error.name, "Error", 64) : "NonError";
}

export function safeAttributes(fields: SafeTelemetryFields): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key) || value === undefined || (typeof value === "number" && !Number.isFinite(value))) continue;
    result[key] = typeof value === "string" ? value.slice(0, 128) : value;
  }
  return result;
}

export function logFields(fields: SafeTelemetryFields): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(safeAttributes(fields))) output[key.replaceAll(".", "_")] = value as string | number | boolean;
  return output;
}
