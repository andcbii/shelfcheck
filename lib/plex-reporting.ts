import type { PlexProviderResolution } from "@/lib/plex-scan";

type ProviderMatchReportable = {
  plexGuids?: string[];
  providerMatches?: { tmdb?: unknown[]; tvdb?: unknown[] };
};

export function hasMultipleProviderMatches(show: ProviderMatchReportable): boolean {
  return (show.plexGuids?.length || 0) > 1
    || (show.providerMatches?.tmdb?.length || 0) > 1
    || (show.providerMatches?.tvdb?.length || 0) > 1;
}

/**
 * An Unmatched show (ADR-0006): no provider has a usable catalogue. A result saved before scans judged
 * each provider has no match status; it counts when neither provider was compared. Unmatched Shows and
 * the Scan Issues projection share this one rule.
 */
export function isUnmatchedShow(show: { providerResolution?: PlexProviderResolution }): boolean {
  const resolution = show.providerResolution;
  return resolution?.status ? resolution.status === "unmatched" : resolution?.tmdb === false && resolution.tvdb === false;
}
