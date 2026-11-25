/**
 * The single source of the Scan run kinds, their labels and the words a page
 * or a refused start uses for the Scan run that owns the lock, and what GET
 * /api/scan-runs reports about it; and the words a page's progress box uses
 * for a running Scan run's steps and rate-limit pauses. Browser-safe: pages
 * import it, so it must not import the lifecycle module (which is server
 * code); the lifecycle imports its kinds, labels and messages from here.
 */
import type { ActiveScanWork } from "@/lib/scan-concurrency";
import type { ProviderName } from "@/lib/provider-policy";

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

/** What a page's scan button reads while a Scan run of the other kind owns the lock; the lock message under it names that run. */
export const OTHER_SCAN_RUN_BUTTON = "Another scan is in progress";

/** Reads a /api/scan-runs body, or a 409 body's `activeScanRun`; anything else is not an observation. */
export function parseActiveScanRun(value: unknown): ActiveScanRun | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { kind, startedAt } = value as Record<string, unknown>;
  if ((kind !== "trakt" && kind !== "plex") || typeof startedAt !== "string") return undefined;
  return { kind, startedAt };
}

/**
 * The parts of a Scan run status a page's progress box shows. Every field is
 * optional and loosely typed: an older saved status may lack them.
 */
export type ScanProgressStatus = {
  activeShows?: unknown;
  currentPhase?: string;
  rateLimitPaused?: boolean;
  rateLimitProvider?: ProviderName;
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
export function activeScanShows(value: unknown): ActiveScanWork[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ActiveScanWork => {
    if (!item || typeof item !== "object") return false;
    const { key, show, phase } = item as Record<string, unknown>;
    return typeof key === "string" && typeof show === "string" && typeof phase === "string";
  });
}

/** The pause notice: the provider, if the status names one, and the local HH:MM it resumes at, if known. */
export function rateLimitPauseWording(provider: string | undefined, resumesAt: Date | null): string {
  const paused = provider ? `Paused: ${provider} rate limit.` : "Paused: rate limit.";
  if (!resumesAt) return `${paused} Waiting for it to clear.`;
  const time = `${String(resumesAt.getHours()).padStart(2, "0")}:${String(resumesAt.getMinutes()).padStart(2, "0")}`;
  return `${paused} Resumes at ${time}.`;
}

/** Whole seconds left in a pause, as "1h 2m 3s", "4m 10s" or "9s". */
export function pauseCountdownWording(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}
