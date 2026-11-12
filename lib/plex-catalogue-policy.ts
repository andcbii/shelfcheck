/** A complete catalogue download is the only event that renews provider age. */
export function reuseProviderCatalogue(input: {
  provider: "tmdb" | "tvdb"; now: string; downloadedAt?: string;
  usable: boolean; mandatory: boolean; targeted: boolean; changed: boolean;
  /** TMDB's own provider verification position; its change feed only covers fourteen days. */
  tmdbVerifiedThrough?: string;
}): boolean {
  if (!input.usable || input.mandatory || input.targeted) return false;
  const downloaded = Date.parse(input.downloadedAt || "");
  if (!Number.isFinite(downloaded) || Date.parse(input.now) - downloaded > 60 * 86400_000) return false;
  if (input.provider === "tmdb" && !tmdbFeedCovers(input.tmdbVerifiedThrough, input.now)) return false;
  if (!input.changed) return true;
  return input.provider === "tmdb" && input.downloadedAt?.slice(0, 10) === input.now.slice(0, 10);
}

/** Whether TMDB's change feed can verify the interval since its verification position. */
export function tmdbFeedCovers(position: string | undefined, now: string): position is string {
  const start = Date.parse(position || "");
  return Number.isFinite(start) && Date.parse(now) - start <= 14 * 86400_000;
}
