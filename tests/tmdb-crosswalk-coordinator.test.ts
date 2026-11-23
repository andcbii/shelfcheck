import assert from "node:assert/strict";
import test from "node:test";
import { invalidateShowTmdbCrosswalks, saveRecoveredTmdbCrosswalks, tmdbCrosswalkScanRun, type SharedCrosswalkStore } from "../lib/tmdb-crosswalk-coordinator";
import type { SharedCrosswalkRecord } from "../lib/tmdb-crosswalk-policy";

const SCAN_STARTED = "2026-06-01T23:30:00.000Z";
const NOW = "2026-06-01T23:40:00.000Z";
const MATCH = { tv_episode_results: [{ id: 901, show_id: 10 }] };
/** The saved relationship key of TVDB episode 301's TMDB external-ID crosswalk (today's key projection). */
const KEY_301 = "TMDB:https://api.themoviedb.org/3/find/301?external_source=tvdb_id";
const OLD_RECEIPT = "2026-05-30T10:00:00.000Z";

/** Shared crosswalk evidence held in memory, with every save recorded in order. */
function inMemoryStore(initial: Record<number, SharedCrosswalkRecord> = {}) {
  const records = new Map(Object.entries(initial).map(([id, record]) => [Number(id), record]));
  const saves: { tvdbEpisodeId: number; record: SharedCrosswalkRecord }[] = [];
  const store: SharedCrosswalkStore = {
    read: (tvdbEpisodeId) => records.get(tvdbEpisodeId),
    save: (tvdbEpisodeId, record) => { saves.push({ tvdbEpisodeId, record }); records.set(tvdbEpisodeId, record); },
  };
  return { store, records, saves };
}

/** A provider request the test settles by hand, counting how often it was sent. */
function controlledRequest() {
  const pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const request = () => new Promise<unknown>((resolve, reject) => { pending.push({ resolve, reject }); });
  return { request, pending, get count() { return pending.length; } };
}

const scanRun = (store: SharedCrosswalkStore, options: { now?: () => string; startedAt?: string } = {}) =>
  tmdbCrosswalkScanRun({ store, now: options.now || (() => NOW), startedAt: options.startedAt || SCAN_STARTED });

test("overlapping comparisons wait for one request, and its shared outcome is saved before any of them continues", async () => {
  const { store, records } = inMemoryStore();
  const run = scanRun(store);
  const provider = controlledRequest();
  const first = run.comparison({ relationships: {}, forced: false });
  const second = run.comparison({ relationships: {}, forced: false });
  const seenByWaiters: (SharedCrosswalkRecord | undefined)[] = [];
  const looked = [first, second].map((comparison) => comparison.lookup(301, provider.request).then((result) => { seenByWaiters.push(records.get(301)); return result; }));
  await Promise.resolve();
  assert.equal(provider.count, 1);
  provider.pending[0].resolve(MATCH);
  const results = await Promise.all(looked);
  assert.deepEqual(results, [MATCH, MATCH]);
  assert.deepEqual(seenByWaiters, [{ value: MATCH, receivedAt: NOW }, { value: MATCH, receivedAt: NOW }]);
});

test("a failed request is shared only while it is in flight; a comparison that looks up after it ended requests again", async () => {
  const { store } = inMemoryStore();
  const run = scanRun(store);
  const provider = controlledRequest();
  const failure = new Error("TMDB is down");
  const waiting = [run.comparison({ relationships: {}, forced: false }), run.comparison({ relationships: {}, forced: false })].map((comparison) => comparison.lookup(301, provider.request));
  await Promise.resolve();
  provider.pending[0].reject(failure);
  for (const outcome of await Promise.allSettled(waiting)) assert.deepEqual(outcome, { status: "rejected", reason: failure });
  assert.equal(provider.count, 1);
  const later = run.comparison({ relationships: {}, forced: false }).lookup(301, provider.request);
  await Promise.resolve();
  assert.equal(provider.count, 2);
  provider.pending[1].resolve(MATCH);
  assert.deepEqual(await later, MATCH);
});

