/** Return whether hostile model-access input is a non-array object with unknown members. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { isUnknownRecord };
