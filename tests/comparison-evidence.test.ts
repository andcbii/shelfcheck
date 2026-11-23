import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { liveComparisonEvidence, CrosswalkResponseError, TraktLoginUnavailableError } = await import("../lib/comparison-evidence");
const { tmdbCrosswalkScanRun } = await import("../lib/tmdb-crosswalk-coordinator");
const { ProviderHttpError } = await import("../lib/provider-client");
hook.deregister();
import { inMemoryLookupIssues, inMemoryTraktLogin } from "./in-memory-lookup-issues";
import type { ComparisonEvidence } from "../lib/comparison-evidence";
import { providerLookup, type ProviderLookup } from "../lib/provider-lookup";
import type { SharedCrosswalkRecord } from "../lib/tmdb-crosswalk-policy";

const SCAN_STARTED = "2026-11-12T09:00:00.000Z";
const NOW = "2026-11-12T10:00:00.000Z";

/** The stored relationship keys (lookup keys), spelled out independently of the code. */
const keys = {
  tmdbCrosswalk303: "tmdb-episode-by-tvdb:303",
  trakt303: "trakt-episode-by-tvdb:303",
  tvdbExtended303: "tvdb-episode-extended:303",
  tmdbValidation: "tmdb-episode:10:2:3",
  tmdbSeriesByTvdb20: "tmdb-series-by-tvdb:20",
  tmdbSeriesByTvdb21: "tmdb-series-by-tvdb:21",
  tmdbSummary10: "tmdb-series:10:summary",
  tmdbSummaryWithIds10: "tmdb-series:10:external-ids",
  tvdbSummary20: "tvdb-series:20",
};

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

const target = {
  ratingKey: "target", title: "Target", tmdbId: 10, tvdbId: 20,
  tvdbSource: [{provider: "Plex" as const, kind: "TVDB series", id: 20}], tvdbCached: false,
  providerEpisodes: [{source: "TVDB" as const, providerEpisodeId: 303, season: 2, episode: 3, title: "Three", showTitle: "Target"}],
};
const other = {...target, ratingKey: "other", title: "Other"};

