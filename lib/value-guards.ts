/** A plain object, as untrusted provider responses and saved records must be before their fields are read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The readable cause of a caught error, never its stack. */
export function coverageIssueCause(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
