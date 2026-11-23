import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { liveComparisonEvidence, CrosswalkResponseError, TraktLoginUnavailableError } = await import("../lib/comparison-evidence");
const { tmdbCrosswalkScanRun } = await import("../lib/tmdb-crosswalk-coordinator");
const { getCoverageIssue, listCoverageIssues, setCoverageIssue } = await import("../lib/coverage-issues");
const { reconcileEpisodeCheckIssues } = await import("../lib/episode-check-issues");
const { ProviderHttpError } = await import("../lib/provider-client");
hook.deregister();
import type { ComparisonEvidence, SeriesEvidence } from "../lib/comparison-evidence";
import type { ProviderLookup } from "../lib/provider-lookup";
import type { SharedCrosswalkRecord } from "../lib/tmdb-crosswalk-policy";

const SCAN_STARTED = "2026-11-12T09:00:00.000Z";
const NOW = "2026-11-12T10:00:00.000Z";

const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
/** Coverage Issues (the read port's and the diagnostics' store) in a temporary database, with a fixed clock. */
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"comparison-evidence-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.mock.timers.enable({apis: ["Date"], now: Date.parse(NOW)});
  t.after(() => {
    global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir,{recursive:true,force:true});
  });
}

/** Today's relationship keys and failed-request issue IDs (Story 1 baseline), spelled out independently of the code. */
const keys = {
  tmdbCrosswalk303: "TMDB:https://api.themoviedb.org/3/find/303?external_source=tvdb_id",
  trakt303: "Trakt:https://api.trakt.tv/search/tvdb/303?type=episode",
  tvdbExtended303: "TVDB:https://api4.thetvdb.com/v4/episodes/303/extended",
  tmdbValidation: "TMDB:https://api.themoviedb.org/3/tv/10/season/2/episode/3",
};
const issueId = (ratingKey: string, key: string) => `episode-identity:${ratingKey}:${key}`;

/** Shared crosswalk evidence held in memory. */
function inMemoryStore() {
  const records = new Map<number, SharedCrosswalkRecord>();
  return {records, store: {read: (id: number) => records.get(id), save: (id: number, record: SharedCrosswalkRecord) => { records.set(id, record); }}};
}

/** A fake provider transport: each lookup kind is answered by a test-supplied responder; every request is counted. */
function fakeTransport(answer: (lookup: ProviderLookup) => unknown | Promise<unknown>) {
  const sent: ProviderLookup[] = [];
  return {
    sent,
    count: (kind: ProviderLookup["kind"]) => sent.filter(lookup => lookup.kind === kind).length,
    transport: async (lookup: ProviderLookup) => { sent.push(lookup); return answer(lookup); },
  };
}

const noSeries: SeriesEvidence = {
  tmdbSeriesByTvdb: async () => { throw new Error("not used"); },
  tmdbSeriesSummary: async () => { throw new Error("not used"); },
  tmdbSeriesSummaryWithExternalIds: async () => { throw new Error("not used"); },
  tvdbSeriesSummary: async () => { throw new Error("not used"); },
};

const target = {
  ratingKey: "target", title: "Target", tmdbId: 10, tvdbId: 20,
  tvdbSource: [{provider: "Plex" as const, kind: "TVDB series", id: 20}], tvdbCached: false,
  providerEpisodes: [{source: "TVDB" as const, providerEpisodeId: 303, season: 2, episode: 3, title: "Three", showTitle: "Target"}],
};
const other = {...target, ratingKey: "other", title: "Other"};

type Scan = Parameters<typeof liveComparisonEvidence>[0]["scan"];
function liveScan(transport: Scan["transport"], options: {traktLogin?: boolean; store?: ReturnType<typeof inMemoryStore>["store"]} = {}): Scan {
  return {transport, crosswalks: tmdbCrosswalkScanRun({store: options.store || inMemoryStore().store, now: () => NOW, startedAt: SCAN_STARTED}), traktLogin: options.traktLogin ?? true, now: () => NOW};
}
function source(scan: Scan, options: {show?: typeof target & {tvdbAuthenticationError?: unknown}; relationships?: Record<string, {provider: string; value: unknown; receivedAt?: string}>; imdb?: Record<string, string[]>; reuseImdbIds?: boolean; forced?: boolean; series?: SeriesEvidence} = {}): ComparisonEvidence {
  return liveComparisonEvidence({
    scan, show: options.show || target, forced: options.forced ?? false, series: options.series || noSeries,
    saved: {relationships: options.relationships || {}, tvdbEpisodeImdbIds: options.imdb, reuseImdbIds: options.reuseImdbIds ?? true},
  });
}

