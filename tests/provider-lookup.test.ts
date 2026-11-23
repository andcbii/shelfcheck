import assert from "node:assert/strict";
import test from "node:test";
import { isEpisodeCoordinate, isProviderId, lookupKey, lookupOfKey, providerLookup } from "../lib/provider-lookup";

// The exact stored relationship keys (and lookup Coverage Issue ID suffixes): `<kind>:<inputs>`.
const storedKeys = [
  [providerLookup.tmdbEpisodeByTvdbEpisode(301), "tmdb-episode-by-tvdb:301"],
  [providerLookup.tmdbSeriesByTvdbSeries(20), "tmdb-series-by-tvdb:20"],
  [providerLookup.tmdbEpisodeByShowSeasonEpisode(10, 0, 3), "tmdb-episode:10:0:3"],
  [providerLookup.tmdbSeriesSummary(10), "tmdb-series:10:summary"],
  [providerLookup.tmdbSeriesSummaryWithExternalIds(10), "tmdb-series:10:external-ids"],
  [providerLookup.tvdbSeriesSummary(20), "tvdb-series:20"],
  [providerLookup.tvdbEpisodeExtended(301), "tvdb-episode-extended:301"],
  [providerLookup.traktEpisodeSearchByTvdbEpisode(301), "trakt-episode-by-tvdb:301"],
] as const;

test("every typed lookup projects to its exact stored key", () => {
  for (const [lookup, key] of storedKeys) assert.equal(lookupKey(lookup), key, lookup.kind);
});

test("a stored key reads back as the typed lookup it was made from, and nothing else does", () => {
  for (const [lookup, key] of storedKeys) assert.deepEqual(lookupOfKey(key), lookup, key);
  for (const key of [
    "TMDB:https://api.themoviedb.org/3/find/301?external_source=tvdb_id", "tmdb-episode-by-tvdb:0", "tmdb-episode-by-tvdb:01", "tmdb-episode-by-tvdb:1.5",
    "tmdb-episode-by-tvdb:301:extra", "tmdb-series:10", "tmdb-series:10:other", "tmdb-episode:10:1", "tmdb-crosswalk:301", "comparison:1", "anything", "",
  ]) assert.equal(lookupOfKey(key), undefined, key);
});

test("series and episode lookups with the same numeric ID have separate stored keys", () => {
  const episode = providerLookup.tmdbEpisodeByTvdbEpisode(20);
  const series = providerLookup.tmdbSeriesByTvdbSeries(20);
  assert.notEqual(episode.kind, series.kind);
  assert.notEqual(lookupKey(episode), lookupKey(series));
  assert.equal(lookupOfKey(lookupKey(series))?.kind, "tmdb-series-by-tvdb-series");
  assert.equal(lookupOfKey(lookupKey(episode))?.kind, "tmdb-episode-by-tvdb-episode");
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
