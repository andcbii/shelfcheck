const CATALOGUE_AGE_LIMIT = 60 * 86400_000;

/** A complete catalogue download is the only event that renews provider age. */
export function reuseProviderCatalogue(input: {
  provider: "tmdb" | "tvdb"; now: string; downloadedAt?: string;
  usable: boolean; mandatory: boolean; targeted: boolean;
  /** A verified change, or TMDB verification recovery that the change feed cannot cover. */
  changed: boolean;
}): boolean {
  if (!input.usable || input.mandatory || input.targeted) return false;
  const downloaded = Date.parse(input.downloadedAt || "");
  if (!Number.isFinite(downloaded) || Date.parse(input.now) - downloaded > CATALOGUE_AGE_LIMIT) return false;
  if (!input.changed) return true;
  return input.provider === "tmdb" && input.downloadedAt?.slice(0, 10) === input.now.slice(0, 10);
}

/** Whether TMDB's change feed can verify the interval since its verification position. */
export function tmdbFeedCovers(position: string | undefined, now: string): position is string {
  const start = Date.parse(position || "");
  return Number.isFinite(start) && Date.parse(now) - start <= 14 * 86400_000;
}

/**
 * Plan how a full scan verifies TMDB's own missing interval.
 *
 * Normally the change feed covers the interval since TMDB's verification position.
 * When the position is missing or beyond the feed window, TMDB verification recovery
 * applies per catalogue: a catalogue is current as of its own successful download, so
 * the feed verifies every catalogue downloaded within its window, and only the remaining
 * catalogues must be refreshed. Successful recovery downloads therefore stay reusable.
 */
export function tmdbVerificationPlan(position: string | undefined, catalogues: {id: number; downloadedAt: string}[], now: string): {feedFrom?: string; recover: number[]} {
  if (tmdbFeedCovers(position, now)) return {feedFrom: position, recover: []};
  const covered = catalogues.filter(catalogue => tmdbFeedCovers(catalogue.downloadedAt, now));
  const feedFrom = covered.map(catalogue => catalogue.downloadedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {feedFrom, recover: catalogues.filter(catalogue => !covered.includes(catalogue)).map(catalogue => catalogue.id)};
}

/**
 * Where a full scan's TVDB update check starts.
 *
 * TVDB's update feed is timestamp-based and has no recovery window, so absent verification
 * history is never fabricated: each saved catalogue is current as of its own successful download,
 * and the feed starts at the earliest one still within its age limit (older ones refresh by age).
 * With no such catalogue there is nothing to verify, so no feed request is needed.
 */
export function tvdbVerificationFrom(position: string | undefined, downloads: string[], now: string): string | undefined {
  if (Number.isFinite(Date.parse(position || ""))) return position;
  return downloads.filter(downloadedAt => Date.parse(now) - Date.parse(downloadedAt) <= CATALOGUE_AGE_LIMIT).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}
