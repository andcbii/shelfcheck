import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { legacySavedComparisonEvidence } = await import("../lib/legacy-saved-comparison-evidence");
const { CrosswalkResponseError, SavedRelationshipUnavailableError } = await import("../lib/comparison-evidence");
const { getCoverageIssue, setCoverageIssue } = await import("../lib/coverage-issues");
hook.deregister();
import type { SharedCrosswalkRecord } from "../lib/tmdb-crosswalk-policy";

const NOW = "2026-11-12T10:00:00.000Z";
const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
/** Coverage Issues (the read port's store) in a temporary database, with a fixed clock. */
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"legacy-saved-evidence-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.mock.timers.enable({apis: ["Date"], now: Date.parse(NOW)});
  t.after(() => {
    global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir,{recursive:true,force:true});
  });
}

/** Today's relationship keys (Story 1 baseline), spelled out independently of the code. */
const keys = {
  tmdbCrosswalk303: "TMDB:https://api.themoviedb.org/3/find/303?external_source=tvdb_id",
  trakt303: "Trakt:https://api.trakt.tv/search/tvdb/303?type=episode",
  tvdbExtended303: "TVDB:https://api4.thetvdb.com/v4/episodes/303/extended",
  tmdbValidation: "TMDB:https://api.themoviedb.org/3/tv/10/season/2/episode/3",
  tmdbSeriesByTvdb20: "TMDB:https://api.themoviedb.org/3/find/20?external_source=tvdb_id",
  tmdbSummary10: "TMDB:https://api.themoviedb.org/3/tv/10",
  tmdbSummaryWithIds10: "TMDB:https://api.themoviedb.org/3/tv/10?append_to_response=external_ids",
  tvdbSummary20: "TVDB:https://api4.thetvdb.com/v4/series/20",
};
const issueId = (key: string) => `episode-identity:target:${key}`;
const MATCH = {tv_episode_results: [{id: 901, show_id: 10, season_number: 2, episode_number: 3}]};
const TRAKT = [{type: "episode", episode: {season: 2, number: 3, ids: {tvdb: 303, tmdb: 901}}, show: {ids: {tmdb: 10, tvdb: 20}}}];
const saved = (provider: string, value: unknown, receivedAt = "2026-11-01T00:00:00.000Z") => ({provider, value, receivedAt});

type Options = Parameters<typeof legacySavedComparisonEvidence>[0];
function source(options: Partial<Options> = {}) {
  return legacySavedComparisonEvidence({ratingKey: "target", relationships: {}, reuseImdbIds: true, shared: () => undefined, ...options});
}

test("a cached recheck answers every lookup kind from saved relationships and reports nothing missing", async t => {
  temporaryDatabase(t);
  const evidence = source({relationships: {
    [keys.tmdbCrosswalk303]: saved("TMDB", MATCH), [keys.trakt303]: saved("Trakt", TRAKT),
    [keys.tvdbExtended303]: saved("TVDB", {data: {remoteIds: [{id: "TT0303"}]}}), [keys.tmdbValidation]: saved("TMDB", {id: 901}),
    [keys.tmdbSeriesByTvdb20]: saved("TMDB", {tv_results: [{id: 10}]}), [keys.tmdbSummary10]: saved("TMDB", {id: 10, name: "Basic"}),
    [keys.tmdbSummaryWithIds10]: saved("TMDB", {id: 10, name: "With IDs"}), [keys.tvdbSummary20]: saved("TVDB", {data: {name: "Target", slug: "target"}}),
  }});
  assert.equal(evidence.traktAvailable, true);
  assert.deepEqual(await evidence.tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);
  assert.deepEqual(await evidence.traktEpisodeSearch(303), {results: TRAKT, cached: true});
  assert.deepEqual(await evidence.tmdbEpisodeDetails({tmdbShowId: 10, season: 2, episode: 3}, {tvdbEpisodeId: 303, tmdbEpisodeId: 901, cached: true}), {id: 901});
  assert.deepEqual([...await evidence.tvdbEpisodeExtended(303)], ["tt0303"]);
  assert.deepEqual(await evidence.tmdbSeriesByTvdb(20), [{id: 10}]);
  assert.deepEqual(await evidence.tmdbSeriesSummary(10), {id: 10, name: "Basic"});
  assert.deepEqual(await evidence.tmdbSeriesSummaryWithExternalIds(10), {id: 10, name: "With IDs"});
  assert.deepEqual(await evidence.tvdbSeriesSummary(20), {id: 20, name: "Target", slug: "target", year: undefined});
  assert.deepEqual(evidence.changes().tvdbEpisodeImdbIds, {"303": ["tt0303"]});
  assert.deepEqual(evidence.missing(), []);
});

