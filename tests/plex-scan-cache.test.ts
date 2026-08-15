import assert from "node:assert/strict";
import test from "node:test";

import { checkpointIsUsable, checkpointShowsWithCache, checkpointWithoutRatingKey, mergeScanProgress, plexReportCacheIsUsable, PLEX_CACHE_VERSION, pruneEpisodeIdentityCache, targetedScanCarryOver } from "../lib/plex-scan-cache";

test("Plex checkpoints require matching settings and must be fresh", () => {
  const now = Date.parse("2026-08-09T12:00:00Z");
  const checkpoint = { cacheVersion: PLEX_CACHE_VERSION, autoCompoundEpisodes: true, savedAt: "2026-08-09T11:00:00Z" };
  assert.equal(checkpointIsUsable(checkpoint, true, now), true);
  assert.equal(checkpointIsUsable(checkpoint, false, now), false);
  assert.equal(checkpointIsUsable({ ...checkpoint, savedAt: "2026-08-09T01:00:00Z" }, true, now), false);
});

test("IMDb identity cache retains only current TVDB episode IDs", () => {
  assert.deepEqual(pruneEpisodeIdentityCache({ "1": ["tt1"], "2": ["tt2"] }, [2, 3]), { "2": ["tt2"] });
});

test("heartbeat-style progress updates retain an active provider rate-limit pause", () => {
  const current = { status: "running", processed: 1, heartbeatAt: "now", rateLimitPaused: true, rateLimitProvider: "TVDB" };
  assert.deepEqual(mergeScanProgress(current, { processed: 2, heartbeatAt: "later" }), { ...current, processed: 2, heartbeatAt: "later" });
});

test("checkpoints retain only shows with a matching cache entry", () => {
  const shows = [{ ratingKey: "good" }, { ratingKey: "warned" }];
  assert.deepEqual(checkpointShowsWithCache(shows, { good: { fingerprint: "ok" } }), [{ ratingKey: "good" }]);
});

test("targeted scans require a compatible cache", () => {
  assert.throws(() => targetedScanCarryOver({ cacheUsable: false, shows: [], cache: {}, currentIdentities: new Set(["target"]), targetRatingKey: "target" }), /full Plex search/);
});

test("Plex report cache compatibility includes version and compound settings", () => {
  const report = { cacheVersion: PLEX_CACHE_VERSION, autoCompoundEpisodes: true, scanCache: { show: {} } };
  assert.equal(plexReportCacheIsUsable(report, PLEX_CACHE_VERSION, true), true);
  assert.equal(plexReportCacheIsUsable(report, PLEX_CACHE_VERSION, false), false);
  assert.equal(plexReportCacheIsUsable(report, PLEX_CACHE_VERSION + 1, true), false);
});

test("targeted scans carry only current non-target shows and cache entries", () => {
  const carried = targetedScanCarryOver({
    cacheUsable: true,
    shows: [{ ratingKey: "target" }, { ratingKey: "current" }, { ratingKey: "deleted" }],
    cache: { target: { value: 1 }, current: { value: 2 }, deleted: { value: 3 } },
    currentIdentities: new Set(["target", "current"]),
    targetRatingKey: "target",
  });
  assert.deepEqual(carried, { shows: [{ ratingKey: "current" }], cache: { current: { value: 2 } } });
});

test("targeted scans remove their stale checkpoint result", () => {
  const checkpoint = { shows: [{ ratingKey: "target" }, { ratingKey: "other" }], scanCache: { target: { value: 1 }, other: { value: 2 } }, savedAt: "now" };
  assert.deepEqual(checkpointWithoutRatingKey(checkpoint, "target"), { shows: [{ ratingKey: "other" }], scanCache: { other: { value: 2 } }, savedAt: "now" });
  assert.equal(checkpointWithoutRatingKey({ shows: [{ ratingKey: "target" }], scanCache: { target: { value: 1 } } }, "target"), null);
});
