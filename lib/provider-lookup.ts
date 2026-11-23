import type { ProviderName } from "@/lib/provider-policy";

/**
 * One kind of matching evidence a Plex scan looks up from a provider, by typed identity. Series and
 * episode kinds are distinct even where their stored key is still shared (see `lookupKey`).
 * Plain transport (Plex inventory, catalogue episode pages, the catalogue slug read and the TVDB
 * change feed) has no typed lookup.
 */
export type ProviderLookup =
  /** TMDB's external-ID search for one TVDB episode: its TMDB external-ID crosswalk. */
  | { kind: "tmdb-episode-by-tvdb-episode"; tvdbEpisodeId: number }
  /** TMDB's external-ID search for one TVDB series: its TMDB series association. */
  | { kind: "tmdb-series-by-tvdb-series"; tvdbSeriesId: number }
  /** One TMDB episode by its show, season and episode number. */
  | { kind: "tmdb-episode-by-show-season-episode"; tmdbShowId: number; season: number; episode: number }
  /** One TMDB series summary, without external IDs. */
  | { kind: "tmdb-series-summary"; tmdbShowId: number }
  /** One TMDB series summary with its external IDs; never stands in for the basic summary. */
  | { kind: "tmdb-series-summary-with-external-ids"; tmdbShowId: number }
  /** One TVDB series summary. */
  | { kind: "tvdb-series-summary"; tvdbSeriesId: number }
  /** One TVDB episode's extended record: its IMDb crosswalk. */
  | { kind: "tvdb-episode-extended"; tvdbEpisodeId: number }
  /** Trakt's episode search for one TVDB episode: its Trakt crosswalk. */
  | { kind: "trakt-episode-search-by-tvdb-episode"; tvdbEpisodeId: number };

/** Whether a value is a provider ID a lookup accepts: a positive safe integer. */
export const isProviderId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
/** Whether a value is a season or episode number a lookup accepts: a non-negative safe integer. */
export const isEpisodeCoordinate = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function providerId(value: number, name: string) {
  if (!isProviderId(value)) throw new RangeError(`${name} must be a positive integer, not ${value}.`);
  return value;
}
function coordinate(value: number, name: string) {
  if (!isEpisodeCoordinate(value)) throw new RangeError(`${name} must be a non-negative integer, not ${value}.`);
  return value;
}

/** Validating constructors: every lookup identity is built from checked provider IDs. */
export const providerLookup = {
  tmdbEpisodeByTvdbEpisode: (tvdbEpisodeId: number): ProviderLookup => ({ kind: "tmdb-episode-by-tvdb-episode", tvdbEpisodeId: providerId(tvdbEpisodeId, "TVDB episode ID") }),
  tmdbSeriesByTvdbSeries: (tvdbSeriesId: number): ProviderLookup => ({ kind: "tmdb-series-by-tvdb-series", tvdbSeriesId: providerId(tvdbSeriesId, "TVDB series ID") }),
  tmdbEpisodeByShowSeasonEpisode: (tmdbShowId: number, season: number, episode: number): ProviderLookup => ({ kind: "tmdb-episode-by-show-season-episode", tmdbShowId: providerId(tmdbShowId, "TMDB show ID"), season: coordinate(season, "Season number"), episode: coordinate(episode, "Episode number") }),
  tmdbSeriesSummary: (tmdbShowId: number): ProviderLookup => ({ kind: "tmdb-series-summary", tmdbShowId: providerId(tmdbShowId, "TMDB show ID") }),
  tmdbSeriesSummaryWithExternalIds: (tmdbShowId: number): ProviderLookup => ({ kind: "tmdb-series-summary-with-external-ids", tmdbShowId: providerId(tmdbShowId, "TMDB show ID") }),
  tvdbSeriesSummary: (tvdbSeriesId: number): ProviderLookup => ({ kind: "tvdb-series-summary", tvdbSeriesId: providerId(tvdbSeriesId, "TVDB series ID") }),
  tvdbEpisodeExtended: (tvdbEpisodeId: number): ProviderLookup => ({ kind: "tvdb-episode-extended", tvdbEpisodeId: providerId(tvdbEpisodeId, "TVDB episode ID") }),
  traktEpisodeSearchByTvdbEpisode: (tvdbEpisodeId: number): ProviderLookup => ({ kind: "trakt-episode-search-by-tvdb-episode", tvdbEpisodeId: providerId(tvdbEpisodeId, "TVDB episode ID") }),
};

