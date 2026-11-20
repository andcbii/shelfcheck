import assert from "node:assert/strict";
import test from "node:test";
import { applyIgnore, changeIgnoreDuration, decodePlexManagerKey, decodeTraktManagerKey, ignoreManagerKey, restoreIgnore, type IgnoreTiming } from "../lib/ignored-shows";

const NOW = Date.parse("2026-03-07T18:00:00.000Z");
const PAST = "2026-03-07T17:59:59.999Z";
const FUTURE = "2026-04-01T00:00:00.000Z";

type TraktShow = { title: string; ids: { trakt: number; slug?: string } };
type IgnoredTraktShow = TraktShow & IgnoreTiming;
type TraktSeasons = { traktId: number; title: string; seasons: number[]; expiresAt?: string; duration?: "30d" | "90d" | "6m" | "forever" };
type PlexShow = { ratingKey: string; title: string; expiresAt?: string; duration?: "30d" | "90d" | "6m" | "forever" };
type PlexSeasons = PlexShow & { seasons: number[] };

const traktShowKey = (show: TraktShow) => show.ids.trakt;
const traktSeasonsKey = (rule: TraktSeasons) => rule.traktId;
const plexKey = (rule: { ratingKey: string }) => rule.ratingKey;

function frozen<T>(value: T): T {
  return structuredClone(value);
}

test("applying a Trakt whole-show ignore replaces only that show, drops expired entries and sorts by title", () => {
  const rules: IgnoredTraktShow[] = [
    { title: "Zeta", ids: { trakt: 9 }, duration: "forever" },
    { title: "Expired", ids: { trakt: 3 }, duration: "30d", expiresAt: PAST },
    { title: "Old Name", ids: { trakt: 5 }, duration: "forever" },
    { title: "Alpha", ids: { trakt: 1 }, duration: "90d", expiresAt: FUTURE },
  ];
  const before = frozen(rules);
  const next = applyIgnore(rules, traktShowKey, { title: "Middle", ids: { trakt: 5, slug: "middle" } }, "30d", NOW);
  assert.deepEqual(next, [
    { title: "Alpha", ids: { trakt: 1 }, duration: "90d", expiresAt: FUTURE },
    { title: "Middle", ids: { trakt: 5, slug: "middle" }, duration: "30d", expiresAt: "2026-04-06T18:00:00.000Z" },
    { title: "Zeta", ids: { trakt: 9 }, duration: "forever" },
  ]);
  assert.deepEqual(rules, before);
});

test("applying a Plex whole-show ignore compares string keys exactly and Forever has no expiry", () => {
  const rules: PlexShow[] = [
    { ratingKey: "12", title: "Twelve", duration: "forever" },
    { ratingKey: "012", title: "Zero Twelve", duration: "30d", expiresAt: FUTURE },
  ];
  const before = frozen(rules);
  const next = applyIgnore(rules, plexKey, { ratingKey: "12", title: "Twelve again" }, "forever", NOW);
  assert.deepEqual(next, [
    { ratingKey: "12", title: "Twelve again", duration: "forever" },
    { ratingKey: "012", title: "Zero Twelve", duration: "30d", expiresAt: FUTURE },
  ]);
  assert.deepEqual(rules, before);
});

test("Restore removes only the matching rule of that kind and drops expired entries", () => {
  const shows: IgnoredTraktShow[] = [
    { title: "Alpha", ids: { trakt: 1 }, duration: "forever" },
    { title: "Beta", ids: { trakt: 2 }, duration: "30d", expiresAt: PAST },
    { title: "Gamma", ids: { trakt: 3 }, duration: "90d", expiresAt: FUTURE },
  ];
  const seasons: TraktSeasons[] = [
    { traktId: 1, title: "Alpha", seasons: [1, 2], duration: "forever" },
    { traktId: 3, title: "Gamma", seasons: [0], expiresAt: FUTURE },
  ];
  const before = frozen({ shows, seasons });
  assert.deepEqual(restoreIgnore(shows, traktShowKey, 1, NOW), [{ title: "Gamma", ids: { trakt: 3 }, duration: "90d", expiresAt: FUTURE }]);
  assert.deepEqual(restoreIgnore(seasons, traktSeasonsKey, 3, NOW), [{ traktId: 1, title: "Alpha", seasons: [1, 2], duration: "forever" }]);
  assert.deepEqual({ shows, seasons }, before);
});