test("a failed request durably rejects the shared outcome, saved before waiting comparisons continue, and leaves the comparison no copy", async () => {
  const { store, records } = inMemoryStore({ 301: { value: MATCH, receivedAt: "2026-05-30T10:00:00.000Z" } });
  const run = scanRun(store);
  const provider = controlledRequest();
  const relationships = { [KEY_301]: { provider: "TMDB", value: MATCH, receivedAt: "2026-05-30T10:00:00.000Z" } };
  let seenByWaiter: SharedCrosswalkRecord | undefined;
  const looked = run.comparison({ relationships, forced: false }).lookup(301, provider.request).catch((error) => { seenByWaiter = records.get(301); throw error; });
  await Promise.resolve();
  provider.pending[0].reject(new Error("TMDB is down"));
  await assert.rejects(looked, /TMDB is down/);
  assert.deepEqual(seenByWaiter, { rejectedAt: NOW });
  assert.deepEqual(relationships, {});
});

test("an unreadable answer rejects the shared outcome, keeping its payload without a receipt time, and the comparison's copy has none", async () => {
  const unreadable = { tv_episode_results: "not a list" };
  const { store, records } = inMemoryStore();
  const run = scanRun(store);
  const relationships: Record<string, { provider: string; value: unknown; receivedAt?: string }> = {};
  const result = await run.comparison({ relationships, forced: false }).lookup(301, async () => unreadable);
  assert.deepEqual(result, unreadable);
  assert.deepEqual(records.get(301), { value: unreadable, rejectedAt: NOW });
  assert.deepEqual(relationships, { [KEY_301]: { provider: "TMDB", value: unreadable } });
});

for (const [label, value] of [["a response that is not an object", "oops"], ["a list of non-records", { tv_episode_results: [1] }]] as const) {
  test(`${label} is unreadable`, async () => {
    const { store, records } = inMemoryStore();
    await scanRun(store).comparison({ relationships: {}, forced: false }).lookup(301, async () => value);
    assert.deepEqual(records.get(301), { value, rejectedAt: NOW });
  });
}

for (const [label, value] of [["a valid empty answer", { tv_episode_results: [] }], ["an answer without results", {}], ["null results", { tv_episode_results: null }]] as const) {
  test(`${label} is a usable shared outcome`, async () => {
    const { store, records } = inMemoryStore();
    await scanRun(store).comparison({ relationships: {}, forced: false }).lookup(301, async () => value);
    assert.deepEqual(records.get(301), { value, receivedAt: NOW });
  });
}

test("a shared outcome that cannot be saved fails every waiting comparison, and a later lookup requests again", async () => {
  let failSaves = true;
  const { store } = inMemoryStore();
  const failing: SharedCrosswalkStore = { ...store, save: (id, record) => { if (failSaves) throw new Error("disk full"); store.save(id, record); } };
  const run = scanRun(failing);
  const provider = controlledRequest();
  const waiting = [run.comparison({ relationships: {}, forced: false }), run.comparison({ relationships: {}, forced: false })].map((comparison) => comparison.lookup(301, provider.request));
  await Promise.resolve();
  provider.pending[0].resolve(MATCH);
  for (const outcome of await Promise.allSettled(waiting)) assert.equal(outcome.status, "rejected");
  failSaves = false;
  const later = run.comparison({ relationships: {}, forced: false }).lookup(301, provider.request);
  await Promise.resolve();
  assert.equal(provider.count, 2);
  provider.pending[1].resolve(MATCH);
  assert.deepEqual(await later, MATCH);
});