/** Provider API base URLs, shared by typed lookups and plain transport. */
export const TMDB_API = "https://api.themoviedb.org/3";
export const TVDB_API = "https://api4.thetvdb.com/v4";
const TRAKT_API = "https://api.trakt.tv";

/** The provider that answers a lookup. */
export function lookupProvider(lookup: ProviderLookup): ProviderName {
  switch (lookup.kind) {
    case "tmdb-episode-by-tvdb-episode":
    case "tmdb-series-by-tvdb-series":
    case "tmdb-episode-by-show-season-episode":
    case "tmdb-series-summary":
    case "tmdb-series-summary-with-external-ids": return "TMDB";
    case "tvdb-series-summary":
    case "tvdb-episode-extended": return "TVDB";
    case "trakt-episode-search-by-tvdb-episode": return "Trakt";
  }
}

/** The request URL that asks a lookup's provider for it. Only transport sends it. */
export function lookupUrl(lookup: ProviderLookup): string {
  switch (lookup.kind) {
    case "tmdb-episode-by-tvdb-episode": return `${TMDB_API}/find/${lookup.tvdbEpisodeId}?external_source=tvdb_id`;
    case "tmdb-series-by-tvdb-series": return `${TMDB_API}/find/${lookup.tvdbSeriesId}?external_source=tvdb_id`;
    case "tmdb-episode-by-show-season-episode": return `${TMDB_API}/tv/${lookup.tmdbShowId}/season/${lookup.season}/episode/${lookup.episode}`;
    case "tmdb-series-summary": return `${TMDB_API}/tv/${lookup.tmdbShowId}`;
    case "tmdb-series-summary-with-external-ids": return `${TMDB_API}/tv/${lookup.tmdbShowId}?append_to_response=external_ids`;
    case "tvdb-series-summary": return `${TVDB_API}/series/${lookup.tvdbSeriesId}`;
    case "tvdb-episode-extended": return `${TVDB_API}/episodes/${lookup.tvdbEpisodeId}/extended`;
    case "trakt-episode-search-by-tvdb-episode": return `${TRAKT_API}/search/tvdb/${lookup.tvdbEpisodeId}?type=episode`;
  }
}

/**
 * The one projection from a typed lookup to its stored key: the key its saved provider
 * relationship is kept under, and the lookup part of its `episode-identity:` Coverage Issue ID.
 * It is still the provider and request URL, so a TMDB series association and a TMDB episode
 * crosswalk with the same numeric TVDB ID share one key until the key cutover.
 */
export function lookupKey(lookup: ProviderLookup): string {
  return `${lookupProvider(lookup)}:${lookupUrl(lookup)}`;
}

/**
 * The TVDB episode whose TMDB external-ID crosswalk a stored key names, if any. While keys are
 * shared, a TMDB series association's key names the same-numbered episode too.
 */
export function tmdbEpisodeCrosswalkOfKey(key: string): number | undefined {
  const tvdbEpisodeId = Number(key.match(/\/find\/(\d+)\?/)?.[1]);
  if (!Number.isSafeInteger(tvdbEpisodeId) || tvdbEpisodeId <= 0) return undefined;
  return key === lookupKey(providerLookup.tmdbEpisodeByTvdbEpisode(tvdbEpisodeId)) ? tvdbEpisodeId : undefined;
}