test("Plex Restore keeps a numeric-looking string key distinct from a number", () => {
  const seasons: PlexSeasons[] = [{ ratingKey: "7", title: "Seven", seasons: [1] }];
  assert.deepEqual(restoreIgnore(seasons, plexKey, "07", NOW), seasons);
  assert.deepEqual(restoreIgnore(seasons, plexKey, "7", NOW), []);
});

test("an expiry equal to the clock value has ended", () => {
  const rules: PlexShow[] = [{ ratingKey: "a", title: "A", duration: "30d", expiresAt: new Date(NOW).toISOString() }];
  assert.deepEqual(restoreIgnore(rules, plexKey, "other", NOW), []);
  assert.deepEqual(restoreIgnore(rules, plexKey, "other", NOW - 1), rules);
});

test("Change duration always starts a new timing, even for the same duration", () => {
  const seasons: TraktSeasons[] = [
    { traktId: 4, title: "Delta", seasons: [2], duration: "30d", expiresAt: FUTURE },
    { traktId: 5, title: "Echo", seasons: [1], duration: "30d", expiresAt: FUTURE },
    { traktId: 6, title: "Gone", seasons: [1], duration: "30d", expiresAt: PAST },
  ];
  const before = frozen(seasons);
  assert.deepEqual(changeIgnoreDuration(seasons, traktSeasonsKey, 4, "30d", NOW), [
    { traktId: 4, title: "Delta", seasons: [2], duration: "30d", expiresAt: "2026-04-06T18:00:00.000Z" },
    { traktId: 5, title: "Echo", seasons: [1], duration: "30d", expiresAt: FUTURE },
  ]);
  assert.deepEqual(seasons, before);
});

test("Change duration to Forever clears the expiry, including a legacy expiry with no duration", () => {
  const shows: PlexShow[] = [{ ratingKey: "x|y", title: "Legacy", expiresAt: FUTURE }];
  const [changed] = changeIgnoreDuration(shows, plexKey, "x|y", "forever", NOW);
  assert.equal(changed.expiresAt, undefined);
  assert.equal(JSON.stringify(changed), JSON.stringify({ ratingKey: "x|y", title: "Legacy", duration: "forever" }));
  assert.deepEqual(shows, [{ ratingKey: "x|y", title: "Legacy", expiresAt: FUTURE }]);
});

test("Change duration of a Trakt whole-show ignore reads ids.trakt", () => {
  const shows: IgnoredTraktShow[] = [{ title: "Alpha", ids: { trakt: 1 }, duration: "forever" }];
  assert.deepEqual(changeIgnoreDuration(shows, traktShowKey, 1, "90d", NOW), [{ title: "Alpha", ids: { trakt: 1 }, duration: "90d", expiresAt: "2026-06-05T18:00:00.000Z" }]);
});

test("Trakt manager keys round-trip to numeric show and seasons targets", () => {
  assert.equal(ignoreManagerKey("show", 42), "show|42");
  assert.equal(ignoreManagerKey("seasons", 42), "seasons|42");
  assert.deepEqual(decodeTraktManagerKey(ignoreManagerKey("show", 42)), { kind: "show", key: 42 });
  assert.deepEqual(decodeTraktManagerKey(ignoreManagerKey("seasons", 42)), { kind: "seasons", key: 42 });
});

test("Plex manager keys keep the full suffix as a string, including | and numeric-looking keys", () => {
  assert.deepEqual(decodePlexManagerKey(ignoreManagerKey("show", "plex://show|a|b")), { kind: "show", key: "plex://show|a|b" });
  assert.deepEqual(decodePlexManagerKey(ignoreManagerKey("seasons", "plex://show|a|b")), { kind: "seasons", key: "plex://show|a|b" });
  assert.deepEqual(decodePlexManagerKey(ignoreManagerKey("show", "0012")), { kind: "show", key: "0012" });
  assert.deepEqual(decodePlexManagerKey(ignoreManagerKey("seasons", "12")), { kind: "seasons", key: "12" });
});

test("an unknown manager key prefix decodes to nothing", () => {
  for (const key of ["episode|1", "shows|1", "1", 7, ""]) {
    assert.equal(decodeTraktManagerKey(key), null);
    assert.equal(decodePlexManagerKey(key), null);
  }
});
