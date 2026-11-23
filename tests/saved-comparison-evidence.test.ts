import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { savedComparisonEvidence } = await import("../lib/saved-comparison-evidence");
const { CrosswalkResponseError, SavedRelationshipUnavailableError } = await import("../lib/comparison-evidence");
const { saveRecoveredTmdbCrosswalks } = await import("../lib/tmdb-crosswalk-coordinator");
hook.deregister();
import { inMemoryLookupIssues } from "./in-memory-lookup-issues";
import { providerLookup } from "../lib/provider-lookup";
import type { SharedCrosswalkRecord } from "../lib/tmdb-crosswalk-policy";

/** The stored relationship keys (lookup keys), spelled out independently of the code. */
const keys = {
  tmdbCrosswalk303: "tmdb-episode-by-tvdb:303",
  trakt303: "trakt-episode-by-tvdb:303",
  tvdbExtended303: "tvdb-episode-extended:303",
  tmdbValidation: "tmdb-episode:10:2:3",
  tmdbSeriesByTvdb20: "tmdb-series-by-tvdb:20",
  tmdbSeriesByTvdb21: "tmdb-series-by-tvdb:21",
  tmdbSummary10: "tmdb-series:10:summary",
  tmdbSummary11: "tmdb-series:11:summary",
  tmdbSummaryWithIds10: "tmdb-series:10:external-ids",
  tvdbSummary20: "tvdb-series:20",
};
const issueId = (key: string) => `episode-identity:target:${key}`;
const MATCH = {tv_episode_results: [{id: 901, show_id: 10, season_number: 2, episode_number: 3}]};
const OTHER_MATCH = {tv_episode_results: [{id: 902, show_id: 10, season_number: 2, episode_number: 4}]};
const TRAKT = [{type: "episode", episode: {season: 2, number: 3, ids: {tvdb: 303, tmdb: 901}}, show: {ids: {tmdb: 10, tvdb: 20}}}];
const saved = (provider: string, value: unknown, receivedAt?: string) => ({provider, value, ...(receivedAt ? {receivedAt} : {})});
const validation = () => providerLookup.tmdbEpisodeByShowSeasonEpisode(10, 2, 3);
/** Plex's show-level series IDs, as the saved comparison's details report them. */
const plexSeries = (...ids: string[]) => [{Guid: ids.map(id => ({id}))}];
const catalogue = (id: number, name: string, downloadedAt = "2026-11-05T00:00:00.000Z") => ({version: 1 as const, downloadedAt, show: {id, name}, episodes: []});

type Options = Parameters<typeof savedComparisonEvidence>[0];
function source({comparison, ...options}: Partial<Omit<Options, "comparison">> & {comparison?: Partial<Options["comparison"]>} = {}) {
  return savedComparisonEvidence({
    ratingKey: "target", comparison: {details: [], relationships: {}, tvdbId: 20, ...comparison},
    tmdbCatalogues: {}, compares: {tmdb: true, tvdb: true}, shared: () => undefined, failures: inMemoryLookupIssues().failures, ...options,
  });
}

test("a cached recheck answers every lookup kind from the saved comparison without reaching any transport", async (t) => {
  const fetched = t.mock.method(globalThis, "fetch", async () => { throw new Error("no request may be made"); });
  const evidence = source({comparison: {relationships: {
    [keys.tmdbCrosswalk303]: saved("TMDB", MATCH), [keys.trakt303]: saved("Trakt", TRAKT),
    [keys.tvdbExtended303]: saved("TVDB", {data: {remoteIds: [{id: "TT0303"}]}}), [keys.tmdbValidation]: saved("TMDB", {id: 901}),
    [keys.tmdbSeriesByTvdb20]: saved("TMDB", {tv_results: [{id: 10}]}), [keys.tmdbSummary10]: saved("TMDB", {id: 10, name: "Basic"}),
    [keys.tmdbSummaryWithIds10]: saved("TMDB", {id: 10, name: "With IDs"}), [keys.tvdbSummary20]: saved("TVDB", {data: {name: "Target", slug: "target"}}),
  }}});
  assert.deepEqual(await evidence.tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);
  assert.deepEqual(await evidence.traktEpisodeSearch(303), {results: TRAKT, cached: true});
  assert.deepEqual(await evidence.tmdbEpisodeDetails(validation(), {tvdbEpisodeId: 303, tmdbEpisodeId: 901, cached: true}), {id: 901});
  assert.deepEqual([...await evidence.tvdbEpisodeExtended(303)], ["tt0303"]);
  assert.deepEqual(await evidence.tmdbSeriesByTvdb(20), [{id: 10}]);
  assert.deepEqual(await evidence.tmdbSeriesSummary(10), {id: 10, name: "Basic"});
  assert.deepEqual(await evidence.tmdbSeriesSummaryWithExternalIds(10), {id: 10, name: "With IDs"});
  assert.deepEqual(await evidence.tvdbSeriesSummary(20), {id: 20, name: "Target", slug: "target", year: undefined});
  assert.deepEqual(evidence.changes().tvdbEpisodeImdbIds, {"303": ["tt0303"]});
  assert.deepEqual(evidence.missing(), []);
  assert.equal(fetched.mock.callCount(), 0);
  // Nothing the saved source is built from or imports can send a request.
  const code = readFileSync(new URL("../lib/saved-comparison-evidence.ts", import.meta.url), "utf8");
  assert.doesNotMatch(code, /provider-client|scan-provider-client|LookupTransport|LiveEvidenceScan|transport/i);
});

