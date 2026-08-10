import assert from "node:assert/strict";
import test from "node:test";
import { equivalentTmdbShowIds, ownedTmdbEpisodeMatch, tmdbShowLinksToTvdb } from "../lib/tmdb-show-equivalence";

test("allows multiple TMDB series linked to one TVDB series", () => {
  assert.deepEqual([...equivalentTmdbShowIds(107124, [{ id: 82 }, { id: 107124 }])].sort((a, b) => a - b), [82, 107124]);
});

test("keeps the selected TMDB series when the TVDB lookup has no matches", () => {
  assert.deepEqual([...equivalentTmdbShowIds(107124)], [107124]);
});

test("ignores malformed TVDB lookup results", () => {
  assert.deepEqual([...equivalentTmdbShowIds(82, [{}, { id: Number.NaN }])], [82]);
});

test("accepts an episode-discovered TMDB alias linked back to the same TVDB show", () => {
  assert.equal(tmdbShowLinksToTvdb({ id: 107124, external_ids: { tvdb_id: 72879 } }, 72879), true);
});

test("rejects an episode-discovered TMDB show linked to another TVDB show", () => {
  assert.equal(tmdbShowLinksToTvdb({ id: 107124, external_ids: { tvdb_id: 99999 } }, 72879), false);
});

test("accepts a direct TVDB-to-TMDB episode mapping owned under another Plex show", () => {
  assert.deepEqual(ownedTmdbEpisodeMatch([{ id: 2381453, show_id: 107124 }], new Set([2381453])), { id: 2381453, show_id: 107124 });
});

test("does not accept a direct episode mapping that Plex does not own", () => {
  assert.equal(ownedTmdbEpisodeMatch([{ id: 2381453, show_id: 107124 }], new Set()), undefined);
});