test("an interpretation failure in one comparison removes only that copy's receipt time; the shared answer stays usable for another", async () => {
  const { store, records } = inMemoryStore();
  const run = scanRun(store);
  const failed: Record<string, { provider: string; value: unknown; receivedAt?: string }> = {};
  const failedComparison = run.comparison({ relationships: failed, forced: false });
  await failedComparison.lookup(301, async () => MATCH);
  failedComparison.rejectCopy(301);
  assert.deepEqual(failed, { [KEY_301]: { provider: "TMDB", value: MATCH } });
  assert.deepEqual(records.get(301), { value: MATCH, receivedAt: NOW });
  const other: Record<string, { provider: string; value: unknown; receivedAt?: string }> = {};
  assert.deepEqual(await run.comparison({ relationships: other, forced: false }).lookup(301, () => assert.fail("no request")), MATCH);
  assert.deepEqual(other, { [KEY_301]: { provider: "TMDB", value: MATCH, receivedAt: NOW } });
});

test("rejecting a comparison's copy after a failed request leaves it without a copy", async () => {
  const { store } = inMemoryStore();
  const relationships: Record<string, { provider: string; value: unknown; receivedAt?: string }> = {};
  const comparison = scanRun(store).comparison({ relationships, forced: false });
  await assert.rejects(comparison.lookup(301, async () => { throw new Error("TMDB is down"); }));
  comparison.rejectCopy(301);
  assert.deepEqual(relationships, {});
});

test("an ordinary lookup reuses a current shared answer with its original receipt time, without a request", async () => {
  const { store, saves } = inMemoryStore({ 301: { value: MATCH, receivedAt: "2026-06-01T01:00:00.000Z" } });
  const relationships: Record<string, { provider: string; value: unknown; receivedAt?: string }> = { [KEY_301]: { provider: "TMDB", value: { tv_episode_results: [] }, receivedAt: "2026-05-01T00:00:00.000Z" } };
  const result = await scanRun(store).comparison({ relationships, forced: false }).lookup(301, () => assert.fail("no request"));
  assert.deepEqual(result, MATCH);
  assert.deepEqual(relationships, { [KEY_301]: { provider: "TMDB", value: MATCH, receivedAt: "2026-06-01T01:00:00.000Z" } });
  assert.deepEqual(saves, []);
});

test("a forced lookup requests even a current shared answer, then accepts the answer its scan requested", async () => {
  const { store } = inMemoryStore({ 301: { value: { tv_episode_results: [] }, receivedAt: "2026-06-01T01:00:00.000Z" } });
  const run = scanRun(store);
  const provider = controlledRequest();
  const first = run.comparison({ relationships: {}, forced: true }).lookup(301, provider.request);
  await Promise.resolve();
  provider.pending[0].resolve(MATCH);
  assert.deepEqual(await first, MATCH);
  assert.deepEqual(await run.comparison({ relationships: {}, forced: true }).lookup(301, provider.request), MATCH);
  assert.equal(provider.count, 1);
});

test("a lookup forced by its own retry requests a current shared answer in an otherwise ordinary comparison", async () => {
  const { store } = inMemoryStore({ 301: { value: MATCH, receivedAt: "2026-06-01T01:00:00.000Z" } });
  const comparison = scanRun(store).comparison({ relationships: {}, forced: false });
  let requests = 0;
  await comparison.lookup(301, async () => { requests += 1; return MATCH; }, { forced: true });
  assert.equal(requests, 1);
});

test("a lookup is requested in this scan once its request settles, failures included", async () => {
  // A failure saves a rejection, so the mark only shows if a usable answer is saved afterwards: here, written directly.
  const { store, records } = inMemoryStore();
  const run = scanRun(store);
  const provider = controlledRequest();
  const failed = run.comparison({ relationships: {}, forced: true }).lookup(301, provider.request);
  await Promise.resolve();
  provider.pending[0].reject(new Error("TMDB is down"));
  await assert.rejects(failed);
  records.set(301, { value: MATCH, receivedAt: "2026-06-01T23:45:00.000Z" });
  assert.deepEqual(await run.comparison({ relationships: {}, forced: true }).lookup(301, provider.request), MATCH);
  assert.equal(provider.count, 1);
});

