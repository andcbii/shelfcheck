import assert from "node:assert/strict";
import test from "node:test";
import { canCacheAirDateResult, collectedEpisodeCount, collectionFingerprint, scanReason, shouldSaveCheckpoint, traktResumePointIsUsable } from "../lib/scan-cache";
import type { TraktResumePoint } from "../lib/scan";

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

test("a result with an unknown or failed air date is not cacheable", () => {
  assert.equal(canCacheAirDateResult(true, false, 3), false);
  assert.equal(canCacheAirDateResult(true, true, 1), false);
  assert.equal(canCacheAirDateResult(true, true, 0), true);
});

test("checkpoint policy saves every ten shows or five seconds", () => {
  assert.equal(shouldSaveCheckpoint(9, 0, 4_999, 0), false);
  assert.equal(shouldSaveCheckpoint(10, 0, 1_000, 0), true);
  assert.equal(shouldSaveCheckpoint(2, 0, 5_000, 0), true);
});

test("a malformed stored Trakt Resume point is rejected, not trusted", () => {
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  const good = { shows: [], missing: [], lastScan: "", savedAt: "2026-11-11T11:00:00.000Z", resumePointVersion: 2, airingGraceDays: 0 };
  assert.equal(traktResumePointIsUsable(good, 0, now), true);
  // Stored values come from SQLite JSON, so their shape is not guaranteed.
  for (const stored of ["a string", 42, [], { ...good, savedAt: Date.parse(good.savedAt) }, { ...good, resumePointVersion: "2" }, { ...good, resumePointVersion: 1 }, { ...good, airingGraceDays: null }]) {
    assert.equal(traktResumePointIsUsable(stored as unknown as TraktResumePoint, 0, now), false, JSON.stringify(stored));
  }
});
