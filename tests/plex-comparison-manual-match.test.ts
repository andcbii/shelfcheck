import assert from "node:assert/strict";
import test from "node:test";
import { comparePlexShow, type PlexComparisonInput, type ProviderEpisode } from "../lib/plex-comparison";
import type { CoverageEvidence, CoverageMapping, CoverageProvider } from "../lib/manual-coverage-model";
import { lookupFailureIssueId } from "../lib/coverage-issue-ids";
import { providerLookup } from "../lib/provider-lookup";

// How the per-show comparison grants Manual Match coverage: a Manual Match
// covers an episode when every member on the other provider side is directly owned
// somewhere in the Library inventory. It is checked right after Report Missing, so it
// decides an episode ahead of numbers and automatic evidence (ADR-0007).

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

test("the first Manual Match containing the episode decides it", () => {
  const providerEpisodes = [episode("TMDB", 2, 2)];
  // An incomplete first match is not replaced by a later one.
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

// ADR-0007: a covering Manual Match decides an episode right after Report Missing,
// ahead of season and episode numbers and automatic evidence.

test("a covering Manual Match wins over matching season and episode numbers, in both provider directions", () => {
  const tmdbSide = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 2, 2)], localEpisodes: new Set(["1:2"]), mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]])], manualInventory: [owned("a", "show", ["TVDB", 200])] }));
  assert.equal(statusOf(tmdbSide, "TMDB", 2), "manual");
  assert.deepEqual(tmdbSide.manualCoverage.map(item => item.mappingId), ["m"]);
  const tvdbSide = comparePlexShow(input({ providerEpisodes: [episode("TVDB", 200, 2)], localEpisodes: new Set(["1:2"]), mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]])], manualInventory: [owned("a", "show", ["TMDB", 2])] }));
  assert.equal(statusOf(tvdbSide, "TVDB", 200), "manual");
  assert.deepEqual(tvdbSide.manualCoverage.map(item => item.mappingId), ["m"]);
  assert.deepEqual([...missing(tmdbSide), ...missing(tvdbSide)], []);
});

test("a covering Manual Match wins over each kind of automatic evidence, and saved automatic evidence makes no Auto Match", () => {
  const covering = { mappings: [mapping("m", [["TVDB", 200], ["TMDB", 2]])], manualInventory: [owned("a", "show", ["TMDB", 2])] };
  const tvdb200 = new Set([200]);
  const kinds: [string, Partial<PlexComparisonInput>][] = [
    ["direct TVDB", { directTvdbSatisfied: tvdb200 }], ["direct IMDb", { directImdbSatisfied: tvdb200 }],
    ["Trakt", { traktSatisfied: tvdb200 }], ["TMDB crosswalk", { tmdbSatisfied: tvdb200 }],
  ];
  for (const [kind, evidence] of kinds) {
    const result = comparePlexShow(input({ providerEpisodes: [episode("TVDB", 200, 2), episode("TVDB", 201, 3)], ...covering, ...evidence,
      autoMatchEvidence: new Map([[200, { method: "Matched via IMDb" as const, tmdbEpisodeId: 2 }], [201, { method: "Matched via IMDb" as const, tmdbEpisodeId: 3 }]]), directImdbSatisfied: new Set([...(evidence.directImdbSatisfied ?? []), 201]) }));
    assert.equal(statusOf(result, "TVDB", 200), "manual", kind);
    assert.deepEqual(result.manualCoverage.map(item => item.mappingId), ["m"], kind);
    assert.deepEqual(result.autoMatches.map(match => match.tvdb.id), [201], `${kind}: only the uncovered episode keeps its Auto Match`);
    assert.deepEqual(missing(result), [], kind);
  }
  // A TMDB episode owned by identity is still credited to its covering Manual Match.
  const tmdbSide = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 2, 2)], libraryTmdbEpisodeIds: new Set([2]), mappings: [mapping("m", [["TMDB", 2], ["TVDB", 200]])], manualInventory: [owned("a", "show", ["TVDB", 200])] }));
  assert.equal(statusOf(tmdbSide, "TMDB", 2), "manual");
  assert.deepEqual(tmdbSide.manualCoverage.map(item => item.mappingId), ["m"]);
});