test("a missing episode answer fails that episode only; a missing series answer is a typed unavailable error listed as missing show input", async () => {
  const evidence = source();
  for (const [provider, lookup] of [["TMDB", evidence.tmdbEpisodeByTvdb(303)], ["Trakt", evidence.traktEpisodeSearch(303)], ["TVDB", evidence.tvdbEpisodeExtended(303)],
    ["TMDB", evidence.tmdbEpisodeDetails(validation(), {tvdbEpisodeId: 303, tmdbEpisodeId: 901, cached: false})]] as const) {
    await assert.rejects(lookup, error => error instanceof SavedRelationshipUnavailableError
      && error.message === `The saved ${provider} response for this episode is not available to the offline recheck; no request was made.`);
  }
  assert.deepEqual(evidence.missing(), []);
  for (const [provider, lookup] of [["TMDB", evidence.tmdbSeriesByTvdb(20)], ["TMDB", evidence.tmdbSeriesSummary(10)],
    ["TMDB", evidence.tmdbSeriesSummaryWithExternalIds(10)], ["TVDB", evidence.tvdbSeriesSummary(20)]] as const) {
    await assert.rejects(lookup, error => error instanceof SavedRelationshipUnavailableError
      && error.message === `The saved ${provider} response for this series is not available to the offline recheck; no request was made.`);
  }
  assert.deepEqual(evidence.missing(), [keys.tmdbSeriesByTvdb20, keys.tmdbSummary10, keys.tmdbSummaryWithIds10, keys.tvdbSummary20]);
});

test("series summaries are synthesized with today's precedence: saved answer, then saved catalogue summary, then failed-provider placeholder", async () => {
  const details = plexSeries("tmdb://10", "tmdb://11", "tmdb://12", "tvdb://20");
  const tmdbCatalogues = {"10": catalogue(10, "Catalogue 10"), "11": catalogue(11, "Catalogue 11"), "12": {...catalogue(12, "Unusable"), downloadedAt: "never"}};
  // Both providers compared: no placeholders, so a series with neither saved answer nor usable catalogue is missing.
  const compared = source({comparison: {details, relationships: {[keys.tmdbSummary10]: saved("TMDB", {id: 10, name: "Saved 10"})}}, tmdbCatalogues});
  assert.deepEqual(await compared.tmdbSeriesSummary(10), {id: 10, name: "Saved 10"});
  assert.deepEqual(await compared.tmdbSeriesSummary(11), {id: 11, name: "Catalogue 11"});
  await assert.rejects(compared.tmdbSeriesSummary(12), SavedRelationshipUnavailableError);
  await assert.rejects(compared.tvdbSeriesSummary(20), SavedRelationshipUnavailableError);
  // A catalogue summary answers only the basic summary, and only for a series Plex reports.
  await assert.rejects(compared.tmdbSeriesSummaryWithExternalIds(11), SavedRelationshipUnavailableError);
  const unreported = source({tmdbCatalogues: {"11": catalogue(11, "Catalogue 11")}});
  await assert.rejects(unreported.tmdbSeriesSummary(11), SavedRelationshipUnavailableError);

  // A provider the last scan could not load: its Plex-reported series find no series (TMDB null, TVDB empty object).
  const failed = source({comparison: {details}, tmdbCatalogues, compares: {tmdb: false, tvdb: false}});
  assert.deepEqual(await failed.tmdbSeriesSummary(11), {id: 11, name: "Catalogue 11"});
  assert.equal(await failed.tmdbSeriesSummary(12), undefined);
  assert.equal(await failed.tvdbSeriesSummary(20), null);
  assert.deepEqual(failed.missing(), []);
  // Each placeholder is gated by its own provider.
  const tmdbOnly = source({comparison: {details}, compares: {tmdb: false, tvdb: true}});
  assert.equal(await tmdbOnly.tmdbSeriesSummary(12), undefined);
  await assert.rejects(tmdbOnly.tvdbSeriesSummary(20), SavedRelationshipUnavailableError);

  // Synthesized answers are never saved as newly received evidence.
  assert.deepEqual(failed.changes().relationships, {});
  assert.deepEqual(failed.changes().recovered, {relationships: {}, resolves: []});
  assert.deepEqual(compared.changes().relationships, {[keys.tmdbSummary10]: saved("TMDB", {id: 10, name: "Saved 10"})});
});