/** A request the test settles by hand. */
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

const MATCH = {tv_episode_results: [{id: 901, show_id: 10, season_number: 2, episode_number: 3}]};

test("overlapping comparisons in one scan run send one TMDB crosswalk request and each keeps the same evidence", async t => {
  temporaryDatabase(t);
  const {store, records} = inMemoryStore();
  const answer = deferred();
  const provider = fakeTransport(() => answer.promise);
  const scan = liveScan(provider.transport, {store});
  const first = source(scan), second = source(scan, {show: other});
  const looked = Promise.all([first.tmdbEpisodeByTvdb(303), second.tmdbEpisodeByTvdb(303)]);
  await new Promise(setImmediate);
  answer.resolve(MATCH);
  // Relationship evidence only: the source names the TMDB episode whether or not the library owns it.
  assert.deepEqual(await looked, [MATCH.tv_episode_results, MATCH.tv_episode_results]);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 1);
  assert.deepEqual(records.get(303), {value: MATCH, receivedAt: NOW});
  for (const evidence of [first, second]) assert.deepEqual(evidence.changes().relationships, {[keys.tmdbCrosswalk303]: {provider: "TMDB", value: MATCH, receivedAt: NOW}});
});

test("the scan run's coordinator is shared by every source: a forced comparison accepts this scan's answer, another scan run requests again", async t => {
  temporaryDatabase(t);
  const {store} = inMemoryStore();
  const provider = fakeTransport(() => MATCH);
  const scan = liveScan(provider.transport, {store});
  await source(scan).tmdbEpisodeByTvdb(303);
  assert.deepEqual(await source(scan, {show: other, forced: true}).tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 1);
  await source(liveScan(provider.transport, {store}), {forced: true}).tmdbEpisodeByTvdb(303);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 2);
});

test("a failed in-flight crosswalk fails every waiting comparison with its own failed-request issue, and a later comparison requests again", async t => {
  temporaryDatabase(t);
  const answers = [deferred(), deferred()];
  const provider = fakeTransport(() => answers[provider.sent.length - 1].promise);
  const scan = liveScan(provider.transport);
  const waiting = [source(scan).tmdbEpisodeByTvdb(303), source(scan, {show: other}).tmdbEpisodeByTvdb(303)];
  await new Promise(setImmediate);
  const failure = new ProviderHttpError("TMDB", 503);
  answers[0].reject(failure);
  for (const outcome of await Promise.allSettled(waiting)) assert.deepEqual(outcome, {status: "rejected", reason: failure});
  assert.equal(getCoverageIssue(issueId("target", keys.tmdbCrosswalk303))?.failedAt, NOW);
  assert.equal(getCoverageIssue(issueId("other", keys.tmdbCrosswalk303))?.failedAt, NOW);

  const later = source(scan).tmdbEpisodeByTvdb(303);
  await new Promise(setImmediate);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 2);
  answers[1].resolve(MATCH);
  assert.deepEqual(await later, MATCH.tv_episode_results);
  assert.equal(getCoverageIssue(issueId("target", keys.tmdbCrosswalk303)), undefined, "the answer resolves this show's failed request");
  assert.ok(getCoverageIssue(issueId("other", keys.tmdbCrosswalk303)), "another show's failed request stays until its own lookup succeeds");
});

test("an empty answer is a success: no failure is raised and the empty evidence is kept", async t => {
  temporaryDatabase(t);
  const provider = fakeTransport(lookup => lookup.kind === "trakt-episode-search-by-tvdb-episode" ? [] : {tv_episode_results: []});
  const evidence = source(liveScan(provider.transport));
  assert.deepEqual(await evidence.tmdbEpisodeByTvdb(303), []);
  assert.deepEqual(await evidence.traktEpisodeSearch(303), {results: [], cached: false});
  assert.deepEqual(listCoverageIssues(), []);
  assert.deepEqual(evidence.changes().relationships[keys.trakt303], {provider: "Trakt", value: [], receivedAt: NOW});
});

