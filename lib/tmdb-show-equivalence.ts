export type TmdbSeriesMatch = { id?: number };

/** TMDB series IDs that are valid representations of one TVDB series. */
export function equivalentTmdbShowIds(currentTmdbId: number, tvdbMatches: TmdbSeriesMatch[] = []): Set<number> {
  return new Set([currentTmdbId, ...tvdbMatches.flatMap((match) => Number.isFinite(match.id) ? [match.id as number] : [])]);
}
