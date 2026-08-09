import assert from "node:assert/strict";
import test from "node:test";
import { compoundTvdbCoverage, type CompoundProviderEpisode, type LocalCompoundEpisode } from "../lib/compound-episodes";

function coverage(episodes: CompoundProviderEpisode[], local: LocalCompoundEpisode = { season: 1, episode: 1, title: episodes[0].title, runtime: episodes[0].runtime, tmdbEpisodeId: 900 }) {
  return compoundTvdbCoverage(episodes, [local]).map((item) => item.tvdbEpisodeId).sort((a, b) => a - b);
}

test("reconciles a double-length TMDB episode with split TVDB episodes", () => {
  assert.deepEqual(coverage([
    { source: "TMDB", season: 1, episode: 1, title: "Caretaker", airDate: "1995-01-16", runtime: 92, providerEpisodeId: 900 },
    { source: "TMDB", season: 1, episode: 2, title: "Parallax", airDate: "1995-01-23", runtime: 46, providerEpisodeId: 901 },
    { source: "TVDB", season: 1, episode: 1, title: "Caretaker (1)", airDate: "1995-01-16", runtime: 46, providerEpisodeId: 101 },
    { source: "TVDB", season: 1, episode: 2, title: "Caretaker (2)", airDate: "1995-01-16", runtime: 46, providerEpisodeId: 102 },
  ]), [101, 102]);
});

test("uses normal episode runtime when TVDB split runtimes are unavailable", () => {
  assert.deepEqual(coverage([
    { source: "TMDB", season: 1, episode: 1, title: "Lost & Found (1) / Lost & Found (2)", airDate: "2021-10-28", runtime: 46, providerEpisodeId: 900 },
    { source: "TMDB", season: 1, episode: 3, title: "Starstruck", airDate: "2021-11-04", runtime: 24, providerEpisodeId: 901 },
    { source: "TMDB", season: 1, episode: 4, title: "Dreamcatcher", airDate: "2021-11-11", runtime: 24, providerEpisodeId: 902 },
    { source: "TVDB", season: 1, episode: 1, title: "Lost & Found (1)", airDate: "2021-10-28", providerEpisodeId: 101 },
    { source: "TVDB", season: 1, episode: 2, title: "Lost & Found (2)", airDate: "2021-10-28", providerEpisodeId: 102 },
  ]), [101, 102]);
});

test("does not combine unrelated episodes that merely share an air date", () => {
  assert.deepEqual(coverage([
    { source: "TMDB", season: 1, episode: 1, title: "Opening Night", airDate: "2026-01-01", runtime: 44, providerEpisodeId: 900 },
    { source: "TMDB", season: 1, episode: 2, title: "Another Story", airDate: "2026-01-08", runtime: 22, providerEpisodeId: 901 },
    { source: "TVDB", season: 1, episode: 1, title: "Opening Night", airDate: "2026-01-01", runtime: 22, providerEpisodeId: 101 },
    { source: "TVDB", season: 1, episode: 2, title: "Second Showing", airDate: "2026-01-01", runtime: 22, providerEpisodeId: 102 },
  ]), []);
});

test("does not grant coverage when the TMDB compound is not locally owned", () => {
  assert.deepEqual(coverage([
    { source: "TMDB", season: 7, episode: 25, title: "Endgame", airDate: "2001-05-23", runtime: 86, providerEpisodeId: 999 },
    { source: "TVDB", season: 7, episode: 25, title: "Endgame (1)", airDate: "2001-05-23", runtime: 43, providerEpisodeId: 101 },
    { source: "TVDB", season: 7, episode: 26, title: "Endgame (2)", airDate: "2001-05-23", runtime: 43, providerEpisodeId: 102 },
  ]), []);
});

test("records the Plex coordinate, TMDB identity, and evidence", () => {
  const result = compoundTvdbCoverage([
    { source: "TMDB", season: 3, episode: 1, title: "Career Day (1) / Career Day (2)", airDate: "2024-02-07", runtime: 43, providerEpisodeId: 4926701 },
    { source: "TMDB", season: 3, episode: 2, title: "Gregory's Garden Goofballs", airDate: "2024-02-14", runtime: 22, providerEpisodeId: 4926702 },
    { source: "TMDB", season: 3, episode: 3, title: "Smoking", airDate: "2024-02-21", runtime: 22, providerEpisodeId: 4926703 },
    { source: "TVDB", season: 3, episode: 1, title: "Career Day (1)", airDate: "2024-02-07", runtime: 22, providerEpisodeId: 10148644 },
    { source: "TVDB", season: 3, episode: 2, title: "Career Day (2)", airDate: "2024-02-07", runtime: 22, providerEpisodeId: 10150697 },
  ], [{ season: 3, episode: 1, title: "Career Day (1) / Career Day (2)", runtime: 43.064, tmdbEpisodeId: 4926701, tvdbEpisodeId: 10148644, imdbEpisodeId: "tt26031060" }]);
  assert.deepEqual(result.map(({ tvdbEpisodeId, plexSeason, plexEpisode, tmdbEpisodeId }) => ({ tvdbEpisodeId, plexSeason, plexEpisode, tmdbEpisodeId })), [
    { tvdbEpisodeId: 10148644, plexSeason: 3, plexEpisode: 1, tmdbEpisodeId: 4926701 },
    { tvdbEpisodeId: 10150697, plexSeason: 3, plexEpisode: 1, tmdbEpisodeId: 4926701 },
  ]);
  assert.ok(result.every((item) => item.evidence.includes("matching-normalized-title") && item.evidence.includes("plex-runtime-matches-split-total")));
});
