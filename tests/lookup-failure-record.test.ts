import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { lookupFailureRecord } = await import("../lib/lookup-failure-record");
const { providerLookup } = await import("../lib/provider-lookup");
const { setCoverageIssue, resolveCoverageIssue } = await import("../lib/coverage-issues");
const { reconcileEpisodeCheckIssues } = await import("../lib/episode-check-issues");
hook.deregister();

const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"lookup-failure-record-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir,{recursive:true,force:true});
  });
}

/** Today's failed-request issue IDs (Story 1 baseline), spelled out independently of the code. */
const ids = {
  tmdbCrosswalk301: "episode-identity:42:TMDB:https://api.themoviedb.org/3/find/301?external_source=tvdb_id",
  traktCrosswalk301: "episode-identity:42:Trakt:https://api.trakt.tv/search/tvdb/301?type=episode",
  tvdbExtended301: "episode-identity:42:TVDB:https://api4.thetvdb.com/v4/episodes/301/extended",
  tmdbValidation: "episode-identity:42:TMDB:https://api.themoviedb.org/3/tv/10/season/1/episode/2",
};
const failedRequest = (id: string, failedAt?: string) => ({id, operation: "episode-identity", provider: "TMDB" as const, scope: "episode" as const, cause: "503 — TMDB request failed", action: "Retry.", ...(failedAt ? {failedAt} : {})});

test("a lookup with no failed-request issue has no recorded failure", t => {
  temporaryDatabase(t);
  assert.equal(lookupFailureRecord("42").failure(providerLookup.tmdbEpisodeByTvdbEpisode(301)), undefined);
});

test("an open failed-request issue reports its failure time", t => {
  temporaryDatabase(t);
  setCoverageIssue(failedRequest(ids.tmdbCrosswalk301, "2026-11-20T10:00:00.000Z"));
  assert.deepEqual(lookupFailureRecord("42").failure(providerLookup.tmdbEpisodeByTvdbEpisode(301)), {open: true, failedAt: "2026-11-20T10:00:00.000Z"});
});

test("an undated open failed-request issue is still open, distinct from no failure", t => {
  temporaryDatabase(t);
  setCoverageIssue(failedRequest(ids.tmdbCrosswalk301));
  const failure = lookupFailureRecord("42").failure(providerLookup.tmdbEpisodeByTvdbEpisode(301));
  assert.deepEqual(failure, {open: true});
  assert.equal(Object.hasOwn(failure!, "failedAt"), false);
});

test("a resolved failed-request issue is no longer recorded", t => {
  temporaryDatabase(t);
  setCoverageIssue(failedRequest(ids.tmdbCrosswalk301, "2026-11-20T10:00:00.000Z"));
  resolveCoverageIssue(ids.tmdbCrosswalk301);
  assert.equal(lookupFailureRecord("42").failure(providerLookup.tmdbEpisodeByTvdbEpisode(301)), undefined);
});

test("each lookup kind reads its own show's failed-request issue", t => {
  temporaryDatabase(t);
  setCoverageIssue(failedRequest(ids.traktCrosswalk301, "2026-11-20T10:00:00.000Z"));
  setCoverageIssue(failedRequest(ids.tvdbExtended301, "2026-11-20T11:00:00.000Z"));
  setCoverageIssue(failedRequest(ids.tmdbValidation, "2026-11-20T12:00:00.000Z"));
  const record = lookupFailureRecord("42");
  assert.deepEqual(record.failure(providerLookup.traktEpisodeSearchByTvdbEpisode(301)), {open: true, failedAt: "2026-11-20T10:00:00.000Z"});
  assert.deepEqual(record.failure(providerLookup.tvdbEpisodeExtended(301)), {open: true, failedAt: "2026-11-20T11:00:00.000Z"});
  assert.deepEqual(record.failure(providerLookup.tmdbEpisodeByShowSeasonEpisode(10, 1, 2)), {open: true, failedAt: "2026-11-20T12:00:00.000Z"});
  assert.equal(record.failure(providerLookup.tmdbEpisodeByTvdbEpisode(301)), undefined, "another lookup of the same episode");
  assert.equal(lookupFailureRecord("43").failure(providerLookup.traktEpisodeSearchByTvdbEpisode(301)), undefined, "another show");
});

test("the read port reports the show's recorded episode crosswalk failures, which keep their carry lifecycle", t => {
  temporaryDatabase(t);
  const show = {ratingKey: "42", title: "Target", tvdbId: 20};
  const episode = (id: number) => ({provider: "TVDB" as const, id, season: 1, episode: id - 300});
  reconcileEpisodeCheckIssues(show, [
    {operation: "episode-crosswalk", crosswalk: "TMDB", episode: episode(301), kind: "request-failed", reason: "the TMDB request failed."},
    {operation: "episode-crosswalk", crosswalk: "Trakt", episode: episode(302), kind: "unreadable-response", reason: "unreadable."},
  ]);
  reconcileEpisodeCheckIssues({ratingKey: "43"}, [{operation: "episode-crosswalk", crosswalk: "IMDb", episode: episode(303), kind: "exception", reason: "x"}]);
  const sorted = (items: {crosswalk: string; tvdbEpisodeId: number}[]) => [...items].sort((a, b) => a.tvdbEpisodeId - b.tvdbEpisodeId);
  assert.deepEqual(sorted(lookupFailureRecord("42").episodeCrosswalkFailures()), [{crosswalk: "TMDB", tvdbEpisodeId: 301}, {crosswalk: "Trakt", tvdbEpisodeId: 302}]);

  // Not looked up again: carried, so still recorded; the other was checked and passed.
  reconcileEpisodeCheckIssues(show, [{operation: "episode-crosswalk", crosswalk: "TMDB", episode: episode(301), kind: "exception", reason: "not checked again", existingOnly: "carry"}]);
  assert.deepEqual(lookupFailureRecord("42").episodeCrosswalkFailures(), [{crosswalk: "TMDB", tvdbEpisodeId: 301}]);

  // A carried record never raises one that was not recorded.
  reconcileEpisodeCheckIssues(show, [{operation: "episode-crosswalk", crosswalk: "IMDb", episode: episode(304), kind: "exception", reason: "not checked again", existingOnly: "carry"}]);
  assert.deepEqual(lookupFailureRecord("42").episodeCrosswalkFailures(), []);
});
