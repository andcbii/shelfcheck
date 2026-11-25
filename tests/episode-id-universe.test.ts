import assert from "node:assert/strict";
import test from "node:test";
import { normaliseTmdbRecords, normaliseTvdbRecords } from "../lib/catalogue-records";
import { episodeIdEnumeration } from "../lib/episode-id-universe";

const ids = (universe: { ids: ReadonlySet<number> } | undefined) => [...(universe?.ids ?? [])].sort((a, b) => a - b);

test("a TVDB enumeration counts every episode ID it returned, including records the comparison's normalization drops", () => {
  // One page per array: specials, an unaired episode, an unnumbered record, a negative season and episode 0.
  const pages: unknown[][] = [
    [{ id: 101, seasonNumber: 1, number: 1 }, { id: 102, seasonNumber: 0, number: 1 }, { id: 103, seasonNumber: 1, number: 2, aired: null }],
    [{ id: 104 }, { id: 105, seasonNumber: -1, number: 1 }, { id: 106, seasonNumber: 1, number: 0 }, { id: 107, number: 3 }],
  ];
  const enumeration = episodeIdEnumeration("TVDB", 20);
  const normalised = { episodes: [], malformed: [] };
  pages.forEach((page, index) => { enumeration.add(page); normaliseTvdbRecords(20, "Show", index, page, normalised); });

  const universe = enumeration.complete();
  assert.deepEqual(ids(universe), [101, 102, 103, 104, 105, 106, 107]);
  assert.deepEqual({ ...universe, ids: undefined }, { provider: "TVDB", showId: 20, ids: undefined, complete: true, origin: "fresh-download" });
  // The comparison's own list leaves some of them out, so it can never stand in for the evidence.
  const compared = normalised.episodes.map((episode: { providerEpisodeId?: number }) => episode.providerEpisodeId);
  assert.ok(!compared.includes(104) && !compared.includes(105) && !compared.includes(106));
});

test("a TMDB enumeration counts every season's episode IDs, specials and unnumbered records included", () => {
  const enumeration = episodeIdEnumeration("TMDB", 10);
  const seasons: [number, unknown[]][] = [[0, [{ id: 1, season_number: 0, episode_number: 1 }]], [1, [{ id: 2, season_number: 1, episode_number: 1 }, { id: 3, name: "No numbering" }]]];
  for (const [season, records] of seasons) { enumeration.add(records); normaliseTmdbRecords({ id: 10 }, season, records); }

  const universe = enumeration.complete();
  assert.deepEqual(ids(universe), [1, 2, 3]);
  assert.equal(universe?.provider, "TMDB");
  assert.equal(universe?.showId, 10);
});

for (const [label, record] of [
  ["a record that is not an object", "garbage"],
  ["a record with no ID", { seasonNumber: 1, number: 2 }],
  ["a record with an unreadable ID", { id: "12", seasonNumber: 1, number: 2 }],
  ["a record with a non-positive ID", { id: 0, seasonNumber: 1, number: 2 }],
] as const) {
  test(`an enumeration with ${label} is never marked complete`, () => {
    const enumeration = episodeIdEnumeration("TVDB", 20);
    enumeration.add([{ id: 101, seasonNumber: 1, number: 1 }, record]);
    assert.equal(enumeration.complete(), undefined);
  });
}

test("a response that is not a list of records is never marked complete", () => {
  const enumeration = episodeIdEnumeration("TMDB", 10);
  enumeration.add([{ id: 1 }]);
  enumeration.add({ episodes: [] });
  assert.equal(enumeration.complete(), undefined);
});

test("an enumeration that returned no records at all is never marked complete", () => {
  assert.equal(episodeIdEnumeration("TVDB", 20).complete(), undefined);
});

test("evidence handed out cannot be changed by further records", () => {
  const enumeration = episodeIdEnumeration("TVDB", 20);
  enumeration.add([{ id: 101 }]);
  const universe = enumeration.complete();
  enumeration.add([{ id: 102 }]);
  assert.deepEqual(ids(universe), [101]);
});
