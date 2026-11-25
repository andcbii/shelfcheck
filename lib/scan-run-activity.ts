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

/** One show a Scan run is checking right now, and the step it is on. */
export type ActiveScanShow = { key: string; show: string; phase: string };

/**
 * The parts of a Scan run status a page's progress box shows. Every field is
 * optional and loosely typed: an older saved status may lack them.
 */
export type ScanProgressStatus = {
  activeShows?: unknown;
  currentPhase?: string;
  rateLimitPaused?: boolean;
  rateLimitProvider?: string;
  rateLimitResumeAt?: string;
};

const SCAN_STEP_WORDING: Record<string, string> = {
  starting: "Starting",
  "collection-progress": "Checking your Trakt collection",
  "air-dates": "Looking up air dates",
  poster: "Fetching the poster",
  "plex-inventory": "Reading episodes in Plex",
  "tmdb-show-and-seasons": "Getting the episode list from TMDB",
  "tvdb-series-and-episodes": "Getting the episode list from TVDB",
  "episode-crosswalk": "Matching episode numbers between providers",
};

const SCAN_PREPARATION_WORDING: Record<string, string> = {
  initializing: "Getting ready…",
};

/** A show's current step in plain English; a step without wording reads neutrally rather than by its raw name. */
export function scanStepWording(phase: string): string {
  return Object.hasOwn(SCAN_STEP_WORDING, phase) ? SCAN_STEP_WORDING[phase] : "Working on it";
}

/**
 * What the progress box says while no show is being checked and the Scan run
 * is still preparing, from its current phase; null once it is past preparing.
 */
export function scanPreparationWording(currentPhase: string | undefined): string | null {
  return currentPhase !== undefined && Object.hasOwn(SCAN_PREPARATION_WORDING, currentPhase) ? SCAN_PREPARATION_WORDING[currentPhase] : null;
}

/** The well-formed shows of a status's `activeShows`, skipping anything an older or damaged status holds instead. */
export function activeScanShows(value: unknown): ActiveScanShow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ActiveScanShow => {
    if (!item || typeof item !== "object") return false;
    const { key, show, phase } = item as Record<string, unknown>;
    return typeof key === "string" && typeof show === "string" && typeof phase === "string";
  });
}