test("Trakt is available only when the saved comparison holds its own Trakt relationship", async () => {
  assert.equal(source({comparison: {relationships: {[keys.trakt303]: saved("Trakt", [])}}}).traktAvailable, true);
  assert.equal(source({comparison: {details: plexSeries("tmdb://10")}, tmdbCatalogues: {"10": catalogue(10, "Catalogue")}, compares: {tmdb: false, tvdb: false}}).traktAvailable, false);
  assert.equal(source({comparison: {relationships: {[keys.tmdbCrosswalk303]: saved("TMDB", MATCH)}}}).traktAvailable, false);
});

test("an alternative TVDB candidate's saved series association answers once the recheck switches to it", async () => {
  const evidence = source({comparison: {tvdbId: 21, relationships: {
    [keys.tmdbSeriesByTvdb20]: saved("TMDB", {tv_results: [{id: 10}]}), [keys.tmdbSeriesByTvdb21]: saved("TMDB", {tv_results: [{id: 11}]}),
  }}});
  assert.deepEqual(await evidence.tmdbSeriesByTvdb(21), [{id: 11}]);
  assert.deepEqual(Object.keys(evidence.changes().relationships).sort(), [keys.tmdbSeriesByTvdb20, keys.tmdbSeriesByTvdb21]);
});

test("a recorded failed request never stops the recheck reusing a saved answer", async () => {
  const issues = inMemoryLookupIssues();
  issues.open.set(keys.trakt303, {});
  const evidence = source({failures: issues.failures, comparison: {relationships: {[keys.trakt303]: saved("Trakt", "not a list")}}});
  await assert.rejects(evidence.traktEpisodeSearch(303), CrosswalkResponseError);
});

test("a TMDB crosswalk missing after the show's failed request is recovered from a strictly newer shared answer, with its original receipt time", async () => {
  const shared: SharedCrosswalkRecord = {value: MATCH, receivedAt: "2026-11-11T00:00:00.000Z"};
  const failedAt = (at?: string) => {
    const issues = inMemoryLookupIssues();
    issues.open.set(keys.tmdbCrosswalk303, at === undefined ? {} : {failedAt: at});
    return source({failures: issues.failures, shared: id => id === 303 ? shared : undefined});
  };
  const recovered = failedAt("2026-11-10T00:00:00.000Z");
  assert.deepEqual(await recovered.tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);
  const copy = {provider: "TMDB", value: MATCH, receivedAt: "2026-11-11T00:00:00.000Z"};
  assert.deepEqual(recovered.changes().recovered, {relationships: {[keys.tmdbCrosswalk303]: copy}, resolves: [issueId(keys.tmdbCrosswalk303)]});
  // Equal times, an undated failure, or no failure at all never recover.
  for (const evidence of [failedAt("2026-11-11T00:00:00.000Z"), failedAt(undefined), source({shared: () => shared})]) {
    await assert.rejects(evidence.tmdbEpisodeByTvdb(303), SavedRelationshipUnavailableError);
    assert.deepEqual(evidence.changes().recovered, {relationships: {}, resolves: []});
  }
});

