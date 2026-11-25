/** A plain object, as untrusted provider responses and saved records must be before their fields are read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An optional list of records in a successful provider response: absent or null means none. A body
 * that is not an object, or a field that is not a list of records, cannot be interpreted.
 */
export function responseRecordList(body: unknown, field: string): { records: Record<string, unknown>[] } | { unreadable: string } {
  if (!isRecord(body)) return { unreadable: "the response is not an object" };
  const list = body[field];
  if (list === undefined || list === null) return { records: [] };
  if (!Array.isArray(list) || !list.every(isRecord)) return { unreadable: `${field} is not a list of records` };
  return { records: list };
}

/** A positive safe integer ID, or undefined for anything else. */
export function positiveId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The readable cause of a caught error, never its stack. */
export function coverageIssueCause(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
