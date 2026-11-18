/**
 * What GET /api/scan-runs reports about the Scan run that owns the lock, and
 * the message a page shows while the other kind's Scan run locks its scan
 * controls. Browser-safe: pages import it, so it must not import the lifecycle
 * module (which is server code). The wording matches ScanRunConflictError's
 * other-kind refusal, so a locked page and a refused start read the same.
 */

export type ScanRunActivityKind = "trakt" | "plex";

export type ActiveScanRun = { kind: ScanRunActivityKind; startedAt: string };

const LABELS: Record<ScanRunActivityKind, string> = { trakt: "Trakt", plex: "Plex" };

export function scanRunLockMessage(running: ScanRunActivityKind, page: ScanRunActivityKind): string {
  return `A ${LABELS[running]} scan is running. You can start a ${LABELS[page]} scan when it finishes.`;
}

/** Reads a /api/scan-runs body, or a 409 body's `activeScanRun`; anything else is not an observation. */
export function parseActiveScanRun(value: unknown): ActiveScanRun | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { kind, startedAt } = value as Record<string, unknown>;
  if ((kind !== "trakt" && kind !== "plex") || typeof startedAt !== "string") return undefined;
  return { kind, startedAt };
}
