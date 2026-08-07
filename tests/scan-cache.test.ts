import assert from "node:assert/strict";
import test from "node:test";
import { canCacheAirDateResult, collectedEpisodeCount, collectionFingerprint, scanReason, shouldReportIncompleteEpisode, shouldSaveCheckpoint } from "../lib/scan-cache";

const collection = {
  show: { aired_episodes: 3 },
  seasons: [{
    number: 1,
    episodes: [
      { number: 2, collected_at: "2026-08-02T00:00:00.000Z" },
      { number: 1, collected_at: "2026-08-01T00:00:00.000Z" },
    ],
  }, { number: 0, episodes: [{ number: 1, collected_at: "2026-07-01T00:00:00.000Z" }] }],
};

test("collection fingerprint is stable when Trakt returns episodes in a different order", () => {
  const reordered = structuredClone(collection);
  reordered.seasons[0].episodes.reverse();
  assert.equal(collectionFingerprint(collection), collectionFingerprint(reordered));
});

test("collection fingerprint changes when the collected inventory changes", () => {
  const changed = structuredClone(collection);
  changed.seasons[0].episodes.pop();
  assert.notEqual(collectionFingerprint(collection), collectionFingerprint(changed));
});

test("collected episode count excludes specials", () => {
  assert.equal(collectedEpisodeCount(collection), 2);
});

test("quick scan reuses an unchanged cached result", () => {
  assert.equal(scanReason({ deep: false, gracePeriodChanged: false, cached: true, collectionChanged: false, airedChanged: false, traktUpdated: true }), null);
});

test("deep scan queues a show updated by Trakt", () => {
  assert.equal(scanReason({ deep: true, gracePeriodChanged: false, cached: true, collectionChanged: false, airedChanged: false, traktUpdated: true }), "trakt-updated");
});

test("collection, aired count, settings, and empty cache each force a refresh", () => {
  const base = { deep: false, gracePeriodChanged: false, cached: true, collectionChanged: false, airedChanged: false, traktUpdated: false };
  assert.equal(scanReason({ ...base, cached: false }), "new");
  assert.equal(scanReason({ ...base, collectionChanged: true }), "collection-changed");
  assert.equal(scanReason({ ...base, airedChanged: true }), "aired-changed");
  assert.equal(scanReason({ ...base, gracePeriodChanged: true }), "settings-changed");
});

test("deep scan applies air-date filtering even with a zero-day grace period", () => {
  assert.equal(shouldReportIncompleteEpisode(true, 0, false), false);
  assert.equal(shouldReportIncompleteEpisode(true, 0, true), true);
  assert.equal(shouldReportIncompleteEpisode(false, 0, false), true);
});

test("unknown air dates fail open instead of hiding incomplete episodes", () => {
  assert.equal(shouldReportIncompleteEpisode(true, 0, false, false), true);
  assert.equal(shouldReportIncompleteEpisode(true, 7, false, false), true);
  assert.equal(canCacheAirDateResult(true, false, 3), false);
  assert.equal(canCacheAirDateResult(true, true, 1), false);
  assert.equal(canCacheAirDateResult(true, true, 0), true);
});

test("checkpoint policy saves every ten shows or five seconds", () => {
  assert.equal(shouldSaveCheckpoint(9, 0, 4_999, 0), false);
  assert.equal(shouldSaveCheckpoint(10, 0, 1_000, 0), true);
  assert.equal(shouldSaveCheckpoint(2, 0, 5_000, 0), true);
});