test("an unreadable successful answer throws an unreadable-response error after resolving the failed request", async t => {
  temporaryDatabase(t);
  setCoverageIssue({id: issueId("target", keys.tmdbCrosswalk303), operation: "episode-identity", provider: "TMDB", scope: "episode", cause: "503", action: "Retry.", failedAt: "2026-11-11T10:00:00.000Z"});
  setCoverageIssue({id: issueId("target", keys.trakt303), operation: "episode-identity", provider: "Trakt", scope: "episode", cause: "503", action: "Retry."});
  const provider = fakeTransport(lookup => lookup.kind === "tmdb-episode-by-tvdb-episode" ? {tv_episode_results: "no"} : lookup.kind === "trakt-episode-search-by-tvdb-episode" ? {} : {data: {remoteIds: "no"}});
  const evidence = source(liveScan(provider.transport));
  await assert.rejects(evidence.tmdbEpisodeByTvdb(303), CrosswalkResponseError);
  await assert.rejects(evidence.traktEpisodeSearch(303), CrosswalkResponseError);
  await assert.rejects(evidence.tvdbEpisodeExtended(303), CrosswalkResponseError);
  assert.deepEqual(listCoverageIssues(), []);
  // The unreadable crosswalk answer is kept only to explain the failure: it has no receipt time.
  assert.deepEqual(evidence.changes().relationships[keys.tmdbCrosswalk303], {provider: "TMDB", value: {tv_episode_results: "no"}});
});

test("a saved answer is reused without a request while no failed request is recorded for it, and requested again when one is", async t => {
  temporaryDatabase(t);
  const saved = [{type: "episode", episode: {season: 2, number: 3}}];
  const provider = fakeTransport(() => [{type: "episode"}]);
  const relationships = {[keys.trakt303]: {provider: "Trakt", value: saved, receivedAt: "2026-11-01T00:00:00.000Z"}};
  assert.deepEqual(await source(liveScan(provider.transport), {relationships}).traktEpisodeSearch(303), {results: saved, cached: true});
  assert.equal(provider.sent.length, 0);

  setCoverageIssue({id: issueId("target", keys.trakt303), operation: "episode-identity", provider: "Trakt", scope: "episode", cause: "503", action: "Retry."});
  const retried = source(liveScan(provider.transport), {relationships});
  assert.deepEqual(await retried.traktEpisodeSearch(303), {results: [{type: "episode"}], cached: false});
  assert.equal(provider.count("trakt-episode-search-by-tvdb-episode"), 1);
  assert.deepEqual(retried.changes().relationships[keys.trakt303], {provider: "Trakt", value: [{type: "episode"}], receivedAt: NOW});
  assert.equal(getCoverageIssue(issueId("target", keys.trakt303)), undefined);
});

const imdbRecord = {data: {remoteIds: [{id: "TT0303", sourceName: "IMDB"}, {id: 7, sourceName: "Other"}]}};

test("IMDb results are kept and reused while the TVDB catalogue is unchanged, and requested again when it changed", async t => {
  temporaryDatabase(t);
  const provider = fakeTransport(() => imdbRecord);
  const first = source(liveScan(provider.transport));
  assert.deepEqual(await first.tvdbEpisodeExtended(303), new Set(["tt0303"]));
  assert.deepEqual(first.changes().tvdbEpisodeImdbIds, {303: ["tt0303"]});

  const kept = source(liveScan(provider.transport), {imdb: {303: ["tt9"], 304: ["tt4"]}});
  assert.deepEqual(await kept.tvdbEpisodeExtended(303), new Set(["tt9"]));
  assert.equal(provider.count("tvdb-episode-extended"), 1);
  assert.deepEqual(kept.changes().tvdbEpisodeImdbIds, {303: ["tt9"], 304: ["tt4"]}, "kept results are pruned by the caller, as today");

  const changed = source(liveScan(provider.transport), {imdb: {303: ["tt9"], 304: ["tt4"]}, reuseImdbIds: false});
  assert.deepEqual(await changed.tvdbEpisodeExtended(303), new Set(["tt0303"]));
  assert.equal(provider.count("tvdb-episode-extended"), 2);
  assert.deepEqual(changed.changes().tvdbEpisodeImdbIds, {303: ["tt0303"]});
});

test("a kept IMDb result never skips the retry of a recorded IMDb crosswalk failure", async t => {
  temporaryDatabase(t);
  reconcileEpisodeCheckIssues({ratingKey: "target"}, [{operation: "episode-crosswalk", crosswalk: "IMDb", episode: {provider: "TVDB", id: 303, season: 2, episode: 3}, kind: "request-failed", reason: "the TVDB request failed."}]);
  const provider = fakeTransport(() => imdbRecord);
  const evidence = source(liveScan(provider.transport), {imdb: {303: ["tt9"]}, relationships: {[keys.tvdbExtended303]: {provider: "TVDB", value: {data: {remoteIds: []}}, receivedAt: "2026-11-01T00:00:00.000Z"}}});
  assert.deepEqual(await evidence.tvdbEpisodeExtended(303), new Set(["tt0303"]));
  assert.equal(provider.count("tvdb-episode-extended"), 1);
  assert.deepEqual(evidence.changes().tvdbEpisodeImdbIds, {303: ["tt0303"]});
});

