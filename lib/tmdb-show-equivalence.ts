export type TmdbSeriesMatch = { id?: number };
export type TmdbSeriesExternalMatch = TmdbSeriesMatch & { external_ids?: { tvdb_id?: number | null } };
export type TmdbEpisodeIdentityMatch = { id?: number; show_id?: number };

/** TMDB series IDs that are valid representations of one TVDB series. */
export function equivalentTmdbShowIds(currentTmdbId: number, tvdbMatches: TmdbSeriesMatch[] = []): Set<number> {
  return new Set([currentTmdbId, ...tvdbMatches.flatMap((match) => Number.isFinite(match.id) ? [match.id as number] : [])]);
}

export function tmdbShowLinksToTvdb(show: TmdbSeriesExternalMatch, tvdbId: number): boolean {
  return Number.isFinite(show.id) && show.external_ids?.tvdb_id === tvdbId;
}

/** A TMDB /find result for a TVDB episode is sufficient when Plex owns that exact TMDB episode ID. */
export function ownedTmdbEpisodeMatch<T extends TmdbEpisodeIdentityMatch>(matches: T[], ownedEpisodeIds: Set<number>): T | undefined {
  return matches.find((episode) => Boolean(episode.id && ownedEpisodeIds.has(episode.id)));
}
