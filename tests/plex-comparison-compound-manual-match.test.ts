import assert from "node:assert/strict";
import test from "node:test";
import { comparePlexShow, type PlexComparisonInput, type ProviderEpisode } from "../lib/plex-comparison";
import type { CoverageEvidence, CoverageMapping, CoverageProvider } from "../lib/manual-coverage-model";

// Episodes a Manual Match covers take no part in combined/split (compound) matching
// (ADR-0007): a covered part is never an input, not even only to prove coverage for an
// uncovered sibling, and a covered TMDB combined-side record is not one either. Only a
// remaining relationship that meets the existing rules covers the remaining parts.

const tmdb = (id: number, number: number, title: string, airDate: string, runtime: number): ProviderEpisode => ({ source: "TMDB", season: 1, episode: number, providerEpisodeId: id, title, airDate, runtime });
const tvdb = (id: number, number: number, title: string | undefined, runtime?: number): ProviderEpisode => ({ source: "TVDB", season: 1, episode: number, providerEpisodeId: id, ...(title === undefined ? {} : { title }), airDate: "1995-01-16", ...(runtime ? { runtime } : {}) });
const member = (provider: CoverageProvider, id: number, reportMissing?: boolean) => ({ provider, id, showId: 1, show: "Show", title: `${provider} ${id}`, season: 1, episode: 1, url: "", ...(reportMissing ? { reportMissing } : {}) });
/** A Healthy Manual Match from `provider`/`id` to one directly owned member on the other side. */
const manualMatch = (provider: CoverageProvider, id: number, other: number, reportMissing?: boolean): CoverageMapping => ({ id: `${provider}-${id}`, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", members: [member(provider, id, reportMissing), member(provider === "TVDB" ? "TMDB" : "TVDB", other)] });
const owns = (provider: CoverageProvider, id: number): CoverageEvidence => ({ ratingKey: `item-${provider}-${id}`, showKey: "other-show", identities: [{ provider, id }] });

/** TMDB's combined "Caretaker" (900), owned in Plex, split by TVDB into parts on the same day. */
function input(tvdbParts: ProviderEpisode[], { combinedRuntime = 92, tmdbExtra = [tmdb(901, 4, "Parallax", "1995-01-23", 46)], ...overrides }: Partial<PlexComparisonInput> & { combinedRuntime?: number; tmdbExtra?: ProviderEpisode[] } = {}): PlexComparisonInput {
  return {
    ratingKey: "show", primary: { title: "Show" }, tmdbShow: { id: 10 }, tvdbId: 20, tmdbSeriesMatches: [],
    providerEpisodes: [tmdb(900, 1, "Caretaker", "1995-01-16", combinedRuntime), ...tmdbExtra, ...tvdbParts],
    localEpisodes: new Set(), localProviderEpisodes: [{ season: 1, episode: 1, title: "Caretaker", runtime: combinedRuntime, tmdbEpisodeId: 900 }],
    localTmdbEpisodeIds: new Set([900]), libraryTmdbEpisodeIds: new Set([900]),
    coordinateMissingTvdbIds: new Set(tvdbParts.map(part => part.providerEpisodeId!)), directTvdbSatisfied: new Set(),
    directImdbSatisfied: new Set(), traktSatisfied: new Set(), tmdbSatisfied: new Set(), autoMatchEvidence: new Map(),
    mappings: [], manualInventory: [], autoCompoundEpisodes: true, ...overrides,
  };
}
const twoParts = () => [tvdb(101, 1, "Caretaker (1)", 46), tvdb(102, 2, "Caretaker (2)", 46)];
const threeParts = (runtime?: number) => [tvdb(101, 1, "Caretaker (1)", runtime), tvdb(102, 2, "Caretaker (2)", runtime), tvdb(103, 3, "Caretaker (3)", runtime)];
const compound = (result: ReturnType<typeof comparePlexShow>) => result.compoundCoverage.map(item => item.tvdbEpisodeId).sort((a, b) => a - b);
const missing = (result: ReturnType<typeof comparePlexShow>) => result.missing.map(item => `${item.sources.join("+")}:${item.tmdbEpisodeId ?? item.tvdbEpisodeId}`);
const statusOf = (result: ReturnType<typeof comparePlexShow>, provider: CoverageProvider, id: number) => result.coverageOutcomes.find(outcome => outcome.provider === provider && outcome.id === id)?.status;
const compoundFailures = (result: ReturnType<typeof comparePlexShow>) => result.episodeFailures.filter(failure => failure.operation === "compound-matching")
  .map(failure => ({ anchor: `${failure.episode.provider}:${failure.episode.id}`, dependents: failure.dependents?.map(dependent => `${dependent.provider}:${dependent.id}`), ...(failure.existingOnly ? { existingOnly: failure.existingOnly } : {}) }));

test("without a Manual Match, the combined episode covers both split parts", () => {
  const result = comparePlexShow(input(twoParts()));
  assert.deepEqual(compound(result), [101, 102]);
  assert.deepEqual(missing(result), ["TMDB:901"]);
});

test("a covered part is not used to prove coverage for its uncovered sibling, which stays missing", () => {
  const result = comparePlexShow(input(twoParts(), { mappings: [manualMatch("TVDB", 101, 555)], manualInventory: [owns("TMDB", 555)] }));
  assert.equal(statusOf(result, "TVDB", 101), "manual");
  assert.deepEqual(result.manualCoverage.map(item => item.mappingId), ["TVDB-101"]);
  assert.deepEqual(compound(result), [], "no partial or guessed coverage");
  assert.deepEqual(missing(result), ["TVDB:102", "TMDB:901"]);
  assert.deepEqual(result.autoMatches, []);
});

test("an untitled covered part neither withholds the relationship nor proves coverage for its sibling", () => {
  const parts = [tvdb(101, 1, undefined, 46), tvdb(102, 2, "Caretaker (2)", 46)];
  const unmatched = comparePlexShow(input(parts));
  assert.deepEqual(compoundFailures(unmatched), [{ anchor: "TVDB:101", dependents: ["TVDB:102"] }], "without the Manual Match the untitled part withholds the relationship");

  const result = comparePlexShow(input(parts, { mappings: [manualMatch("TVDB", 101, 555)], manualInventory: [owns("TMDB", 555)] }));
  assert.equal(statusOf(result, "TVDB", 101), "manual");
  assert.deepEqual(compoundFailures(result), [], "the covered part is no relationship input, so it withholds nothing");
  assert.deepEqual(compound(result), []);
  assert.deepEqual(missing(result), ["TVDB:102", "TMDB:901"]);
});

test("an uncovered untitled part still withholds the relationship, with no covered part among its dependents", () => {
  const parts = [tvdb(101, 1, "Caretaker (1)", 46), tvdb(102, 2, undefined, 46)];
  const result = comparePlexShow(input(parts, { mappings: [manualMatch("TVDB", 101, 555)], manualInventory: [owns("TMDB", 555)] }));
  assert.equal(statusOf(result, "TVDB", 101), "manual");
  assert.deepEqual(compoundFailures(result), [{ anchor: "TVDB:102", dependents: [] }]);
  assert.deepEqual(compound(result), []);
  assert.deepEqual(missing(result), ["TVDB:102", "TMDB:901"]);
});

test("a covered TMDB combined-side episode is not the combined side of a relationship; its Plex item stays inventory", () => {
  const result = comparePlexShow(input(twoParts(), {
    mappings: [manualMatch("TMDB", 900, 777), manualMatch("TVDB", 300, 900)],
    manualInventory: [owns("TVDB", 777), owns("TMDB", 900)],
    providerEpisodes: [tmdb(900, 1, "Caretaker", "1995-01-16", 92), tmdb(901, 4, "Parallax", "1995-01-23", 46), ...twoParts(), { ...tvdb(300, 5, "Other", 46), airDate: "1995-02-01" }],
  }));
  assert.equal(statusOf(result, "TMDB", 900), "manual");
  assert.deepEqual(compound(result), [], "the parts are not covered through the covered combined episode");
  assert.deepEqual(missing(result), ["TVDB:101", "TVDB:102", "TMDB:901"]);
  assert.equal(statusOf(result, "TVDB", 300), "manual", "the directly owned TMDB item still covers another Manual Match");
  assert.deepEqual(result.autoMatches, []);
});

test("in a three-part relationship, a covered end part leaves the remaining parts to the existing rules", () => {
  const mappings = [manualMatch("TVDB", 103, 555)];
  const manualInventory = [owns("TMDB", 555)];
  // Double-length TMDB runtime evidence: the two remaining consecutive parts still meet it.
  const longCombined = { combinedRuntime: 138, tmdbExtra: [tmdb(901, 4, "Parallax", "1995-01-23", 46), tmdb(902, 5, "Time and Again", "1995-01-30", 46)], mappings, manualInventory };
  const byTmdbRuntime = comparePlexShow(input(threeParts(), longCombined));
  assert.equal(statusOf(byTmdbRuntime, "TVDB", 103), "manual");
  assert.deepEqual(compound(byTmdbRuntime), [101, 102]);
  assert.deepEqual(missing(byTmdbRuntime), ["TMDB:901", "TMDB:902"]);

  // Split-runtime total evidence: the remaining parts' total no longer matches, so nothing is guessed.
  const bySplitTotal = { combinedRuntime: 138, tmdbExtra: [], mappings, manualInventory };
  assert.deepEqual(compound(comparePlexShow(input(threeParts(46), { ...bySplitTotal, mappings: [] }))), [101, 102, 103], "all three parts match without the Manual Match");
  const withCovered = comparePlexShow(input(threeParts(46), bySplitTotal));
  assert.deepEqual(compound(withCovered), []);
  assert.deepEqual(missing(withCovered), ["TVDB:101", "TVDB:102"]);
});

test("in a three-part relationship, a covered middle part leaves non-consecutive parts uncovered", () => {
  const result = comparePlexShow(input(threeParts(), { combinedRuntime: 138, tmdbExtra: [tmdb(901, 4, "Parallax", "1995-01-23", 46), tmdb(902, 5, "Time and Again", "1995-01-30", 46)], mappings: [manualMatch("TVDB", 102, 555)], manualInventory: [owns("TMDB", 555)] }));
  assert.equal(statusOf(result, "TVDB", 102), "manual");
  assert.deepEqual(compound(result), []);
  assert.deepEqual(missing(result), ["TVDB:101", "TVDB:103", "TMDB:901", "TMDB:902"]);
});

test("covered TMDB episodes still count toward the show's typical runtime", () => {
  const tmdbExtra = [tmdb(901, 4, "Parallax", "1995-01-23", 46), tmdb(902, 5, "Time and Again", "1995-01-30", 46)];
  const result = comparePlexShow(input(threeParts(), { combinedRuntime: 138, tmdbExtra, mappings: [manualMatch("TMDB", 901, 801), manualMatch("TMDB", 902, 802)], manualInventory: [owns("TVDB", 801), owns("TVDB", 802)] }));
  assert.equal(statusOf(result, "TMDB", 901), "manual");
  assert.deepEqual(compound(result), [101, 102, 103], "the double-length threshold is unchanged");
  assert.deepEqual(missing(result), []);
});

test("Report Missing on a part outranks its Manual Match, so the part stays a relationship input", () => {
  const result = comparePlexShow(input(twoParts(), { mappings: [manualMatch("TVDB", 101, 555, true)], manualInventory: [owns("TMDB", 555)] }));
  assert.equal(statusOf(result, "TVDB", 101), "missing");
  assert.deepEqual(compound(result), [101, 102]);
  assert.deepEqual(missing(result), ["TVDB:101", "TMDB:901"]);
});

test("the pass forced by recorded compound causes leaves covered parts out too", () => {
  const forced = { coordinateMissingTvdbIds: new Set<number>(), compoundCausesRecorded: true };
  const coveredUntitled = [tvdb(101, 1, undefined, 46), tvdb(102, 2, "Caretaker (2)", 46)];
  assert.deepEqual(compoundFailures(comparePlexShow(input(coveredUntitled, forced))), [{ anchor: "TVDB:101", dependents: ["TVDB:102"], existingOnly: "refresh" }], "without the Manual Match the forced pass re-checks the relationship");
  const covered = comparePlexShow(input(coveredUntitled, { ...forced, mappings: [manualMatch("TVDB", 101, 555)], manualInventory: [owns("TMDB", 555)] }));
  assert.deepEqual(compoundFailures(covered), []);
  assert.deepEqual(compound(covered), []);

  const uncoveredUntitled = [tvdb(101, 1, "Caretaker (1)", 46), tvdb(102, 2, undefined, 46)];
  const result = comparePlexShow(input(uncoveredUntitled, { ...forced, mappings: [manualMatch("TVDB", 101, 555)], manualInventory: [owns("TMDB", 555)] }));
  assert.deepEqual(compoundFailures(result), [{ anchor: "TVDB:102", dependents: [], existingOnly: "refresh" }], "a relationship failure anchored on an uncovered part stays identifiable");
});

test("a failed Manual Match check leaves the part a relationship input", () => {
  const broken = { ...manualMatch("TVDB", 101, 555), get members(): never { throw new TypeError("unreadable Manual Match"); } } as CoverageMapping;
  const result = comparePlexShow(input(twoParts(), { mappings: [broken], manualInventory: [owns("TMDB", 555)] }));
  assert.deepEqual(compound(result), [101, 102]);
  assert.deepEqual(missing(result), ["TMDB:901"]);
});