test("a forced lookup joining a request in flight is not marked requested before that request settles", async () => {
  const { store, records } = inMemoryStore({ 301: { value: { tv_episode_results: [] }, receivedAt: "2026-06-01T01:00:00.000Z" } });
  const run = scanRun(store);
  const provider = controlledRequest();
  const first = run.comparison({ relationships: {}, forced: true }).lookup(301, provider.request);
  await Promise.resolve();
  // A second forced comparison during the request does not adopt the older answer it replaces.
  const relationships: Record<string, { provider: string; value: unknown; receivedAt?: string }> = {};
  const second = run.comparison({ relationships, forced: true }).lookup(301, provider.request);
  assert.equal(provider.count, 1);
  provider.pending[0].resolve(MATCH);
  assert.deepEqual(await Promise.all([first, second]), [MATCH, MATCH]);
  assert.deepEqual(records.get(301), { value: MATCH, receivedAt: NOW });
  assert.deepEqual(relationships, { [KEY_301]: { provider: "TMDB", value: MATCH, receivedAt: NOW } });
});

test("a request that throws before returning is a failed request: its rejection is saved and the lookup counts as requested", async () => {
  const { store, records } = inMemoryStore();
  const run = scanRun(store);
  const throwing = (): Promise<unknown> => { throw new Error("bad request URL"); };
  await assert.rejects(run.comparison({ relationships: {}, forced: true }).lookup(301, throwing), /bad request URL/);
  assert.deepEqual(records.get(301), { rejectedAt: NOW });
  records.set(301, { value: MATCH, receivedAt: "2026-06-01T23:45:00.000Z" });
  assert.deepEqual(await run.comparison({ relationships: {}, forced: true }).lookup(301, () => assert.fail("no request")), MATCH);
});

test("a recheck saves its recovered answers as the comparison's own copies before resolving their failed requests", () => {
  const events: string[] = [];
  const replayed = { [KEY_301]: { provider: "TMDB", value: MATCH, receivedAt: OLD_RECEIPT } };
  saveRecoveredTmdbCrosswalks({ relationships: replayed, resolves: ["episode-identity:ratingKey:other:301"] }, {
    save: (copies) => events.push(`save ${JSON.stringify(copies)}`),
    resolveFailedRequest: (issueId) => events.push(`resolve ${issueId}`),
  });
  assert.deepEqual(events, [`save ${JSON.stringify({ [KEY_301]: replayed[KEY_301] })}`, "resolve episode-identity:ratingKey:other:301"]);
});

test("a recovered answer that cannot be saved leaves its failed request open", () => {
  const resolved: string[] = [];
  assert.throws(() => saveRecoveredTmdbCrosswalks({ relationships: { [KEY_301]: { provider: "TMDB", value: MATCH, receivedAt: OLD_RECEIPT } }, resolves: ["issue"] }, {
    save: () => { throw new Error("disk full"); },
    resolveFailedRequest: (issueId) => resolved.push(issueId),
  }), /disk full/);
  assert.deepEqual(resolved, []);
});

test("a recheck that recovered nothing saves nothing", () => {
  saveRecoveredTmdbCrosswalks({ relationships: {}, resolves: [] }, { save: () => assert.fail("no save"), resolveFailedRequest: () => assert.fail("no resolve") });
});

/** The saved relationship key of TVDB episode 302's TMDB external-ID crosswalk. */
const KEY_302 = "TMDB:https://api.themoviedb.org/3/find/302?external_source=tvdb_id";
const SERIES_KEY = "TMDB:https://api.themoviedb.org/3/find/20?external_source=tvdb_id";
const OLD = "2026-05-01T00:00:00.000Z";
/** A last-good comparison's saved relationships: two crosswalk copies and a series association, all received earlier. */
const lastGood = () => ({
  [KEY_301]: { provider: "TMDB", value: MATCH, receivedAt: OLD },
  [KEY_302]: { provider: "TMDB", value: MATCH, receivedAt: OLD },
  [SERIES_KEY]: { provider: "TMDB", value: { tv_results: [{ id: 10 }] }, receivedAt: OLD },
});