test("a recorded TMDB crosswalk failure forces that crosswalk alone, even when today's shared answer is current", async t => {
  temporaryDatabase(t);
  const {store, records} = inMemoryStore();
  records.set(303, {value: MATCH, receivedAt: "2026-11-12T09:30:00.000Z"});
  records.set(304, {value: MATCH, receivedAt: "2026-11-12T09:30:00.000Z"});
  reconcileEpisodeCheckIssues({ratingKey: "target"}, [{operation: "episode-crosswalk", crosswalk: "TMDB", episode: {provider: "TVDB", id: 303}, kind: "request-failed", reason: "the TMDB request failed."}]);
  const provider = fakeTransport(() => MATCH);
  const evidence = source(liveScan(provider.transport, {store}));
  await evidence.tmdbEpisodeByTvdb(304);
  assert.equal(provider.sent.length, 0, "a current shared answer is reused");
  await evidence.tmdbEpisodeByTvdb(303);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 1);
});

test("a Trakt login lost mid-run is one library issue, not a failed lookup per episode, until a Trakt lookup succeeds", async t => {
  temporaryDatabase(t);
  let loggedIn = false;
  const provider = fakeTransport(() => { if (!loggedIn) throw new ProviderHttpError("Trakt", 401); return []; });
  const scan = liveScan(provider.transport);
  const outcomes = await Promise.allSettled([source(scan).traktEpisodeSearch(303), source(scan, {show: other}).traktEpisodeSearch(303)]);
  for (const outcome of outcomes) assert.ok(outcome.status === "rejected" && outcome.reason instanceof TraktLoginUnavailableError);
  assert.deepEqual(listCoverageIssues().map(issue => issue.id), ["provider-authentication:Trakt"]);
  loggedIn = true;
  await source(scan).traktEpisodeSearch(303);
  assert.deepEqual(listCoverageIssues(), []);
});

test("without a Trakt login the run has no Trakt searches and sends none", async t => {
  temporaryDatabase(t);
  const provider = fakeTransport(() => []);
  const evidence = source(liveScan(provider.transport, {traktLogin: false}));
  assert.equal(evidence.traktAvailable, false);
  await assert.rejects(evidence.traktEpisodeSearch(303), TraktLoginUnavailableError);
  assert.equal(provider.sent.length, 0);
});

test("a TVDB lookup fails with the run's TVDB authentication error, linked to its issue, without a request", async t => {
  temporaryDatabase(t);
  const loginFailed = new ProviderHttpError("TVDB", 401);
  const provider = fakeTransport(() => imdbRecord);
  const evidence = source(liveScan(provider.transport), {show: {...target, tvdbAuthenticationError: loginFailed}});
  await assert.rejects(evidence.tvdbEpisodeExtended(303), error => error === loginFailed);
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(getCoverageIssue(issueId("target", keys.tvdbExtended303))?.causedBy, ["provider-authentication:TVDB"]);
});

test("a TMDB episode validation records its Trakt provenance on failure and is requested again when its Trakt crosswalk is retried", async t => {
  temporaryDatabase(t);
  const provider = fakeTransport(() => { throw new ProviderHttpError("TMDB", 404); });
  const validate = (evidence: ComparisonEvidence) => evidence.tmdbEpisodeDetails({tmdbShowId: 10, season: 2, episode: 3}, {tvdbEpisodeId: 303, tmdbEpisodeId: 901, cached: true});
  await assert.rejects(validate(source(liveScan(provider.transport))));
  const issue = getCoverageIssue(issueId("target", keys.tmdbValidation));
  assert.deepEqual(issue?.lookup?.source, [
    {provider: "Plex", kind: "TVDB series", id: 20}, {provider: "TVDB", kind: "catalogue episode", id: 303, cached: false},
    {provider: "Trakt", kind: "external TMDB show ID", id: 10, cached: true}, {provider: "Trakt", kind: "external TMDB episode ID", id: 901, cached: true},
  ]);
  assert.deepEqual(issue?.episode, {provider: "TMDB", id: 901, showId: 10, season: 2, episode: 3});

  const saved = {[keys.tmdbValidation]: {provider: "TMDB", value: {id: 901}, receivedAt: "2026-11-01T00:00:00.000Z"}};
  const ok = fakeTransport(() => ({id: 902}));
  // Not reused while its failed request is open...
  assert.deepEqual(await validate(source(liveScan(ok.transport), {relationships: saved})), {id: 902});
  assert.equal(ok.sent.length, 1);
  // ...reused once that is resolved...
  assert.deepEqual(await validate(source(liveScan(ok.transport), {relationships: saved})), {id: 901});
  assert.equal(ok.sent.length, 1);
  // ...but a retried Trakt crosswalk requests its validations again.
  reconcileEpisodeCheckIssues({ratingKey: "target"}, [{operation: "episode-crosswalk", crosswalk: "Trakt", episode: {provider: "TVDB", id: 303}, kind: "request-failed", reason: "the Trakt request failed."}]);
  assert.deepEqual(await validate(source(liveScan(ok.transport), {relationships: saved})), {id: 902});
  assert.equal(ok.count("tmdb-episode-by-show-season-episode"), 2);
});

