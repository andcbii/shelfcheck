import type { ProviderName } from "@/lib/provider-policy";

/**
 * One kind of matching evidence a Plex scan looks up from a provider, by typed identity. Series and
 * episode kinds are distinct, and so are their stored keys (see `lookupKey`).
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

/** One TMDB episode by its show, season and episode number. */
export type TmdbEpisodeLookup = Extract<ProviderLookup, { kind: "tmdb-episode-by-show-season-episode" }>;

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
  tmdbEpisodeByShowSeasonEpisode: (tmdbShowId: number, season: number, episode: number): TmdbEpisodeLookup => ({ kind: "tmdb-episode-by-show-season-episode", tmdbShowId: providerId(tmdbShowId, "TMDB show ID"), season: coordinate(season, "Season number"), episode: coordinate(episode, "Episode number") }),
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
 * The one projection from a typed lookup to its stored key, `<kind>:<inputs>`: the key its saved
 * provider relationship is kept under, and the lookup part of its `episode-identity:` Coverage
 * Issue ID. Every kind has its own key, so a series lookup and an episode lookup with the same
 * numeric ID never share one. It names no request URL; only transport knows those.
 */
export function lookupKey(lookup: ProviderLookup): string {
  switch (lookup.kind) {
    case "tmdb-episode-by-tvdb-episode": return `tmdb-episode-by-tvdb:${lookup.tvdbEpisodeId}`;
    case "tmdb-series-by-tvdb-series": return `tmdb-series-by-tvdb:${lookup.tvdbSeriesId}`;
    case "tmdb-episode-by-show-season-episode": return `tmdb-episode:${lookup.tmdbShowId}:${lookup.season}:${lookup.episode}`;
    case "tmdb-series-summary": return `tmdb-series:${lookup.tmdbShowId}:summary`;
    case "tmdb-series-summary-with-external-ids": return `tmdb-series:${lookup.tmdbShowId}:external-ids`;
    case "tvdb-series-summary": return `tvdb-series:${lookup.tvdbSeriesId}`;
    case "tvdb-episode-extended": return `tvdb-episode-extended:${lookup.tvdbEpisodeId}`;
    case "trakt-episode-search-by-tvdb-episode": return `trakt-episode-by-tvdb:${lookup.tvdbEpisodeId}`;
  }
}

/**
 * For every lookup kind, its stored key's leading part and how to build the lookup from the key's
 * parts. Keyed by every kind, so a new kind does not compile until `lookupOfKey` can read its key.
 */
const lookupOfKeyByKind: Record<ProviderLookup["kind"], { prefix: string; build: (parts: number[], variant?: string) => ProviderLookup }> = {
  "tmdb-episode-by-tvdb-episode": { prefix: "tmdb-episode-by-tvdb", build: ([id]) => providerLookup.tmdbEpisodeByTvdbEpisode(id) },
  "tmdb-series-by-tvdb-series": { prefix: "tmdb-series-by-tvdb", build: ([id]) => providerLookup.tmdbSeriesByTvdbSeries(id) },
  "tmdb-episode-by-show-season-episode": { prefix: "tmdb-episode", build: ([show, season, episode]) => providerLookup.tmdbEpisodeByShowSeasonEpisode(show, season, episode) },
  "tmdb-series-summary": { prefix: "tmdb-series", build: ([id]) => providerLookup.tmdbSeriesSummary(id) },
  "tmdb-series-summary-with-external-ids": { prefix: "tmdb-series", build: ([id]) => providerLookup.tmdbSeriesSummaryWithExternalIds(id) },
  "tvdb-series-summary": { prefix: "tvdb-series", build: ([id]) => providerLookup.tvdbSeriesSummary(id) },
  "tvdb-episode-extended": { prefix: "tvdb-episode-extended", build: ([id]) => providerLookup.tvdbEpisodeExtended(id) },
  "trakt-episode-search-by-tvdb-episode": { prefix: "trakt-episode-by-tvdb", build: ([id]) => providerLookup.traktEpisodeSearchByTvdbEpisode(id) },
};

/**
 * The typed lookup a stored key names, or undefined for any string `lookupKey` never writes, so
 * callers select saved relationships by lookup kind.
 */
export function lookupOfKey(key: string): ProviderLookup | undefined {
  const [prefix, ...rest] = key.split(":");
  const variant = rest.length && !/^\d+$/.test(rest.at(-1)!) ? rest.pop() : undefined;
  const parts = rest.map(Number);
  for (const { prefix: kindPrefix, build } of Object.values(lookupOfKeyByKind)) {
    if (kindPrefix !== prefix) continue;
    try {
      const lookup = build(parts, variant);
      // Only the exact key this lookup projects to names it: no padded, partial or extra parts.
      if (lookupKey(lookup) === key) return lookup;
    } catch {
      // Not this kind's key: invalid parts for it.
    }
  }
  return undefined;
}