test("explicit Report Missing and a derived Incomplete combined episode still win over a covering Manual Match", () => {
  const reportedMatch = mapping("r", [["TMDB", 2], ["TVDB", 200]]);
  reportedMatch.members[0].reportMissing = true;
  const reported = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 2, 2)], localEpisodes: new Set(["1:2"]), mappings: [reportedMatch], manualInventory: [owned("a", "show", ["TVDB", 200])] }));
  assert.deepEqual(missing(reported), ["TMDB:2"]);
  assert.equal(reported.missing[0].reportedMissing?.[0], "TMDB");
  assert.deepEqual(reported.manualCoverage, []);

  // TVDB 100 combines TMDB 1 and 2; TMDB 2 is flagged, so TVDB 100 is incomplete although both parts are owned.
  const split = mapping("split", [["TVDB", 100], ["TMDB", 1], ["TMDB", 2]]);
  split.members[2].reportMissing = true;
  const incomplete = comparePlexShow(input({ providerEpisodes: [episode("TVDB", 100, 1)], localEpisodes: new Set(["1:1"]), directTvdbSatisfied: new Set([100]), mappings: [split], manualInventory: [owned("a", "show", ["TMDB", 1]), owned("b", "show", ["TMDB", 2])] }));
  assert.deepEqual(missing(incomplete), ["TVDB:100"]);
  assert.deepEqual(incomplete.missing[0].incomplete, { TVDB: [{ provider: "TMDB", id: 2 }] });
  assert.deepEqual(incomplete.manualCoverage, []);
  assert.deepEqual(incomplete.autoMatches, []);
});

test("a partly owned other side falls through to numbers, automatic evidence and missing results", () => {
  const tvdbEpisodes = [episode("TVDB", 200, 2), episode("TVDB", 201, 3), episode("TVDB", 202, 4)];
  const evidence: Partial<PlexComparisonInput> = { localEpisodes: new Set(["1:2"]), directImdbSatisfied: new Set([201]), autoMatchEvidence: new Map([[201, { method: "Matched via IMDb" as const, tmdbEpisodeId: 3 }]]) };
  const partOwned = [owned("a", "show", ["TMDB", 2]), owned("b", "show", ["TMDB", 3]), owned("c", "show", ["TMDB", 4])];
  const cases: [string, CoverageMapping[], CoverageEvidence[]][] = [
    ["partly owned", [mapping("m", [["TVDB", 200], ["TVDB", 201], ["TVDB", 202], ["TMDB", 2], ["TMDB", 3], ["TMDB", 4], ["TMDB", 5]])], partOwned],
  ];
  for (const [label, mappings, manualInventory] of cases) {
    const result = comparePlexShow(input({ providerEpisodes: tvdbEpisodes, mappings, manualInventory, ...evidence }));
    assert.deepEqual(result.manualCoverage, [], label);
    assert.deepEqual([200, 201, 202].map(id => statusOf(result, "TVDB", id)), ["automatic", "automatic", "missing"], label);
    assert.deepEqual(result.autoMatches.map(match => match.tvdb.id), [201], label);
    assert.deepEqual(missing(result), ["TVDB:202"], label);
  }
});