test("an invalid identity is a rejected lookup, never a synchronous throw", async t => {
  temporaryDatabase(t);
  const provider = fakeTransport(() => []);
  const evidence = source(liveScan(provider.transport));
  const calls = [() => evidence.tmdbEpisodeByTvdb(0), () => evidence.traktEpisodeSearch(-1), () => evidence.tvdbEpisodeExtended(1.5), () => evidence.tmdbEpisodeDetails({tmdbShowId: 10, season: -1, episode: 1}, {tvdbEpisodeId: 1, tmdbEpisodeId: 1, cached: false})];
  for (const call of calls) {
    let pending: Promise<unknown> | undefined;
    assert.doesNotThrow(() => { pending = call(); });
    await assert.rejects(pending!, RangeError);
  }
  assert.equal(provider.sent.length, 0);
});

test("a comparison that cannot use a crosswalk answer strips its copy's receipt time; a failed comparison retains this scan's checked outcomes", async t => {
  temporaryDatabase(t);
  const provider = fakeTransport(() => MATCH);
  const evidence = source(liveScan(provider.transport));
  await evidence.tmdbEpisodeByTvdb(303);
  evidence.rejectTmdbEpisodeCrosswalk(303);
  const {relationships, retained} = evidence.changes();
  assert.deepEqual(relationships[keys.tmdbCrosswalk303], {provider: "TMDB", value: MATCH});
  const lastGood = {[keys.tmdbCrosswalk303]: {provider: "TMDB", value: {tv_episode_results: []}, receivedAt: "2026-11-01T00:00:00.000Z"}, [keys.trakt303]: {provider: "Trakt", value: []}};
  assert.deepEqual(retained(lastGood), {[keys.tmdbCrosswalk303]: {provider: "TMDB", value: MATCH}, [keys.trakt303]: {provider: "Trakt", value: []}});
});

test("changes are a snapshot: the caller cannot alter the source's evidence, and a live source has no offline recovery", async t => {
  temporaryDatabase(t);
  const provider = fakeTransport(() => []);
  const evidence = source(liveScan(provider.transport));
  await evidence.traktEpisodeSearch(303);
  const changes = evidence.changes();
  assert.deepEqual(changes.recovered, {relationships: {}, resolves: []});
  delete changes.relationships[keys.trakt303];
  assert.deepEqual(await evidence.traktEpisodeSearch(303), {results: [], cached: true});
  assert.equal(provider.sent.length, 1);
});

test("series lookups use the legacy series evidence until the live source answers them", async t => {
  temporaryDatabase(t);
  const show = {id: 10, name: "Target"};
  const asked: string[] = [];
  const series: SeriesEvidence = {
    tmdbSeriesByTvdb: async id => { asked.push(`tmdb-by-tvdb:${id}`); return [show]; },
    tmdbSeriesSummary: async id => { asked.push(`tmdb:${id}`); return show; },
    tmdbSeriesSummaryWithExternalIds: async id => { asked.push(`tmdb+ids:${id}`); return undefined; },
    tvdbSeriesSummary: async id => { asked.push(`tvdb:${id}`); return null; },
  };
  const evidence = source(liveScan(fakeTransport(() => []).transport), {series});
  assert.deepEqual(await evidence.tmdbSeriesByTvdb(20), [show]);
  assert.deepEqual(await evidence.tmdbSeriesSummary(10), show);
  assert.equal(await evidence.tmdbSeriesSummaryWithExternalIds(11), undefined);
  assert.equal(await evidence.tvdbSeriesSummary(21), null);
  assert.deepEqual(asked, ["tmdb-by-tvdb:20", "tmdb:10", "tmdb+ids:11", "tvdb:21"]);
});
