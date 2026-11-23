import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { lookupDiagnostics, traktLoginDiagnostics } = await import("../lib/lookup-diagnostics");
const { lookupFailureRecord } = await import("../lib/lookup-failure-record");
const { providerLookup } = await import("../lib/provider-lookup");
const { getCoverageIssue, listCoverageIssues } = await import("../lib/coverage-issues");
const { ProviderHttpError, ProviderNetworkError } = await import("../lib/provider-client");
hook.deregister();

const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"lookup-diagnostics-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.mock.timers.enable({apis: ["Date"], now: Date.parse("2026-11-12T10:00:00Z")});
  t.after(() => {
    global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir,{recursive:true,force:true});
  });
}

/** The stored JSON of one Coverage Issue, so key order is compared as well as values. */
function storedIssue(id: string) {
  const row = global.__shelfcheckDatabase!.prepare("SELECT payload FROM shelfcheck_coverage_issues WHERE id=?").get(id) as {payload: string} | undefined;
  return row?.payload;
}

/** Today's failed-request issue IDs (Story 1 baseline), spelled out independently of the code. */
const ids = {
  tmdbCrosswalk303: "episode-identity:ratingKey:target:TMDB:https://api.themoviedb.org/3/find/303?external_source=tvdb_id",
  tmdbAssociation20: "episode-identity:ratingKey:target:TMDB:https://api.themoviedb.org/3/find/20?external_source=tvdb_id",
  tmdbValidation: "episode-identity:ratingKey:target:TMDB:https://api.themoviedb.org/3/tv/10/season/1/episode/2",
  tvdbExtended303: "episode-identity:ratingKey:target:TVDB:https://api4.thetvdb.com/v4/episodes/303/extended",
  traktCrosswalk303: "episode-identity:ratingKey:target:Trakt:https://api.trakt.tv/search/tvdb/303?type=episode",
};

/** The comparison context a live scan supplies for the Target show. */
const target = {
  ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20,
  tvdbSource: [{provider: "Plex" as const, kind: "TVDB series", id: 20}],
  tvdbCached: false,
  providerEpisodes: [{source: "TVDB" as const, providerEpisodeId: 303, season: 2, episode: 3, title: "Three"}],
};
const impact = "Episode identity and coverage could not be fully verified. Available last-good results were retained.";
const showOf = {ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20};
const episode303 = {provider: "TVDB", id: 303, showId: 20, season: 2, episode: 3, title: "Three"};
const catalogueEpisode303 = [{provider: "Plex", kind: "TVDB series", id: 20}, {provider: "TVDB", kind: "catalogue episode", id: 303, cached: false}];
const notFound = {cause: "404 — record not found", action: "Check the recorded source reference; retry after checking or correcting the reference."};

test("a failed TMDB episode crosswalk raises its episode-scoped episode identity issue", t => {
  temporaryDatabase(t);
  lookupDiagnostics(target).raiseFailure(providerLookup.tmdbEpisodeByTvdbEpisode(303), new ProviderHttpError("TMDB", 404));
  assert.equal(storedIssue(ids.tmdbCrosswalk303), JSON.stringify({
    id: ids.tmdbCrosswalk303, failedAt: "2026-11-12T10:00:00.000Z",
    operation: "episode-identity", provider: "TMDB", scope: "episode", show: showOf, episode: episode303,
    category: "Provider Lookup",
    lookup: {source: catalogueEpisode303, requested: {provider: "TMDB", kind: "external ID search", id: 303}, impact, status: 404, failureKind: "http"},
    ...notFound,
  }));
});

