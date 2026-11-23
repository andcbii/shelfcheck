import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The saved source reads the production saved-input formats from a server-only module.
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { savedCatalogueSource } = await import("../lib/saved-catalogue-source");
hook.deregister();

const RECEIVED = "2026-05-01T08:00:00.000Z";
/** TMDB's answer to "which TMDB series is this TVDB series", as a scan persists it. */
const persistedFind = (tvdbId: number, tvResults: unknown[]) => ({
  [`tmdb-series-by-tvdb:${tvdbId}`]: { provider: "TMDB", value: { movie_results: [], tv_results: tvResults, tv_episode_results: [] }, receivedAt: RECEIVED },
});
const noCatalogues = { tmdb: {}, tvdb: {} };
const noHistory = { countedDays: () => 0 };
const association = (relationships: Record<string, { provider: string; value: unknown; receivedAt?: string }>, tvdbId: number) =>
  savedCatalogueSource(noCatalogues, { relationships }, noHistory).tmdbSeriesForTvdb(tvdbId, { mandatory: false });

test("a saved association answers with the first TMDB series recorded for the TVDB series", async () => {
  const relationships = persistedFind(81189, [{ id: 1396, name: "Breaking Bad" }, { id: 9999, name: "Another" }]);
  assert.deepEqual(await association(relationships, 81189), { outcome: "found", id: 1396, cached: true });
});

test("an association that was never saved is missing, not a known empty answer", async () => {
  assert.deepEqual(await association({}, 81189), { outcome: "missing" });
});

test("a saved answer naming no TMDB series is a known empty association", async () => {
  assert.deepEqual(await association(persistedFind(81189, []), 81189), { outcome: "known-empty" });
});

test("another TVDB series' saved association never answers for this one", async () => {
  assert.deepEqual(await association(persistedFind(5555, [{ id: 1396 }]), 81189), { outcome: "missing" });
});

test("saved catalogues are read as saved, and a record too incomplete to compare reports only its download time", async () => {
  const tmdb = { version: 1, downloadedAt: "2026-04-01T00:00:00.000Z", show: { id: 1396, external_ids: { tvdb_id: 81189 } }, episodes: [] };
  const incomplete = { version: 1, downloadedAt: "2026-03-01T00:00:00.000Z", show: { id: 81189 } };
  const source = savedCatalogueSource({ tmdb: { 1396: tmdb }, tvdb: { 81189: incomplete } } as never, { relationships: {} }, noHistory);
  assert.deepEqual(source.savedCatalogue("tmdb", 1396), { id: 1396, catalogue: tmdb, downloadedAt: "2026-04-01T00:00:00.000Z", associatedTvdbId: 81189 });
  assert.equal(source.savedCatalogue("tvdb", 81189), undefined);
  assert.equal(source.savedRecordDownloadedAt("tvdb", 81189), "2026-03-01T00:00:00.000Z");
  // Never a download, even when one is demanded: the saved copy as a reuse, else a failure.
  assert.deepEqual(await source.loadCatalogue("tmdb", 1396, { mandatory: true }), { outcome: "reused", id: 1396, catalogue: tmdb, downloadedAt: "2026-04-01T00:00:00.000Z", associatedTvdbId: 81189 });
  assert.equal((await source.loadCatalogue("tvdb", 81189, { mandatory: false })).outcome, "failed");
});

test("an association that must be requested is missing, since saved inputs are never requested", async () => {
  const source = savedCatalogueSource(noCatalogues, { relationships: persistedFind(81189, [{ id: 1396 }]) }, noHistory);
  assert.deepEqual(await source.tmdbSeriesForTvdb(81189, { mandatory: true }), { outcome: "missing" });
});

test("the saved source reports a series' counted 404 days from the shared history and never counts one", async () => {
  const counted: string[] = [];
  const history = { countedDays: (provider: string, id: number) => { counted.push(`${provider}:${id}`); return provider === "tmdb" && id === 323094 ? 7 : 0; } };
  const source = savedCatalogueSource(noCatalogues, { relationships: {} }, history);
  assert.equal(source.seriesNotFoundDays("tmdb", 323094), 7);
  assert.equal(source.seriesNotFoundDays("tvdb", 323094), 0);
  assert.equal((await source.loadCatalogue("tmdb", 323094, { mandatory: true })).outcome, "failed", "a missing saved copy fails without a request");
  assert.deepEqual(counted, ["tmdb:323094", "tvdb:323094"], "only reads; loading records nothing");
});
