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