test("a failed TMDB series association raises one show-scoped provider association issue", t => {
  temporaryDatabase(t);
  lookupDiagnostics(target).raiseFailure(providerLookup.tmdbSeriesByTvdbSeries(20), new ProviderHttpError("TMDB", 404));
  assert.equal(storedIssue(ids.tmdbAssociation20), JSON.stringify({
    id: ids.tmdbAssociation20, failedAt: "2026-11-12T10:00:00.000Z",
    operation: "provider-association", provider: "TMDB", scope: "show", show: showOf,
    category: "Provider Lookup",
    lookup: {source: [{provider: "Plex", kind: "TVDB series", id: 20}], requested: {provider: "TMDB", kind: "external ID search", id: 20}, impact, status: 404, failureKind: "http"},
    cause: "404 — record not found", action: "Check the Plex provider ID reference; retry after checking or correcting the reference.",
  }));
});

test("failed TVDB extended and Trakt search crosswalks raise episode identity issues for the TVDB episode", t => {
  temporaryDatabase(t);
  const diagnostics = lookupDiagnostics(target);
  diagnostics.raiseFailure(providerLookup.tvdbEpisodeExtended(303), new ProviderHttpError("TVDB", 503));
  diagnostics.raiseFailure(providerLookup.traktEpisodeSearchByTvdbEpisode(303), new ProviderNetworkError("Trakt"));
  assert.equal(storedIssue(ids.tvdbExtended303), JSON.stringify({
    id: ids.tvdbExtended303, failedAt: "2026-11-12T10:00:00.000Z",
    operation: "episode-identity", provider: "TVDB", scope: "episode", show: showOf, episode: episode303,
    category: "Provider Lookup",
    lookup: {source: catalogueEpisode303, requested: {provider: "TVDB", kind: "episode", id: 303}, impact, status: 503, failureKind: "http"},
    cause: "503 — TVDB request failed", action: "Retry the Plex scan after TVDB availability recovers.",
  }));
  assert.equal(storedIssue(ids.traktCrosswalk303), JSON.stringify({
    id: ids.traktCrosswalk303, failedAt: "2026-11-12T10:00:00.000Z",
    operation: "episode-identity", provider: "Trakt", scope: "episode", show: showOf, episode: episode303,
    category: "Provider Lookup",
    lookup: {source: catalogueEpisode303, requested: {provider: "Trakt", kind: "episode", id: 303}, impact, failureKind: "network"},
    cause: "Trakt network request failed", action: "Retry the Plex scan after Trakt availability recovers.",
  }));
});

test("a failed TMDB episode validation names the TMDB episode Trakt expected and its source chain", t => {
  temporaryDatabase(t);
  const lookupSource = [
    {provider: "Plex" as const, kind: "TVDB series", id: 20}, {provider: "TVDB" as const, kind: "catalogue episode", id: 302, cached: false},
    {provider: "Trakt" as const, kind: "external TMDB show ID", id: 10, cached: false}, {provider: "Trakt" as const, kind: "external TMDB episode ID", id: 9002, cached: false},
  ];
  lookupDiagnostics({...target, lookupSource}).raiseFailure(providerLookup.tmdbEpisodeByShowSeasonEpisode(10, 1, 2), new ProviderHttpError("TMDB", 404));
  assert.equal(storedIssue(ids.tmdbValidation), JSON.stringify({
    id: ids.tmdbValidation, failedAt: "2026-11-12T10:00:00.000Z",
    operation: "episode-identity", provider: "TMDB", scope: "episode", show: showOf,
    episode: {provider: "TMDB", id: 9002, showId: 10, season: 1, episode: 2},
    category: "Provider Lookup",
    lookup: {source: lookupSource, requested: {provider: "TMDB", kind: "show 10 season 1 episode", id: 2}, impact, status: 404, failureKind: "http"},
    cause: "404 — record not found", action: "Check the recorded source reference; retry after checking or correcting the reference.",
  }));
});

test("series summary failures raise no lookup issue", t => {
  temporaryDatabase(t);
  const diagnostics = lookupDiagnostics(target);
  for (const lookup of [providerLookup.tmdbSeriesSummary(10), providerLookup.tmdbSeriesSummaryWithExternalIds(10), providerLookup.tvdbSeriesSummary(20)]) {
    diagnostics.raiseFailure(lookup, new ProviderHttpError(lookup.kind === "tvdb-series-summary" ? "TVDB" : "TMDB", 404));
  }
  assert.deepEqual(listCoverageIssues(), []);
});

