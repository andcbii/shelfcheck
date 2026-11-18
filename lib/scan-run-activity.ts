/**
 * The single source of the Scan run kinds, their labels and the words a page
 * or a refused start uses for the Scan run that owns the lock, and what GET
 * /api/scan-runs reports about it. Browser-safe: pages import it, so it must
 * not import the lifecycle module (which is server code); the lifecycle
 * imports its kinds, labels and messages from here.
 */

export type ScanRunKind = "trakt" | "plex";

export const SCAN_RUN_LABELS: Record<ScanRunKind, string> = { trakt: "Trakt", plex: "Plex" };

export type ActiveScanRun = { kind: ScanRunKind; startedAt: string };

/**
 * Why a start of `requested` cannot happen while `running` owns the lock. The
 * other-kind wording is also what a locked page shows, so a locked page and a
 * refused start read the same.
 */
export function scanRunLockMessage(running: ScanRunKind, requested: ScanRunKind): string {
  const label = SCAN_RUN_LABELS[running];
  return running === requested
    ? `A ${label} scan is running. You can start another ${label} scan when it finishes.`
    : `A ${label} scan is running. You can start a ${SCAN_RUN_LABELS[requested]} scan when it finishes.`;
}

/** Reads a /api/scan-runs body, or a 409 body's `activeScanRun`; anything else is not an observation. */
export function parseActiveScanRun(value: unknown): ActiveScanRun | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { kind, startedAt } = value as Record<string, unknown>;
  if ((kind !== "trakt" && kind !== "plex") || typeof startedAt !== "string") return undefined;
  return { kind, startedAt };
}
