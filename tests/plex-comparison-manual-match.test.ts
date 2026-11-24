import assert from "node:assert/strict";
import test from "node:test";
import { comparePlexShow, type PlexComparisonInput, type ProviderEpisode } from "../lib/plex-comparison";
import type { CoverageEvidence, CoverageMapping, CoverageProvider } from "../lib/manual-coverage-model";

// How the per-show comparison grants Manual Match coverage: a Healthy Manual Match
// covers an episode when every member on the other provider side is directly owned
// somewhere in the Library inventory. These cases reach the Manual Match step because
// no numbers or automatic evidence collect the episode.

const episode = (source: CoverageProvider, id: number, number: number): ProviderEpisode => ({ source, season: 1, episode: number, providerEpisodeId: id, title: `Episode ${number}` });
const member = (provider: CoverageProvider, id: number) => ({ provider, id, showId: 1, show: "Show", title: `${provider} ${id}`, season: 1, episode: 1, url: "" });
const mapping = (id: string, members: [CoverageProvider, number][], health?: CoverageMapping["health"]): CoverageMapping => ({ id, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", members: members.map(([provider, memberId]) => member(provider, memberId)), ...(health ? { health } : {}) });
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

test("a TMDB episode is covered by its Manual Match when the TVDB member is directly owned, with the owning evidence", () => {
  const source = owned("item-200", "show", ["TVDB", 200]);
  const result = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 2, 2), episode("TMDB", 3, 3)], mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]])], manualInventory: [owned("item-other", "show", ["TVDB", 999]), source] }));
  assert.deepEqual(missing(result), ["TMDB:3"]);
  assert.equal(statusOf(result, "TMDB", 2), "manual");
  assert.deepEqual(result.manualCoverage, [{ mappingId: "m", source: [source] }]);
  assert.deepEqual(result.autoMatches, []);
  assert.deepEqual(result.episodeFailures, []);
});

test("a TVDB combined episode is covered only by the complete set of directly owned TMDB split episodes", () => {
  const combined = mapping("split", [["TVDB", 100], ["TMDB", 1], ["TMDB", 2]]);
  const providerEpisodes = [episode("TVDB", 100, 1)];
  const complete = comparePlexShow(input({ providerEpisodes, mappings: [combined], manualInventory: [owned("a", "show", ["TMDB", 1]), owned("b", "show", ["TMDB", 2])] }));
  assert.deepEqual(missing(complete), []);
  assert.equal(statusOf(complete, "TVDB", 100), "manual");
  assert.deepEqual(complete.manualCoverage, [{ mappingId: "split", source: [owned("a", "show", ["TMDB", 1]), owned("b", "show", ["TMDB", 2])] }]);

  const partial = comparePlexShow(input({ providerEpisodes, mappings: [combined], manualInventory: [owned("a", "show", ["TMDB", 1])] }));
  assert.deepEqual(missing(partial), ["TVDB:100"], "owning only some members on the other side grants nothing");
  assert.equal(statusOf(partial, "TVDB", 100), "missing");
  assert.deepEqual(partial.manualCoverage, []);
});

test("a many-to-many Manual Match covers each episode only when every member on the other side is owned", () => {
  const many = mapping("many", [["TMDB", 1], ["TMDB", 2], ["TVDB", 100], ["TVDB", 101]]);
  const providerEpisodes = [episode("TMDB", 1, 1), episode("TMDB", 2, 2)];
  const covered = comparePlexShow(input({ providerEpisodes, mappings: [many], manualInventory: [owned("a", "show", ["TVDB", 100], ["TVDB", 101])] }));
  assert.deepEqual(missing(covered), []);
  assert.deepEqual(covered.manualCoverage.map(item => item.mappingId), ["many"], "one coverage entry per Manual Match");
  const partial = comparePlexShow(input({ providerEpisodes, mappings: [many], manualInventory: [owned("a", "show", ["TVDB", 100])] }));
  assert.deepEqual(missing(partial), ["TMDB:1", "TMDB:2"]);
});

test("a Manual Match with no saved health counts as Healthy; Pending and Needs review grant nothing", () => {
  const providerEpisodes = [episode("TMDB", 2, 2)];
  const manualInventory = [owned("a", "show", ["TVDB", 200])];
  for (const [health, expected] of [[undefined, []], ["healthy", []], ["pending", ["TMDB:2"]], ["needs-review", ["TMDB:2"]]] as const) {
    const result = comparePlexShow(input({ providerEpisodes, manualInventory, mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]], health)] }));
    assert.deepEqual(missing(result), expected, `health ${health}`);
  }
});

