import assert from "node:assert/strict";
import test from "node:test";

import { parsePlexPreferences, parsePlexPreferencesPatch, parseTraktPreferencesPatch } from "../lib/preferences";

test("Plex preferences reject unknown fields and clamp the air-date offset", () => {
  assert.deepEqual(parsePlexPreferences({ airingOffsetDays: 99, hideUnairedEpisodes: true, unexpected: "value" }), {
    ignoredShows: [],
    ignoredSeasons: [],
    hideUnairedEpisodes: true,
    airingOffsetDays: 30,
    autoCompoundEpisodes: true,
    diagnosticsEnabled: true,
  });
});

test("Plex preferences normalize ignored seasons", () => {
  const parsed = parsePlexPreferences({ ignoredSeasons: [
    { ratingKey: "plex://show/one", title: "One", seasons: [2, 1, 2, -1, 1.8] },
    { ratingKey: "plex://show/two", title: "Two", seasons: [] },
  ] });
  assert.deepEqual(parsed.ignoredSeasons, [{ ratingKey: "plex://show/one", title: "One", seasons: [1, 2] }]);
});

test("Plex preference patches preserve omitted fields", () => {
  assert.deepEqual(parsePlexPreferencesPatch({ hideUnairedEpisodes: true }), { hideUnairedEpisodes: true });
});

test("Plex preferences reject non-finite offsets", () => {
  assert.equal(parsePlexPreferences({ airingOffsetDays: Number.NaN }).airingOffsetDays, 0);
  assert.equal(parsePlexPreferences({ airingOffsetDays: Number.POSITIVE_INFINITY }).airingOffsetDays, 0);
});

test("Trakt preference patches retain only supported settings", () => {
  assert.deepEqual(parseTraktPreferencesPatch({ airingGraceDays: -2, diagnosticsEnabled: false, scan: { status: "running" } }), {
    airingGraceDays: 0,
    diagnosticsEnabled: false,
  });
});

test("Trakt preference patches normalize ignored seasons", () => {
  assert.deepEqual(parseTraktPreferencesPatch({ ignoredSeasons: [
    { traktId: 12, title: "One", seasons: [3, 1, 3, -1] },
    { traktId: 13, title: "Two", seasons: [] },
  ] }), { ignoredSeasons: [{ traktId: 12, title: "One", seasons: [1, 3] }] });
});

test("Plex ignore timing survives JSON serialization and repeated preference reads without renewal", () => {
  const expiresAt = "2027-02-28T18:23:45.678Z";
  const preferences = { ignoredShows: [
    { ratingKey: "plex://show/temporary", title: "Temporary", duration: "6m", expiresAt },
    { ratingKey: "plex://show/legacy", title: "Legacy" },
    { ratingKey: "plex://show/forever", title: "Forever", duration: "forever" },
  ], ignoredSeasons: [
    { ratingKey: "plex://show/temporary", title: "Temporary", seasons: [2, 1], duration: "90d", expiresAt },
  ] };
  const loaded = parsePlexPreferences(JSON.parse(JSON.stringify(preferences)));
  assert.deepEqual(loaded.ignoredShows, preferences.ignoredShows);
  assert.deepEqual(loaded.ignoredSeasons, [{ ...preferences.ignoredSeasons[0], seasons: [1, 2] }]);
  assert.deepEqual(parsePlexPreferences(JSON.parse(JSON.stringify(loaded))), loaded);
});

test("Trakt whole-show and season timing survives JSON serialization without renewal", () => {
  const expiresAt = "2027-02-28T18:23:45.678Z";
  const preferences = { ignoredShows: [
    { title: "Temporary", year: 2026, ids: { trakt: 12, slug: "temporary" }, duration: "30d", expiresAt },
    { title: "Legacy", year: 2026, ids: { trakt: 13, slug: "legacy" } },
    { title: "Forever", year: 2026, ids: { trakt: 14, slug: "forever" }, duration: "forever" },
  ], ignoredSeasons: [
    { traktId: 12, title: "Temporary", seasons: [2, 1], duration: "6m", expiresAt },
  ] };
  const loaded = parseTraktPreferencesPatch(JSON.parse(JSON.stringify(preferences)));
  assert.deepEqual(loaded.ignoredShows, preferences.ignoredShows);
  assert.deepEqual(loaded.ignoredSeasons, [{ ...preferences.ignoredSeasons[0], seasons: [1, 2] }]);
  assert.deepEqual(parseTraktPreferencesPatch(JSON.parse(JSON.stringify(loaded))), loaded);
});

test("malformed Plex expiry values cannot turn temporary ignores into permanent ignores", () => {
  for (const expiresAt of ["invalid", "", null, 123]) {
    const parsed = parsePlexPreferences({
      ignoredShows: [{ ratingKey: "plex://show/one", title: "One", expiresAt }],
      ignoredSeasons: [{ ratingKey: "plex://show/one", title: "One", seasons: [1], expiresAt }],
    });
    assert.deepEqual(parsed.ignoredShows, []);
    assert.deepEqual(parsed.ignoredSeasons, []);
  }
});

test("malformed Trakt expiry values cannot turn temporary ignores into permanent ignores", () => {
  for (const expiresAt of ["invalid", "", null, 123]) {
    const parsed = parseTraktPreferencesPatch({
      ignoredShows: [{ title: "One", year: 2026, ids: { trakt: 12, slug: "one" }, expiresAt }],
      ignoredSeasons: [{ traktId: 12, title: "One", seasons: [1], expiresAt }],
    });
    assert.deepEqual(parsed, { ignoredShows: [], ignoredSeasons: [] });
  }
});

test("preference patches preserve a supplied absolute expiry when the season selection changes", () => {
  const expiresAt = "2027-02-28T18:23:45.678Z";
  const timing = { duration: "90d", expiresAt };
  assert.deepEqual(parsePlexPreferencesPatch({ ignoredSeasons: [
    { ratingKey: "plex://show/one", title: "One", seasons: [3, 2], ...timing },
  ] }), { ignoredSeasons: [{ ratingKey: "plex://show/one", title: "One", seasons: [2, 3], ...timing }] });
  assert.deepEqual(parseTraktPreferencesPatch({ ignoredSeasons: [
    { traktId: 12, title: "One", seasons: [3, 2], ...timing },
  ] }), { ignoredSeasons: [{ traktId: 12, title: "One", seasons: [2, 3], ...timing }] });
});

test("an absent deadline stays permanent and an unfamiliar duration cannot discard a valid deadline", () => {
  const expiresAt = "2027-02-28T18:23:45.678Z";
  assert.deepEqual(parsePlexPreferences({ ignoredShows: [
    { ratingKey: "legacy", title: "Legacy", duration: "30d" },
    { ratingKey: "temporary", title: "Temporary", duration: "unrecognized", expiresAt },
  ] }).ignoredShows, [
    { ratingKey: "legacy", title: "Legacy", duration: "forever" },
    { ratingKey: "temporary", title: "Temporary", expiresAt },
  ]);
  assert.deepEqual(parseTraktPreferencesPatch({ ignoredSeasons: [
    { traktId: 12, title: "Legacy", seasons: [1], duration: "30d" },
    { traktId: 13, title: "Temporary", seasons: [2], duration: "unrecognized", expiresAt },
  ] }).ignoredSeasons, [
    { traktId: 12, title: "Legacy", seasons: [1], duration: "forever" },
    { traktId: 13, title: "Temporary", seasons: [2], expiresAt },
  ]);
});