test("a missing episode answer fails that episode only; a missing series answer is listed as missing saved input", async t => {
  temporaryDatabase(t);
  const evidence = source();
  for (const lookup of [evidence.tmdbEpisodeByTvdb(303), evidence.traktEpisodeSearch(303), evidence.tvdbEpisodeExtended(303),
    evidence.tmdbEpisodeDetails({tmdbShowId: 10, season: 2, episode: 3}, {tvdbEpisodeId: 303, tmdbEpisodeId: 901, cached: false})]) {
    await assert.rejects(lookup, SavedRelationshipUnavailableError);
  }
  assert.deepEqual(evidence.missing(), []);
  await assert.rejects(evidence.tmdbSeriesByTvdb(20), /Saved provider identity relationship is missing/);
  await assert.rejects(evidence.tmdbSeriesSummary(10));
  await assert.rejects(evidence.tmdbSeriesSummaryWithExternalIds(10));
  await assert.rejects(evidence.tvdbSeriesSummary(20));
  assert.deepEqual(evidence.missing(), [keys.tmdbSeriesByTvdb20, keys.tmdbSummary10, keys.tmdbSummaryWithIds10, keys.tvdbSummary20]);
});

test("a recorded failed request never stops the recheck reusing a saved answer, and it raises or resolves no issue", async t => {
  temporaryDatabase(t);
  setCoverageIssue({id: issueId(keys.trakt303), operation: "episode-identity", provider: "Trakt", scope: "episode", cause: "503", action: "Retry."});
  const evidence = source({relationships: {[keys.trakt303]: saved("Trakt", "not a list")}});
  await assert.rejects(evidence.traktEpisodeSearch(303), CrosswalkResponseError);
  assert.ok(getCoverageIssue(issueId(keys.trakt303)));
  assert.equal(source().traktAvailable, false);
});

test("a TMDB crosswalk missing after the show's failed request is recovered from newer shared evidence: saved first, then resolved", async t => {
  temporaryDatabase(t);
  setCoverageIssue({id: issueId(keys.tmdbCrosswalk303), operation: "episode-identity", provider: "TMDB", scope: "episode", cause: "503", action: "Retry.", failedAt: "2026-11-10T00:00:00.000Z"});
  const shared: SharedCrosswalkRecord = {value: MATCH, receivedAt: "2026-11-11T00:00:00.000Z"};
  const evidence = source({shared: id => id === 303 ? shared : undefined});
  assert.deepEqual(await evidence.tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);
  const copy = {provider: "TMDB", value: MATCH, receivedAt: "2026-11-11T00:00:00.000Z"};
  assert.deepEqual(evidence.changes().recovered, {relationships: {[keys.tmdbCrosswalk303]: copy}, resolves: [issueId(keys.tmdbCrosswalk303)]});
  assert.deepEqual(evidence.changes().relationships, {[keys.tmdbCrosswalk303]: copy});
  // The adapter only reports the recovery: the caller resolves the failed request once it is saved.
  assert.ok(getCoverageIssue(issueId(keys.tmdbCrosswalk303)));
});

test("a newer shared TMDB outcome replaces the saved copy in memory only; a rejection without a payload drops it", async t => {
  temporaryDatabase(t);
  const relationships = {[keys.tmdbCrosswalk303]: saved("TMDB", {tv_episode_results: []})};
  const replaced = source({relationships, shared: () => ({value: MATCH, receivedAt: "2026-11-11T00:00:00.000Z"})});
  assert.deepEqual(await replaced.tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);
  assert.deepEqual(replaced.changes().recovered, {relationships: {}, resolves: []});
  const dropped = source({relationships, shared: () => ({rejectedAt: "2026-11-11T00:00:00.000Z"})});
  await assert.rejects(dropped.tmdbEpisodeByTvdb(303), SavedRelationshipUnavailableError);
  assert.deepEqual(dropped.changes().relationships, {});
});

test("saved IMDb results are reused only while allowed; otherwise the saved extended record answers", async t => {
  temporaryDatabase(t);
  const relationships = {[keys.tvdbExtended303]: saved("TVDB", {data: {remoteIds: [{id: "tt0303"}]}})};
  const reused = source({relationships: {}, tvdbEpisodeImdbIds: {"303": ["tt9999"]}});
  assert.deepEqual([...await reused.tvdbEpisodeExtended(303)], ["tt9999"]);
  const reread = source({relationships, tvdbEpisodeImdbIds: {"303": ["tt9999"]}, reuseImdbIds: false});
  assert.deepEqual([...await reread.tvdbEpisodeExtended(303)], ["tt0303"]);
  assert.deepEqual(reread.changes().tvdbEpisodeImdbIds, {"303": ["tt0303"]});
});

test("an invalid identity is a rejected lookup, never a synchronous throw", async t => {
  temporaryDatabase(t);
  const evidence = source();
  await assert.rejects(evidence.tmdbEpisodeByTvdb(0), RangeError);
  await assert.rejects(evidence.tmdbSeriesSummary(-1), RangeError);
});