test("retaining last-good results cannot restore a crosswalk the scan checked but whose request failed", async () => {
  const { store } = inMemoryStore();
  const comparison = scanRun(store).comparison({ relationships: {}, forced: true });
  await assert.rejects(comparison.lookup(301, async () => { throw new Error("TMDB is down"); }));
  assert.deepEqual(comparison.retained(lastGood()), { [KEY_302]: lastGood()[KEY_302], [SERIES_KEY]: lastGood()[SERIES_KEY] });
});

test("retaining last-good results replaces each checked crosswalk with this scan's outcome and keeps everything else", async () => {
  const { store } = inMemoryStore({ 302: { value: { tv_episode_results: [] }, receivedAt: "2026-06-01T01:00:00.000Z" } });
  const live: Record<string, { provider: string; value: unknown; receivedAt?: string }> = { [SERIES_KEY]: { provider: "TMDB", value: { tv_results: [] }, receivedAt: NOW } };
  const comparison = scanRun(store).comparison({ relationships: live, forced: false });
  await comparison.lookup(301, async () => ({ tv_episode_results: "unreadable" }));
  await comparison.lookup(302, () => assert.fail("reused"));
  assert.deepEqual(comparison.retained(lastGood()), {
    [KEY_301]: { provider: "TMDB", value: { tv_episode_results: "unreadable" } },
    [KEY_302]: { provider: "TMDB", value: { tv_episode_results: [] }, receivedAt: "2026-06-01T01:00:00.000Z" },
    [SERIES_KEY]: lastGood()[SERIES_KEY],
  });
});

test("clearing one show marks its usable shared answers not current, keeping their original receipt times and rejections", async () => {
  const usable = { value: MATCH, receivedAt: OLD };
  const rejected = { value: { tv_episode_results: "?" }, rejectedAt: OLD };
  const alreadyInvalidated = { value: MATCH, receivedAt: OLD, invalidatedAt: "2026-05-02T00:00:00.000Z" };
  const unrelated = { value: MATCH, receivedAt: OLD };
  const { store, records } = inMemoryStore({ 301: usable, 302: rejected, 303: alreadyInvalidated, 304: unrelated });
  const KEY_303 = "TMDB:https://api.themoviedb.org/3/find/303?external_source=tvdb_id";
  const TRAKT_305 = "Trakt:https://api.trakt.tv/search/tvdb/305?type=episode";
  invalidateShowTmdbCrosswalks({ store, now: () => NOW }, [KEY_301, KEY_302, KEY_303, TRAKT_305]);
  assert.deepEqual(Object.fromEntries(records), {
    301: { value: MATCH, receivedAt: OLD, invalidatedAt: NOW },
    302: rejected,
    303: alreadyInvalidated,
    304: unrelated,
  });
  // The next live lookup of a cleared answer is requested again, even on the day it was received.
  const run = tmdbCrosswalkScanRun({ store, now: () => NOW, startedAt: OLD });
  let requests = 0;
  await run.comparison({ relationships: {}, forced: false }).lookup(301, async () => { requests += 1; return MATCH; });
  assert.equal(requests, 1);
});

test("a lookup is checked before its request, so retaining last-good results while it is in flight drops the older answer", () => {
  const { store } = inMemoryStore();
  const comparison = scanRun(store).comparison({ relationships: {}, forced: false });
  void comparison.lookup(301, () => new Promise(() => {}));
  assert.deepEqual(comparison.retained(lastGood()), { [KEY_302]: lastGood()[KEY_302], [SERIES_KEY]: lastGood()[SERIES_KEY] });
});
