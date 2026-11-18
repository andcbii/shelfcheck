export type ScanCacheInputs = {
  deep: boolean;
  gracePeriodChanged: boolean;
  cached: boolean;
  collectionChanged: boolean;
  airedChanged: boolean;
  traktUpdated: boolean;
};

export type ScanReason = "new" | "collection-changed" | "aired-changed" | "trakt-updated" | "settings-changed" | "forced-show-check";

type CollectedShow = {
  show: { aired_episodes?: number };
  seasons?: { number: number; episodes?: { number: number; collected_at?: string }[] }[];
};

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

export function collectionFingerprint(item: CollectedShow): string {
  const episodes = (item.seasons || []).flatMap((season) => (season.episodes || [])
    .map((episode) => `${season.number}:${episode.number}:${episode.collected_at || ""}`)).sort().join("|");
  return hash(episodes);
}

export function collectedEpisodeCount(item: CollectedShow): number {
  return (item.seasons || []).reduce((total, season) => total + (season.number ? season.episodes?.length || 0 : 0), 0);
}

export function scanReason(inputs: ScanCacheInputs): ScanReason | null {
  if (inputs.gracePeriodChanged) return "settings-changed";
  if (!inputs.cached) return "new";
  if (inputs.collectionChanged) return "collection-changed";
  if (inputs.airedChanged) return "aired-changed";
  if (inputs.deep && inputs.traktUpdated) return "trakt-updated";
  return null;
}

export function shouldReportIncompleteEpisode(deep: boolean, graceDays: number, airedAfterGrace: boolean, airDateKnown = true): boolean {
  return !airDateKnown || (!deep && graceDays === 0) || airedAfterGrace;
}

export function canCacheAirDateResult(requiresAirDates: boolean, requestSucceeded: boolean, unknownAirDates: number): boolean {
  return !requiresAirDates || (requestSucceeded && unknownAirDates === 0);
}

export function shouldSaveCheckpoint(processed: number, lastProcessed: number, now: number, lastSavedAt: number): boolean {
  return processed - lastProcessed >= 10 || now - lastSavedAt >= 5_000;
}

/** The Trakt Resume point format. A Resume point of any other version, or none (saved before 2.6.2), is discarded. */
export const TRAKT_RESUME_POINT_VERSION = 1;

/** A Resume point is usable for less than this long after it was saved. */
export const RESUME_POINT_MAX_AGE_MS = 6 * 3_600_000;

/**
 * Whether a full Trakt Scan run may resume from a stored Resume point: its
 * format version and normalized airing grace period match this run's, and its
 * `savedAt` parses, is not in the future and is under 6 hours old. Exactly 6
 * hours old is unusable.
 */
export function traktResumePointIsUsable(point: { resumePointVersion?: unknown; airingGraceDays?: unknown; savedAt?: unknown } | null | undefined, airingGraceDays: number, now: number): boolean {
  if (point?.resumePointVersion !== TRAKT_RESUME_POINT_VERSION || point.airingGraceDays !== airingGraceDays || typeof point.savedAt !== "string") return false;
  const savedAt = Date.parse(point.savedAt);
  return Number.isFinite(savedAt) && savedAt <= now && now - savedAt < RESUME_POINT_MAX_AGE_MS;
}
