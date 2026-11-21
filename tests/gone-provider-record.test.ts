import assert from "node:assert/strict";
import test from "node:test";
import { goneProviderRecord } from "../lib/plex-catalogue-policy";

const NOW = "2026-06-01T12:00:00.000Z";
const DAY = 86400_000;
const before = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

test("15 counted 404 days and a catalogue more than 60 days old is a Gone provider record", () => {
  assert.equal(goneProviderRecord({ seriesNotFoundDays: 15, downloadedAt: before(61 * DAY), now: NOW }), true);
  assert.equal(goneProviderRecord({ seriesNotFoundDays: 15, downloadedAt: before(60 * DAY + 1), now: NOW }), true);
  assert.equal(goneProviderRecord({ seriesNotFoundDays: 40, downloadedAt: before(400 * DAY), now: NOW }), true);
});

test("14 counted days, or 15 with a catalogue 60 days old or less, is not gone", () => {
  assert.equal(goneProviderRecord({ seriesNotFoundDays: 14, downloadedAt: before(400 * DAY), now: NOW }), false);
  assert.equal(goneProviderRecord({ seriesNotFoundDays: 15, downloadedAt: before(60 * DAY), now: NOW }), false);
  assert.equal(goneProviderRecord({ seriesNotFoundDays: 0, downloadedAt: before(400 * DAY), now: NOW }), false);
});

test("a series never downloaded has no catalogue age and is never gone", () => {
  assert.equal(goneProviderRecord({ seriesNotFoundDays: 30, downloadedAt: undefined, now: NOW }), false);
});
