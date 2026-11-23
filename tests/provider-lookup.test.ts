import assert from "node:assert/strict";
import test from "node:test";
import { isEpisodeCoordinate, isProviderId, lookupKey, lookupUrl, providerLookup, tmdbEpisodeCrosswalkOfKey } from "../lib/provider-lookup";

// Today's exact stored relationship keys (and lookup Coverage Issue ID suffixes). Story 5 changes them.
const todaysKeys = [
  [providerLookup.tmdbEpisodeByTvdbEpisode(301), "TMDB:https://api.themoviedb.org/3/find/301?external_source=tvdb_id"],
  [providerLookup.tmdbSeriesByTvdbSeries(20), "TMDB:https://api.themoviedb.org/3/find/20?external_source=tvdb_id"],
  [providerLookup.tmdbEpisodeByShowSeasonEpisode(10, 0, 3), "TMDB:https://api.themoviedb.org/3/tv/10/season/0/episode/3"],
  [providerLookup.tmdbSeriesSummary(10), "TMDB:https://api.themoviedb.org/3/tv/10"],
  [providerLookup.tmdbSeriesSummaryWithExternalIds(10), "TMDB:https://api.themoviedb.org/3/tv/10?append_to_response=external_ids"],
  [providerLookup.tvdbSeriesSummary(20), "TVDB:https://api4.thetvdb.com/v4/series/20"],
  [providerLookup.tvdbEpisodeExtended(301), "TVDB:https://api4.thetvdb.com/v4/episodes/301/extended"],
  [providerLookup.traktEpisodeSearchByTvdbEpisode(301), "Trakt:https://api.trakt.tv/search/tvdb/301?type=episode"],
] as const;

test("every typed lookup projects to today's exact stored key", () => {
  for (const [lookup, key] of todaysKeys) assert.equal(lookupKey(lookup), key, lookup.kind);
});

test("a lookup's stored key today is its provider and request URL", () => {
  for (const [lookup, key] of todaysKeys) assert.equal(`${key.slice(0, key.indexOf(":"))}:${lookupUrl(lookup)}`, key, lookup.kind);
});

test("series and episode lookups are distinct kinds even where today's key is shared", () => {
  const episode = providerLookup.tmdbEpisodeByTvdbEpisode(20);
  const series = providerLookup.tmdbSeriesByTvdbSeries(20);
  assert.notEqual(episode.kind, series.kind);
  // CURRENT COLLISION (changes at the cutover): both project to one stored key today.
  assert.equal(lookupKey(episode), lookupKey(series));
  const basic = providerLookup.tmdbSeriesSummary(10);
  const external = providerLookup.tmdbSeriesSummaryWithExternalIds(10);
  assert.notEqual(lookupKey(basic), lookupKey(external));
});

test("lookup inputs are validated", () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => providerLookup.tmdbEpisodeByTvdbEpisode(id), RangeError);
    assert.throws(() => providerLookup.tmdbSeriesByTvdbSeries(id), RangeError);
    assert.throws(() => providerLookup.tmdbSeriesSummary(id), RangeError);
    assert.throws(() => providerLookup.tmdbSeriesSummaryWithExternalIds(id), RangeError);
    assert.throws(() => providerLookup.tvdbSeriesSummary(id), RangeError);
    assert.throws(() => providerLookup.tvdbEpisodeExtended(id), RangeError);
    assert.throws(() => providerLookup.traktEpisodeSearchByTvdbEpisode(id), RangeError);
    assert.throws(() => providerLookup.tmdbEpisodeByShowSeasonEpisode(id, 1, 1), RangeError);
  }
  // Season 0 (specials) and episode 0 are real coordinates; negative or fractional ones are not.
  assert.doesNotThrow(() => providerLookup.tmdbEpisodeByShowSeasonEpisode(10, 0, 0));
  assert.throws(() => providerLookup.tmdbEpisodeByShowSeasonEpisode(10, -1, 1), RangeError);
  assert.throws(() => providerLookup.tmdbEpisodeByShowSeasonEpisode(10, 1, 1.5), RangeError);
  // Callers check provider answers with the same rules before building a lookup.
  assert.deepEqual([1, 0, -1, 1.5, "1", Number.NaN].map(isEpisodeCoordinate), [true, true, false, false, false, false]);
  assert.deepEqual([1, 0, -1, 1.5, "1", Number.NaN].map(isProviderId), [true, false, false, false, false, false]);
});

test("the per-show clear finds the TVDB episode whose TMDB crosswalk a stored key names", () => {
  assert.equal(tmdbEpisodeCrosswalkOfKey("TMDB:https://api.themoviedb.org/3/find/301?external_source=tvdb_id"), 301);
  for (const key of ["TMDB:https://api.themoviedb.org/3/tv/10", "TVDB:https://api4.thetvdb.com/v4/episodes/301/extended", "Trakt:https://api.trakt.tv/search/tvdb/301?type=episode", "TMDB:https://api.themoviedb.org/3/find/301?external_source=imdb_id", "anything"])
    assert.equal(tmdbEpisodeCrosswalkOfKey(key), undefined, key);
});