test("a TVDB lookup that failed because of TVDB authentication links to the authentication issue", t => {
  temporaryDatabase(t);
  const authentication = new ProviderHttpError("TVDB", 401);
  const diagnostics = lookupDiagnostics({...target, tvdbAuthenticationError: authentication});
  diagnostics.raiseFailure(providerLookup.tvdbEpisodeExtended(303), authentication);
  assert.deepEqual(Object.keys(JSON.parse(storedIssue(ids.tvdbExtended303)!)).slice(0, 4), ["id", "failedAt", "causedBy", "operation"]);
  assert.deepEqual(getCoverageIssue(ids.tvdbExtended303)?.causedBy, ["provider-authentication:TVDB"]);

  diagnostics.raiseFailure(providerLookup.tvdbEpisodeExtended(303), new ProviderHttpError("TVDB", 503));
  assert.equal(getCoverageIssue(ids.tvdbExtended303)?.causedBy, undefined, "another TVDB failure has no authentication cause");
  diagnostics.raiseFailure(providerLookup.tmdbEpisodeByTvdbEpisode(303), authentication);
  assert.equal(getCoverageIssue(ids.tmdbCrosswalk303)?.causedBy, undefined, "only TVDB lookups depend on TVDB authentication");
});

test("a successful response resolves its lookup's failed request, which the read port then no longer reports", t => {
  temporaryDatabase(t);
  const diagnostics = lookupDiagnostics(target);
  const lookup = providerLookup.tmdbEpisodeByTvdbEpisode(303);
  diagnostics.raiseFailure(lookup, new ProviderHttpError("TMDB", 503));
  assert.deepEqual(lookupFailureRecord("ratingKey:target").failure(lookup), {open: true, failedAt: "2026-11-12T10:00:00.000Z"});
  // Resolving does not depend on the answer: an unreadable answer is recorded separately, as an episode failure.
  diagnostics.resolve(lookup);
  assert.equal(lookupFailureRecord("ratingKey:target").failure(lookup), undefined);
  assert.deepEqual(listCoverageIssues(), []);
});

test("resolving a lookup leaves other shows' and other lookups' failed requests open", t => {
  temporaryDatabase(t);
  lookupDiagnostics(target).raiseFailure(providerLookup.tvdbEpisodeExtended(303), new ProviderHttpError("TVDB", 503));
  lookupDiagnostics({ratingKey: "ratingKey:other"}).raiseFailure(providerLookup.tmdbEpisodeByTvdbEpisode(303), new ProviderHttpError("TMDB", 503));
  lookupDiagnostics(target).resolve(providerLookup.tmdbEpisodeByTvdbEpisode(303));
  assert.deepEqual(listCoverageIssues().map(issue => issue.id).sort(), ["episode-identity:ratingKey:other:TMDB:https://api.themoviedb.org/3/find/303?external_source=tvdb_id", ids.tvdbExtended303]);
});

test("an unrecoverable Trakt login is one library issue, resolved when Trakt answers again", t => {
  temporaryDatabase(t);
  traktLoginDiagnostics.raiseFailure(new ProviderHttpError("Trakt", 401));
  traktLoginDiagnostics.raiseFailure(new ProviderHttpError("Trakt", 401));
  assert.deepEqual(listCoverageIssues(), [{
    id: "provider-authentication:Trakt", operation: "provider-authentication", provider: "Trakt", scope: "library", category: "Provider Lookup",
    lookup: {source: [], requested: {provider: "Trakt", kind: "authentication"}, impact: "Trakt episode identity checks could not be verified. TMDB fallback checks remain available.", status: 401, failureKind: "http"},
    cause: "401 — Trakt request failed", action: "Check Trakt credentials or permissions, then retry the Plex scan.",
  }]);
  traktLoginDiagnostics.resolve();
  assert.deepEqual(listCoverageIssues(), []);
});