test("one-to-many and many-to-many complete sets win over matching numbers for every covered member", () => {
  const combined = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 1, 1), episode("TMDB", 2, 2)], localEpisodes: new Set(["1:1", "1:2"]), mappings: [mapping("split", [["TVDB", 100], ["TMDB", 1], ["TMDB", 2]])], manualInventory: [owned("a", "show", ["TVDB", 100])] }));
  assert.deepEqual([statusOf(combined, "TMDB", 1), statusOf(combined, "TMDB", 2)], ["manual", "manual"]);
  const many = comparePlexShow(input({ providerEpisodes: [episode("TVDB", 100, 1), episode("TVDB", 101, 2)], localEpisodes: new Set(["1:1", "1:2"]), directTvdbSatisfied: new Set([100, 101]), autoMatchEvidence: new Map([[100, { method: "Matched via IMDb" as const, tmdbEpisodeId: 1 }]]), mappings: [mapping("many", [["TMDB", 1], ["TMDB", 2], ["TVDB", 100], ["TVDB", 101]])], manualInventory: [owned("a", "show", ["TMDB", 1], ["TMDB", 2])] }));
  assert.deepEqual([statusOf(many, "TVDB", 100), statusOf(many, "TVDB", 101)], ["manual", "manual"]);
  assert.deepEqual(many.manualCoverage.map(item => item.mappingId), ["many"]);
  assert.deepEqual(many.autoMatches, []);
});

test("a failed Manual Match check leaves the later numbers and automatic evidence checks usable", () => {
  const unreadable = { ratingKey: "bad", showKey: "show", get identities(): never { throw new Error("evidence unreadable"); } } as unknown as CoverageEvidence;
  const result = comparePlexShow(input({ providerEpisodes: [episode("TMDB", 1, 1), episode("TMDB", 2, 2), episode("TMDB", 3, 3)], localEpisodes: new Set(["1:1"]), libraryTmdbEpisodeIds: new Set([2]),
    mappings: [mapping("m", [["TMDB", 1], ["TMDB", 2], ["TMDB", 3], ["TVDB", 200]])], manualInventory: [unreadable] }));
  assert.deepEqual([1, 2, 3].map(id => statusOf(result, "TMDB", id)), ["automatic", "automatic", "missing"]);
  assert.deepEqual(missing(result), ["TMDB:3"]);
  assert.deepEqual(result.episodeFailures.map(failure => `${failure.method}:${failure.episode.id}:${failure.coveredBy ?? "-"}`), ["manual-match:1:coordinates", "manual-match:2:automatic-evidence", "manual-match:3:-"]);
});

// Scan Issues (ADR-0007): a crosswalk check a covering Manual Match made unnecessary is not a
// failure, as for Report Missing; an uncovered episode's failed check stays, as do other operations.
test("crosswalk failures a covering Manual Match made unnecessary are dropped; an uncovered episode's are kept", () => {
  const crosswalk = (id: number, existingOnly?: "carry") => ({ operation: "episode-crosswalk" as const, crosswalk: "TMDB" as const, episode: { provider: "TVDB" as const, id, season: 1, episode: id - 100 }, kind: "request-failed" as const, reason: "the TMDB request failed.", causedBy: [lookupFailureIssueId("show", providerLookup.tmdbEpisodeByTvdbEpisode(id))], ...(existingOnly ? { existingOnly } : {}) });
  const result = comparePlexShow(input({
    providerEpisodes: [episode("TVDB", 101, 1), episode("TVDB", 102, 2), episode("TVDB", 103, 3)],
    coordinateMissingTvdbIds: new Set([101, 102, 103]),
    mappings: [mapping("m", [["TVDB", 101], ["TMDB", 1]]), mapping("n", [["TVDB", 103], ["TMDB", 3]])],
    manualInventory: [owned("a", "show", ["TMDB", 1]), owned("c", "show", ["TMDB", 3])],
    crosswalkFailures: [crosswalk(101), crosswalk(102), crosswalk(103, "carry")],
  }));
  assert.equal(statusOf(result, "TVDB", 101), "manual");
  assert.equal(statusOf(result, "TVDB", 103), "manual");
  assert.deepEqual(result.episodeFailures.map(failure => failure.episode.id), [102], "only the uncovered episode's check is still a failure, fresh or carried alike");
  assert.equal(result.episodeFailures[0].coveredBy, undefined);
  assert.deepEqual(missing(result), ["TVDB:102"]);
});