type Scan = Parameters<typeof liveComparisonEvidence>[0]["scan"];
type Issues = ReturnType<typeof inMemoryLookupIssues>;
/** One show's Coverage Issues in memory, raised at a fixed time. */
const showIssues = (options: Parameters<typeof inMemoryLookupIssues>[0] = {}) => inMemoryLookupIssues({now: () => NOW, ...options});
function liveScan(transport: Scan["transport"], options: {traktLogin?: boolean; store?: ReturnType<typeof inMemoryStore>["store"]; traktLoginDiagnostics?: Scan["traktLoginDiagnostics"]} = {}): Scan {
  return {
    transport, crosswalks: tmdbCrosswalkScanRun({store: options.store || inMemoryStore().store, now: () => NOW, startedAt: SCAN_STARTED}),
    traktLogin: options.traktLogin ?? true, traktLoginDiagnostics: options.traktLoginDiagnostics || inMemoryTraktLogin(), now: () => NOW,
  };
}
function source(scan: Scan, options: {show?: typeof target & {tvdbAuthenticationError?: unknown}; issues?: Issues; relationships?: Record<string, {provider: string; value: unknown; receivedAt?: string}>; imdb?: Record<string, string[]>; reuseImdbIds?: boolean; forced?: boolean} = {}): ComparisonEvidence {
  const issues = options.issues || showIssues();
  return liveComparisonEvidence({
    scan, show: options.show || target, forced: options.forced ?? false, failures: issues.failures, diagnostics: issues.diagnostics,
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

test("overlapping comparisons in one scan run send one TMDB crosswalk request and each keeps the same evidence", async () => {
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

test("the scan run's coordinator is shared by every source: a forced comparison accepts this scan's answer, another scan run requests again", async () => {
  const {store} = inMemoryStore();
  const provider = fakeTransport(() => MATCH);
  const scan = liveScan(provider.transport, {store});
  await source(scan).tmdbEpisodeByTvdb(303);
  assert.deepEqual(await source(scan, {show: other, forced: true}).tmdbEpisodeByTvdb(303), MATCH.tv_episode_results);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 1);
  await source(liveScan(provider.transport, {store}), {forced: true}).tmdbEpisodeByTvdb(303);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 2);
});

test("a failed in-flight crosswalk fails every waiting comparison with its own failed-request issue, and a later comparison requests again", async () => {
  const answers = [deferred(), deferred()];
  const provider = fakeTransport(() => answers[provider.sent.length - 1].promise);
  const scan = liveScan(provider.transport);
  const targetIssues = showIssues(), otherIssues = showIssues();
  const waiting = [source(scan, {issues: targetIssues}).tmdbEpisodeByTvdb(303), source(scan, {show: other, issues: otherIssues}).tmdbEpisodeByTvdb(303)];
  await new Promise(setImmediate);
  const failure = new ProviderHttpError("TMDB", 503);
  answers[0].reject(failure);
  for (const outcome of await Promise.allSettled(waiting)) assert.deepEqual(outcome, {status: "rejected", reason: failure});
  for (const issues of [targetIssues, otherIssues]) assert.equal(issues.open.get(keys.tmdbCrosswalk303)?.error, failure);

  const later = source(scan, {issues: targetIssues}).tmdbEpisodeByTvdb(303);
  await new Promise(setImmediate);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 2);
  answers[1].resolve(MATCH);
  assert.deepEqual(await later, MATCH.tv_episode_results);
  assert.equal(targetIssues.open.has(keys.tmdbCrosswalk303), false, "the answer resolves this show's failed request");
  assert.ok(otherIssues.open.has(keys.tmdbCrosswalk303), "another show's failed request stays until its own lookup succeeds");
});

test("an empty answer is a success: no failure is raised and the empty evidence is kept", async () => {
  const issues = showIssues();
  const provider = fakeTransport(lookup => lookup.kind === "trakt-episode-search-by-tvdb-episode" ? [] : {tv_episode_results: []});
  const evidence = source(liveScan(provider.transport), {issues});
  assert.deepEqual(await evidence.tmdbEpisodeByTvdb(303), []);
  assert.deepEqual(await evidence.traktEpisodeSearch(303), {results: [], cached: false});
  assert.equal(issues.open.size, 0);
  assert.deepEqual(evidence.changes().relationships[keys.trakt303], {provider: "Trakt", value: [], receivedAt: NOW});
});

test("an unreadable successful answer throws an unreadable-response error after resolving the failed request", async () => {
  const issues = showIssues();
  issues.open.set(keys.tmdbCrosswalk303, {failedAt: "2026-11-11T10:00:00.000Z"});
  issues.open.set(keys.trakt303, {});
  const provider = fakeTransport(lookup => lookup.kind === "tmdb-episode-by-tvdb-episode" ? {tv_episode_results: "no"} : lookup.kind === "trakt-episode-search-by-tvdb-episode" ? {} : {data: {remoteIds: "no"}});
  const evidence = source(liveScan(provider.transport), {issues});
  await assert.rejects(evidence.tmdbEpisodeByTvdb(303), CrosswalkResponseError);
  await assert.rejects(evidence.traktEpisodeSearch(303), CrosswalkResponseError);
  await assert.rejects(evidence.tvdbEpisodeExtended(303), CrosswalkResponseError);
  assert.equal(issues.open.size, 0);
  // The unreadable crosswalk answer is kept only to explain the failure: it has no receipt time.
  assert.deepEqual(evidence.changes().relationships[keys.tmdbCrosswalk303], {provider: "TMDB", value: {tv_episode_results: "no"}});
});

test("a saved answer is reused without a request while no failed request is recorded for it, and requested again when one is", async () => {
  const saved = [{type: "episode", episode: {season: 2, number: 3}}];
  const provider = fakeTransport(() => [{type: "episode"}]);
  const relationships = {[keys.trakt303]: {provider: "Trakt", value: saved, receivedAt: "2026-11-01T00:00:00.000Z"}};
  assert.deepEqual(await source(liveScan(provider.transport), {relationships}).traktEpisodeSearch(303), {results: saved, cached: true});
  assert.equal(provider.sent.length, 0);

  const issues = showIssues();
  issues.open.set(keys.trakt303, {});
  const retried = source(liveScan(provider.transport), {relationships, issues});
  assert.deepEqual(await retried.traktEpisodeSearch(303), {results: [{type: "episode"}], cached: false});
  assert.equal(provider.count("trakt-episode-search-by-tvdb-episode"), 1);
  assert.deepEqual(retried.changes().relationships[keys.trakt303], {provider: "Trakt", value: [{type: "episode"}], receivedAt: NOW});
  assert.equal(issues.open.has(keys.trakt303), false);
});

const imdbRecord = {data: {remoteIds: [{id: "TT0303", sourceName: "IMDB"}, {id: 7, sourceName: "Other"}]}};

test("IMDb results are kept and reused while the TVDB catalogue is unchanged, and requested again when it changed", async () => {
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

test("a kept IMDb result never skips the retry of a recorded IMDb crosswalk failure", async () => {
  const issues = showIssues({crosswalkFailures: [{crosswalk: "IMDb", tvdbEpisodeId: 303}]});
  const provider = fakeTransport(() => imdbRecord);
  const evidence = source(liveScan(provider.transport), {issues, imdb: {303: ["tt9"]}, relationships: {[keys.tvdbExtended303]: {provider: "TVDB", value: {data: {remoteIds: []}}, receivedAt: "2026-11-01T00:00:00.000Z"}}});
  assert.deepEqual(await evidence.tvdbEpisodeExtended(303), new Set(["tt0303"]));
  assert.equal(provider.count("tvdb-episode-extended"), 1);
  assert.deepEqual(evidence.changes().tvdbEpisodeImdbIds, {303: ["tt0303"]});
});

test("a recorded TMDB crosswalk failure forces that crosswalk alone, even when today's shared answer is current", async () => {
  const {store, records} = inMemoryStore();
  records.set(303, {value: MATCH, receivedAt: "2026-11-12T09:30:00.000Z"});
  records.set(304, {value: MATCH, receivedAt: "2026-11-12T09:30:00.000Z"});
  const provider = fakeTransport(() => MATCH);
  const evidence = source(liveScan(provider.transport, {store}), {issues: showIssues({crosswalkFailures: [{crosswalk: "TMDB", tvdbEpisodeId: 303}]})});
  await evidence.tmdbEpisodeByTvdb(304);
  assert.equal(provider.sent.length, 0, "a current shared answer is reused");
  await evidence.tmdbEpisodeByTvdb(303);
  assert.equal(provider.count("tmdb-episode-by-tvdb-episode"), 1);
});

test("a Trakt login lost mid-run is one library issue, not a failed lookup per episode, until a Trakt lookup succeeds", async () => {
  let loggedIn = false;
  const provider = fakeTransport(() => { if (!loggedIn) throw new ProviderHttpError("Trakt", 401); return []; });
  const traktLogin = inMemoryTraktLogin();
  const scan = liveScan(provider.transport, {traktLoginDiagnostics: traktLogin});
  const targetIssues = showIssues(), otherIssues = showIssues();
  const outcomes = await Promise.allSettled([source(scan, {issues: targetIssues}).traktEpisodeSearch(303), source(scan, {show: other, issues: otherIssues}).traktEpisodeSearch(303)]);
  for (const outcome of outcomes) assert.ok(outcome.status === "rejected" && outcome.reason instanceof TraktLoginUnavailableError);
  assert.equal(traktLogin.failed, true);
  assert.equal(targetIssues.open.size + otherIssues.open.size, 0);
  loggedIn = true;
  await source(scan).traktEpisodeSearch(303);
  assert.equal(traktLogin.failed, false);
});

test("without a Trakt login the run has no Trakt searches and sends none", async () => {
  const provider = fakeTransport(() => []);
  const evidence = source(liveScan(provider.transport, {traktLogin: false}));
  assert.equal(evidence.traktAvailable, false);
  await assert.rejects(evidence.traktEpisodeSearch(303), TraktLoginUnavailableError);
  assert.equal(provider.sent.length, 0);
});

test("a TVDB lookup fails with the run's TVDB authentication error, raised as its failed request, without a request", async () => {
  const loginFailed = new ProviderHttpError("TVDB", 401);
  const issues = showIssues();
  const provider = fakeTransport(() => imdbRecord);
  const evidence = source(liveScan(provider.transport), {issues, show: {...target, tvdbAuthenticationError: loginFailed}});
  await assert.rejects(evidence.tvdbEpisodeExtended(303), error => error === loginFailed);
  assert.equal(provider.sent.length, 0);
  // The diagnostics adapter links an error that is the run's TVDB authentication error to its issue.
  assert.equal(issues.open.get(keys.tvdbExtended303)?.error, loginFailed);
});

test("a TMDB episode validation records its Trakt provenance on failure and is requested again when its Trakt crosswalk is retried", async () => {
  const provider = fakeTransport(() => { throw new ProviderHttpError("TMDB", 404); });
  const validate = (evidence: ComparisonEvidence) => evidence.tmdbEpisodeDetails(providerLookup.tmdbEpisodeByShowSeasonEpisode(10, 2, 3), {tvdbEpisodeId: 303, tmdbEpisodeId: 901, cached: true});
  const issues = showIssues();
  await assert.rejects(validate(source(liveScan(provider.transport), {issues})));
  assert.deepEqual(issues.open.get(keys.tmdbValidation)?.lookupSource, [
    {provider: "Plex", kind: "TVDB series", id: 20}, {provider: "TVDB", kind: "catalogue episode", id: 303, cached: false},
    {provider: "Trakt", kind: "external TMDB show ID", id: 10, cached: true}, {provider: "Trakt", kind: "external TMDB episode ID", id: 901, cached: true},
  ]);

  const saved = {[keys.tmdbValidation]: {provider: "TMDB", value: {id: 901}, receivedAt: "2026-11-01T00:00:00.000Z"}};
  const ok = fakeTransport(() => ({id: 902}));
  // Not reused while its failed request is open...
  assert.deepEqual(await validate(source(liveScan(ok.transport), {issues, relationships: saved})), {id: 902});
  assert.equal(ok.sent.length, 1);
  // ...reused once that is resolved...
  assert.deepEqual(await validate(source(liveScan(ok.transport), {issues, relationships: saved})), {id: 901});
  assert.equal(ok.sent.length, 1);
  // ...but a retried Trakt crosswalk requests its validations again.
  const retried = showIssues({crosswalkFailures: [{crosswalk: "Trakt", tvdbEpisodeId: 303}]});
  assert.deepEqual(await validate(source(liveScan(ok.transport), {issues: retried, relationships: saved})), {id: 902});
  assert.equal(ok.count("tmdb-episode-by-show-season-episode"), 2);
});

test("an invalid identity is a rejected lookup, never a synchronous throw", async () => {
  const provider = fakeTransport(() => []);
  const evidence = source(liveScan(provider.transport));
  const calls = [() => evidence.tmdbSeriesByTvdb(0), () => evidence.tmdbSeriesSummary(-1), () => evidence.tmdbSeriesSummaryWithExternalIds(2.5), () => evidence.tvdbSeriesSummary(Number.MAX_SAFE_INTEGER + 1), () => evidence.tmdbEpisodeByTvdb(0), () => evidence.traktEpisodeSearch(-1), () => evidence.tvdbEpisodeExtended(1.5)];
  for (const call of calls) {
    let pending: Promise<unknown> | undefined;
    assert.doesNotThrow(() => { pending = call(); });
    await assert.rejects(pending!, RangeError);
  }
  assert.equal(provider.sent.length, 0);
});

test("a comparison that cannot use a crosswalk answer strips its copy's receipt time; a failed comparison retains this scan's checked outcomes", async () => {
  const provider = fakeTransport(() => MATCH);
  const evidence = source(liveScan(provider.transport));
  await evidence.tmdbEpisodeByTvdb(303);
  evidence.rejectTmdbEpisodeCrosswalk(303);
  const {relationships, retained} = evidence.changes();
  assert.deepEqual(relationships[keys.tmdbCrosswalk303], {provider: "TMDB", value: MATCH});
  const lastGood = {[keys.tmdbCrosswalk303]: {provider: "TMDB", value: {tv_episode_results: []}, receivedAt: "2026-11-01T00:00:00.000Z"}, [keys.trakt303]: {provider: "Trakt", value: []}};
  assert.deepEqual(retained(lastGood), {[keys.tmdbCrosswalk303]: {provider: "TMDB", value: MATCH}, [keys.trakt303]: {provider: "Trakt", value: []}});
});

test("changes are a snapshot: the caller cannot alter the source's evidence, and a live source has no cached-recheck recovery", async () => {
  const provider = fakeTransport(() => imdbRecord);
  const evidence = source(liveScan(provider.transport));
  await evidence.tvdbEpisodeExtended(303);
  const changes = evidence.changes();
  assert.deepEqual(changes.recovered, {relationships: {}, resolves: []});
  delete changes.relationships[keys.tvdbExtended303];
  changes.tvdbEpisodeImdbIds["303"].push("tt1");
  assert.deepEqual(await evidence.tvdbEpisodeExtended(303), new Set(["tt0303"]));
  assert.deepEqual(evidence.changes().tvdbEpisodeImdbIds, {303: ["tt0303"]});
  assert.ok(evidence.changes().relationships[keys.tvdbExtended303]);
  assert.equal(provider.sent.length, 1);
});

const OLD = "2026-11-01T00:00:00.000Z";

test("a TMDB series association is requested once and kept: only usable series answer, and an empty answer is a success", async () => {
  const answer = {tv_results: [{id: 10, name: "Target"}, {name: "No ID"}]};
  const provider = fakeTransport(() => answer);
  const evidence = source(liveScan(provider.transport));
  assert.deepEqual(await evidence.tmdbSeriesByTvdb(20), [{id: 10, name: "Target"}]);
  assert.deepEqual(await evidence.tmdbSeriesByTvdb(20), [{id: 10, name: "Target"}]);
  assert.equal(provider.count("tmdb-series-by-tvdb-series"), 1);
  assert.deepEqual(evidence.changes().relationships, {[keys.tmdbSeriesByTvdb20]: {provider: "TMDB", value: answer, receivedAt: NOW}});

  const issues = showIssues();
  const empty = source(liveScan(fakeTransport(() => ({tv_results: []})).transport), {issues});
  assert.deepEqual(await empty.tmdbSeriesByTvdb(20), []);
  assert.equal(issues.open.size, 0);

  const unreadable = source(liveScan(fakeTransport(() => ({tv_results: "no"})).transport));
  await assert.rejects(unreadable.tmdbSeriesByTvdb(20), CrosswalkResponseError);
});

test("a saved TMDB series association is reused while no failed request is recorded for it; a failed one is raised and retried", async () => {
  const saved = {[keys.tmdbSeriesByTvdb20]: {provider: "TMDB", value: {tv_results: [{id: 10}]}, receivedAt: OLD}};
  const failing = fakeTransport(() => { throw new ProviderHttpError("TMDB", 503); });
  assert.deepEqual(await source(liveScan(failing.transport), {relationships: saved}).tmdbSeriesByTvdb(20), [{id: 10}]);
  assert.equal(failing.sent.length, 0);

  const issues = showIssues();
  await assert.rejects(source(liveScan(failing.transport), {issues}).tmdbSeriesByTvdb(20), ProviderHttpError);
  assert.ok(issues.open.get(keys.tmdbSeriesByTvdb20)?.error instanceof ProviderHttpError);
  assert.equal(issues.open.get(keys.tmdbSeriesByTvdb20)?.lookupSource, undefined, "described from the comparison's own source chain");

  const ok = fakeTransport(() => ({tv_results: [{id: 11}]}));
  const retried = source(liveScan(ok.transport), {issues, relationships: saved});
  assert.deepEqual(await retried.tmdbSeriesByTvdb(20), [{id: 11}]);
  assert.equal(ok.count("tmdb-series-by-tvdb-series"), 1);
  assert.equal(issues.open.has(keys.tmdbSeriesByTvdb20), false);
  assert.deepEqual(retried.changes().relationships[keys.tmdbSeriesByTvdb20], {provider: "TMDB", value: {tv_results: [{id: 11}]}, receivedAt: NOW});
});

test("another TVDB candidate's saved TMDB series association is kept unchanged and never read", async () => {
  const alternative = {provider: "TMDB", value: {tv_results: [{id: 77}]}, receivedAt: OLD};
  const provider = fakeTransport(() => ({tv_results: [{id: 10}]}));
  const evidence = source(liveScan(provider.transport), {relationships: {[keys.tmdbSeriesByTvdb21]: alternative}});
  assert.deepEqual(await evidence.tmdbSeriesByTvdb(20), [{id: 10}]);
  assert.deepEqual(provider.sent, [{kind: "tmdb-series-by-tvdb-series", tvdbSeriesId: 20}]);
  assert.deepEqual(evidence.changes().relationships, {
    [keys.tmdbSeriesByTvdb21]: alternative,
    [keys.tmdbSeriesByTvdb20]: {provider: "TMDB", value: {tv_results: [{id: 10}]}, receivedAt: NOW},
  });
});

test("basic and external-ID TMDB series summaries stay distinct: neither answers the other", async () => {
  const basic = {id: 10, name: "Basic"}, withIds = {id: 10, name: "With IDs", external_ids: {tvdb_id: 20}};
  const provider = fakeTransport(lookup => lookup.kind === "tmdb-series-summary" ? basic : withIds);
  const savedBasic = source(liveScan(provider.transport), {relationships: {[keys.tmdbSummary10]: {provider: "TMDB", value: {id: 10, name: "Saved basic"}, receivedAt: OLD}}});
  assert.deepEqual(await savedBasic.tmdbSeriesSummary(10), {id: 10, name: "Saved basic"});
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(await savedBasic.tmdbSeriesSummaryWithExternalIds(10), withIds);
  assert.deepEqual(provider.sent, [{kind: "tmdb-series-summary-with-external-ids", tmdbShowId: 10}]);

  const savedWithIds = source(liveScan(provider.transport), {relationships: {[keys.tmdbSummaryWithIds10]: {provider: "TMDB", value: withIds, receivedAt: OLD}}});
  assert.deepEqual(await savedWithIds.tmdbSeriesSummaryWithExternalIds(10), withIds);
  assert.deepEqual(await savedWithIds.tmdbSeriesSummary(10), basic);
  assert.equal(provider.count("tmdb-series-summary"), 1);
  assert.equal(provider.count("tmdb-series-summary-with-external-ids"), 1);
  assert.deepEqual(savedWithIds.changes().relationships, {
    [keys.tmdbSummaryWithIds10]: {provider: "TMDB", value: withIds, receivedAt: OLD},
    [keys.tmdbSummary10]: {provider: "TMDB", value: basic, receivedAt: NOW},
  });
});

// Series summary failures are passed to the diagnostics adapter like any lookup's; that they raise no
// Coverage Issue is the adapter's rule (tests/lookup-diagnostics.test.ts).
test("a TMDB series summary that names no series is none, and a failed one rejects with the provider's error", async () => {
  const evidence = source(liveScan(fakeTransport(() => ({success: false})).transport));
  assert.equal(await evidence.tmdbSeriesSummary(10), undefined);
  assert.equal(await evidence.tmdbSeriesSummaryWithExternalIds(10), undefined);
  const failing = source(liveScan(fakeTransport(() => { throw new ProviderHttpError("TMDB", 404); }).transport));
  await assert.rejects(failing.tmdbSeriesSummary(11), ProviderHttpError);
  await assert.rejects(failing.tmdbSeriesSummaryWithExternalIds(11), ProviderHttpError);
});

test("a TVDB series summary is read from its record, is none when TVDB has none, and rejects with the provider's error on failure", async () => {
  const record = {data: {id: 20, name: "Target", slug: "target", year: "2020", extra: 1}};
  const provider = fakeTransport(lookup => lookup.kind === "tvdb-series-summary" && lookup.tvdbSeriesId === 20 ? record : {});
  const evidence = source(liveScan(provider.transport));
  assert.deepEqual(await evidence.tvdbSeriesSummary(20), {id: 20, name: "Target", slug: "target", year: "2020"});
  assert.equal(await evidence.tvdbSeriesSummary(21), null);
  assert.deepEqual(evidence.changes().relationships[keys.tvdbSummary20], {provider: "TVDB", value: record, receivedAt: NOW});
  // A record without its own ID is the requested series.
  const unnamed = source(liveScan(fakeTransport(() => ({data: {name: "Target"}})).transport));
  assert.deepEqual(await unnamed.tvdbSeriesSummary(20), {id: 20, name: "Target", slug: undefined, year: undefined});

  const failing = source(liveScan(fakeTransport(() => { throw new ProviderHttpError("TVDB", 500); }).transport));
  await assert.rejects(failing.tvdbSeriesSummary(20), ProviderHttpError);
});

test("a saved TVDB series summary answers the comparison's summary without a request, even after the run's TVDB login failed", async () => {
  const loginFailed = new ProviderHttpError("TVDB", 401);
  const provider = fakeTransport(() => ({data: {id: 20}}));
  const show = {...target, tvdbAuthenticationError: loginFailed};
  const saved = {[keys.tvdbSummary20]: {provider: "TVDB", value: {data: {id: 20, name: "Saved", slug: "saved"}}, receivedAt: OLD}};
  const evidence = source(liveScan(provider.transport), {show, relationships: saved});
  assert.deepEqual(await evidence.tvdbSeriesSummary(20), {id: 20, name: "Saved", slug: "saved", year: undefined});
  await assert.rejects(evidence.tvdbSeriesSummary(21), error => error === loginFailed);
  assert.equal(provider.sent.length, 0);
});
