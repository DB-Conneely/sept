/**
 * Supplies strict primitive decoders for durable codecs. Callers retain record-specific semantics;
 * these helpers narrow hostile unknown values, enforce exact schemas and bounds, and reject unsafe
 * controls before data can enter persisted domain state.
 */

import { SeptError } from "./errors.js";

const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow hostile input to a non-array object with unknown members. */
function unknownRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new SeptError(`Invalid durable ${name}`);
  }
  return value;
}

/** Enforce an exact durable object schema before any field projection. */
function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value);
  const missingRequired = required.some((key) => !keys.includes(key));
  const unexpected = keys.some((key) => !required.includes(key) && !optional.includes(key));
  if (missingRequired || unexpected) {
    throw new SeptError(`Invalid durable ${name} fields`);
  }
}

/** Validate a safe bounded integer from a durable record. */
function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  const isInteger = typeof value === "number" && Number.isSafeInteger(value);
  if (!isInteger || value < minimum || value > maximum) {
    throw new SeptError(`Invalid durable ${name}`);
  }
  return value;
}

/** Validate a bounded string without unsafe control characters. */
function boundedString(value: unknown, minimum: number, maximum: number, name: string): string {
  if (typeof value !== "string") {
    throw new SeptError(`Invalid durable ${name}`);
  }
  const invalidLength = value.length < minimum || value.length > maximum;
  if (invalidLength || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw new SeptError(`Invalid durable ${name}`);
  }
  return value;
}

/** Validate a canonical ISO timestamp from a durable record. */
function isoDate(value: unknown, name: string): string {
  const result = boundedString(value, 1, 128, name);
  const timestamp = Date.parse(result);
  const isCanonical = Number.isFinite(timestamp) && new Date(timestamp).toISOString() === result;
  if (!isCanonical) {
    throw new SeptError(`Invalid durable ${name}`);
  }
  return result;
}

/** Select one allowed string without relying on a type assertion. */
function enumValue<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  name: string,
): Value {
  const matched = allowed.find((candidate) => candidate === value);
  if (matched === undefined) {
    throw new SeptError(`Invalid durable ${name}`);
  }
  return matched;
}

export { boundedInteger, boundedString, enumValue, exactKeys, isoDate, unknownRecord };