test("the first Healthy Manual Match containing the episode decides it; a Pending one before it is passed over", () => {
  const providerEpisodes = [episode("TMDB", 2, 2)];
  const pendingFirst = comparePlexShow(input({ providerEpisodes, manualInventory: [owned("a", "show", ["TVDB", 201])], mappings: [mapping("p", [["TMDB", 2], ["TVDB", 200]], "pending"), mapping("h", [["TMDB", 2], ["TVDB", 201]])] }));
  assert.deepEqual(pendingFirst.manualCoverage.map(item => item.mappingId), ["h"]);
  // An incomplete first Healthy match is not replaced by a later one.
  const incompleteFirst = comparePlexShow(input({ providerEpisodes, manualInventory: [owned("a", "show", ["TVDB", 201])], mappings: [mapping("first", [["TMDB", 2], ["TVDB", 200]]), mapping("second", [["TMDB", 2], ["TVDB", 201]])] }));
  assert.deepEqual(missing(incompleteFirst), ["TMDB:2"]);
});

test("a source owned in another show, including an ignored one, still covers the episode", () => {
  const source = owned("elsewhere", "ignored-show", ["TVDB", 200]);
  const result = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 2, 2)], mappings: [mapping("cross", [["TMDB", 2], ["TVDB", 200]])], manualInventory: [source] }));
  assert.deepEqual(missing(result), []);
  assert.deepEqual(result.manualCoverage, [{ mappingId: "cross", source: [source] }]);
});

test("coverage needs direct identities: matching numbers or coverage granted by another Manual Match grant nothing", () => {
  // TVDB 200 is not directly owned. Its numbers match a local episode and another
  // Manual Match would cover it from owned TMDB 9, yet neither counts as owning it.
  const result = comparePlexShow(input({
    providerEpisodes: [episode("TMDB", 2, 2)], localEpisodes: new Set(["1:1"]),
    mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]]), mapping("chain", [["TVDB", 200], ["TMDB", 9]])],
    manualInventory: [owned("a", "show", ["TMDB", 9])],
  }));
  assert.deepEqual(missing(result), ["TMDB:2"]);
  assert.deepEqual(result.manualCoverage, []);
});

test("an episode without a provider episode ID is never covered by a Manual Match", () => {
  const result = comparePlexShow(input({ providerEpisodes: [{ source: "TMDB", season: 1, episode: 2, title: "No ID" }], mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]])], manualInventory: [owned("a", "show", ["TVDB", 200])] }));
  assert.equal(result.missing.length, 1);
  assert.deepEqual(result.manualCoverage, []);
});

test("an unreadable Manual Match is an Episode-scoped failure: an episode another Manual Match covers is still covered", () => {
  const unreadable = { id: "broken", get members(): never { throw new Error("saved members unreadable"); } } as unknown as CoverageMapping;
  const result = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 2, 2), episode("TMDB", 3, 3)], mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]]), unreadable], manualInventory: [owned("a", "show", ["TVDB", 200])] }));
  assert.deepEqual(missing(result), ["TMDB:3"]);
  assert.deepEqual(result.manualCoverage.map(item => item.mappingId), ["m"]);
  assert.deepEqual(result.episodeFailures.map(failure => `${failure.method}:${failure.episode.id}`), ["report-missing:3", "manual-match:3"]);
});

test("an unreadable evidence record fails the Manual Match check of each episode that reads it, not the comparison", () => {
  const unreadable = { ratingKey: "bad", showKey: "show", get identities(): never { throw new Error("evidence unreadable"); } } as unknown as CoverageEvidence;
  const result = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 1, 1), episode("TMDB", 2, 2)], localEpisodes: new Set(["1:1"]), mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]])], manualInventory: [owned("a", "show", ["TVDB", 200]), unreadable] }));
  assert.deepEqual(missing(result), ["TMDB:2"], "no guessed coverage; episode 1 is still collected by numbers");
  assert.deepEqual(result.episodeFailures.map(failure => `${failure.method}:${failure.episode.id}`), ["manual-match:2"]);
  assert.match(result.episodeFailures[0].reason, /evidence unreadable/);
});