test("the recheck saves a recovery before resolving its failed request; a failed save leaves the issue open", async () => {
  const issues = inMemoryLookupIssues();
  issues.open.set(keys.tmdbCrosswalk303, {failedAt: "2026-11-10T00:00:00.000Z"});
  const evidence = source({failures: issues.failures, shared: () => ({value: MATCH, receivedAt: "2026-11-11T00:00:00.000Z"})});
  await evidence.tmdbEpisodeByTvdb(303);
  const steps: string[] = [];
  saveRecoveredTmdbCrosswalks(evidence.changes().recovered, {save: copies => steps.push(`save ${Object.keys(copies)}`), resolveFailedRequest: id => steps.push(`resolve ${id}`)});
  assert.deepEqual(steps, [`save ${keys.tmdbCrosswalk303}`, `resolve ${issueId(keys.tmdbCrosswalk303)}`]);
  const resolved: string[] = [];
  assert.throws(() => saveRecoveredTmdbCrosswalks(evidence.changes().recovered, {save: () => { throw new Error("disk full"); }, resolveFailedRequest: id => resolved.push(id)}), /disk full/);
  assert.deepEqual(resolved, []);
});

test("a newer shared outcome replaces the saved copy in memory only; equal times keep the copy; an undated copy loses", async () => {
  const copyAt = (receivedAt?: string) => ({[keys.tmdbCrosswalk303]: saved("TMDB", OTHER_MATCH, receivedAt)});
  const newer: SharedCrosswalkRecord = {value: MATCH, receivedAt: "2026-11-11T00:00:00.000Z"};
  const replaced = source({comparison: {relationships: copyAt("2026-11-01T00:00:00.000Z")}, shared: () => newer});
  assert.deepEqual(await replaced.tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);
  // The replacement keeps the shared answer's own receipt time and is not a recovery to save.
  assert.deepEqual(replaced.changes().relationships, {[keys.tmdbCrosswalk303]: saved("TMDB", MATCH, "2026-11-11T00:00:00.000Z")});
  assert.deepEqual(replaced.changes().recovered, {relationships: {}, resolves: []});

  const equal = source({comparison: {relationships: copyAt("2026-11-11T00:00:00.000Z")}, shared: () => newer});
  assert.deepEqual(await equal.tmdbEpisodeByTvdb(303), OTHER_MATCH.tv_episode_results);
  assert.deepEqual(equal.changes().relationships, copyAt("2026-11-11T00:00:00.000Z"));

  const undated = source({comparison: {relationships: copyAt()}, shared: () => newer});
  assert.deepEqual(await undated.tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);

  const rejected = source({comparison: {relationships: copyAt("2026-11-01T00:00:00.000Z")}, shared: () => ({rejectedAt: "2026-11-11T00:00:00.000Z"})});
  await assert.rejects(rejected.tmdbEpisodeByTvdb(303), SavedRelationshipUnavailableError);
  assert.deepEqual(rejected.changes().relationships, {});
  const olderRejection = source({comparison: {relationships: copyAt("2026-11-11T00:00:00.000Z")}, shared: () => ({rejectedAt: "2026-11-01T00:00:00.000Z"})});
  assert.deepEqual(await olderRejection.tmdbEpisodeByTvdb(303), OTHER_MATCH.tv_episode_results);
});

test("saved IMDb results are reused only for a show with a TVDB series; otherwise the saved extended record answers", async () => {
  const relationships = {[keys.tvdbExtended303]: saved("TVDB", {data: {remoteIds: [{id: "tt0303"}]}})};
  const reused = source({comparison: {tvdbEpisodeImdbIds: {"303": ["tt9999"]}}});
  assert.deepEqual([...await reused.tvdbEpisodeExtended(303)], ["tt9999"]);
  const reread = source({comparison: {relationships, tvdbEpisodeImdbIds: {"303": ["tt9999"]}, tvdbId: undefined}});
  assert.deepEqual([...await reread.tvdbEpisodeExtended(303)], ["tt0303"]);
  assert.deepEqual(reread.changes().tvdbEpisodeImdbIds, {"303": ["tt0303"]});
});

test("an invalid identity is a rejected lookup, never a synchronous throw", async () => {
  const evidence = source();
  await assert.rejects(evidence.tmdbEpisodeByTvdb(0), RangeError);
  await assert.rejects(evidence.tmdbSeriesSummary(-1), RangeError);
});
