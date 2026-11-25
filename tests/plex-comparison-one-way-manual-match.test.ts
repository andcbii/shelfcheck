import assert from "node:assert/strict";
import test from "node:test";
import { comparePlexShow, type PlexComparisonInput, type ProviderEpisode } from "../lib/plex-comparison";
import type { CoverageEvidence, CoverageMapping, CoverageProvider } from "../lib/manual-coverage-model";

// One-way Manual Match coverage (ADR-0008). TMDB is the Library's official order, so a
// Manual Match grants coverage only to its TVDB members, when every TMDB member is
// directly owned. Owning TVDB members never gives a TMDB episode Manual Match coverage:
// TMDB episodes are matched only by episode number or identity.
//
// Episode numbers here never match a local episode unless a test says so, so automatic
// coordinate matching cannot hide a broken direction check.

const episode = (source: CoverageProvider, id: number, number: number): ProviderEpisode => ({ source, season: 1, episode: number, providerEpisodeId: id, title: `Episode ${number}` });
const member = (provider: CoverageProvider, id: number) => ({ provider, id, showId: 1, show: "Show", title: `${provider} ${id}`, season: 1, episode: 1, url: "" });
const mapping = (id: string, members: [CoverageProvider, number][]): CoverageMapping => ({ id, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", members: members.map(([provider, memberId]) => member(provider, memberId)) });
const owned = (ratingKey: string, showKey: string, ...identities: [CoverageProvider, number][]): CoverageEvidence => ({ ratingKey, showKey, identities: identities.map(([provider, id]) => ({ provider, id })) });

function input(overrides: Partial<PlexComparisonInput> = {}): PlexComparisonInput {
  return {
    ratingKey: "show", primary: { title: "Show" }, tmdbShow: { id: 10 }, tvdbId: 20, tmdbSeriesMatches: [],
    providerEpisodes: [], localEpisodes: new Set(), localProviderEpisodes: [], localTmdbEpisodeIds: new Set(),
    libraryTmdbEpisodeIds: new Set(), coordinateMissingTvdbIds: new Set(), directTvdbSatisfied: new Set(),
    directImdbSatisfied: new Set(), traktSatisfied: new Set(), tmdbSatisfied: new Set(), autoMatchEvidence: new Map(),
    mappings: [], manualInventory: [], autoCompoundEpisodes: false, ...overrides,
  };
}
const missing = (result: ReturnType<typeof comparePlexShow>) => result.missing.map(item => `${item.sources.join("+")}:${item.tmdbEpisodeId ?? item.tvdbEpisodeId}`);
const statusOf = (result: ReturnType<typeof comparePlexShow>, provider: CoverageProvider, id: number) => result.coverageOutcomes.find(outcome => outcome.provider === provider && outcome.id === id)?.status;

test("owning every TVDB member never gives a TMDB episode Manual Match coverage", () => {
  const providerEpisodes = [episode("TMDB", 1, 11), episode("TMDB", 2, 12)];
  const cases: [string, CoverageMapping][] = [
    ["one-to-one", mapping("one", [["TMDB", 1], ["TVDB", 100]])],
    ["split TMDB side", mapping("split", [["TMDB", 1], ["TMDB", 2], ["TVDB", 100]])],
    ["many-to-many", mapping("many", [["TMDB", 1], ["TMDB", 2], ["TVDB", 100], ["TVDB", 101]])],
  ];
  for (const [label, match] of cases) {
    const result = comparePlexShow(input({ providerEpisodes, mappings: [match], manualInventory: [owned("a", "show", ["TVDB", 100], ["TVDB", 101])] }));
    assert.deepEqual(result.manualCoverage, [], label);
    assert.deepEqual(missing(result), ["TMDB:1", "TMDB:2"], label);
    for (const id of match.members.filter(item => item.provider === "TMDB").map(item => item.id)) assert.equal(statusOf(result, "TMDB", id), "missing", `${label}: TMDB ${id}`);
    assert.deepEqual(result.episodeFailures, [], label);
  }
});

test("with both sides in one show, the TVDB member is covered by the owned TMDB member while the TMDB member waits for its own evidence", () => {
  const match = mapping("both", [["TMDB", 1], ["TVDB", 100]]);
  const source = owned("tmdb-item", "show", ["TMDB", 1]);
  const providerEpisodes = [episode("TMDB", 1, 11), episode("TVDB", 100, 21), episode("TMDB", 2, 12), episode("TVDB", 101, 22)];
  const tvdbOwned = comparePlexShow(input({ providerEpisodes, mappings: [match, mapping("other", [["TMDB", 2], ["TVDB", 101]])], manualInventory: [source, owned("tvdb-item", "show", ["TVDB", 100], ["TVDB", 101])] }));
  assert.equal(statusOf(tvdbOwned, "TVDB", 100), "manual");
  assert.equal(statusOf(tvdbOwned, "TMDB", 1), "missing", "its owned TVDB partner never covers a TMDB episode");
  assert.equal(statusOf(tvdbOwned, "TMDB", 2), "missing", "owning TVDB 101 does not cover TMDB 2");
  assert.equal(statusOf(tvdbOwned, "TVDB", 101), "missing", "TMDB 2 is not owned");
  assert.deepEqual(tvdbOwned.manualCoverage, [{ mappingId: "both", source: [source] }]);
  assert.deepEqual(missing(tvdbOwned), ["TMDB:1", "TMDB:2", "TVDB:101"]);

  // TMDB 1 is matched by its own identity; the Manual Match still credits only TVDB 100.
  const byIdentity = comparePlexShow(input({ providerEpisodes: providerEpisodes.slice(0, 2), libraryTmdbEpisodeIds: new Set([1]), mappings: [match], manualInventory: [source] }));
  assert.deepEqual([statusOf(byIdentity, "TMDB", 1), statusOf(byIdentity, "TVDB", 100)], ["automatic", "manual"]);
  assert.deepEqual(missing(byIdentity), []);
});

test("a TMDB combined episode whose TVDB parts are reported missing is Incomplete, and owning its other parts never covers it", () => {
  const combined = mapping("combined", [["TMDB", 1], ["TVDB", 100], ["TVDB", 101]]);
  combined.members[2].reportMissing = true;
  const result = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 1, 1), episode("TVDB", 100, 21), episode("TVDB", 101, 22)], localEpisodes: new Set(["1:1"]), mappings: [combined], manualInventory: [owned("a", "show", ["TMDB", 1]), owned("b", "show", ["TVDB", 100])] }));
  assert.deepEqual(missing(result), ["TMDB:1", "TVDB:101"]);
  assert.deepEqual(result.missing.find(item => item.tmdbEpisodeId === 1)?.incomplete, { TMDB: [{ provider: "TVDB", id: 101 }] });
  assert.equal(statusOf(result, "TVDB", 100), "manual", "the unflagged TVDB part is still covered by the owned TMDB side");
  assert.deepEqual(result.missing.find(item => item.tvdbEpisodeId === 101)?.reportedMissing, ["TVDB"]);
  assert.deepEqual(result.manualCoverage, [{ mappingId: "combined", source: [owned("a", "show", ["TMDB", 1])] }]);
});
