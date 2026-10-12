/**
 * Owns the minimal hostile-input narrowing primitive shared by model configuration codecs. Callers
 * retain schema and security policy; this module only prevents unchecked property access and does
 * not treat discovery or parsed input as execution authority.
 */

/** Return whether hostile model-access input is a non-array object with unknown members. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { isUnknownRecord };
