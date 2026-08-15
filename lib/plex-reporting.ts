type ProviderMatchReportable = {
  plexGuids?: string[];
  providerMatches?: { tmdb?: unknown[]; tvdb?: unknown[] };
};

export function hasMultipleProviderMatches(show: ProviderMatchReportable): boolean {
  return (show.plexGuids?.length || 0) > 1
    || (show.providerMatches?.tmdb?.length || 0) > 1
    || (show.providerMatches?.tvdb?.length || 0) > 1;
}
