import assert from "node:assert/strict";
import test from "node:test";
import { equivalentTmdbShowIds } from "../lib/tmdb-show-equivalence";

test("allows multiple TMDB series linked to one TVDB series", () => {
  assert.deepEqual([...equivalentTmdbShowIds(107124, [{ id: 82 }, { id: 107124 }])].sort((a, b) => a - b), [82, 107124]);
});

test("keeps the selected TMDB series when the TVDB lookup has no matches", () => {
  assert.deepEqual([...equivalentTmdbShowIds(107124)], [107124]);
});

test("ignores malformed TVDB lookup results", () => {
  assert.deepEqual([...equivalentTmdbShowIds(82, [{}, { id: Number.NaN }])], [82]);
});
