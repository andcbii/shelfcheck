import assert from "node:assert/strict";
import test from "node:test";

import { parsePlexPreferences, parseTraktPreferencesPatch } from "../lib/preferences";

test("Plex preferences reject unknown fields and clamp the air-date offset", () => {
  assert.deepEqual(parsePlexPreferences({ airingOffsetDays: 99, hideUnairedEpisodes: true, unexpected: "value" }), {
    ignoredShows: [],
    hideUnairedEpisodes: true,
    airingOffsetDays: 30,
    autoCompoundEpisodes: true,
    diagnosticsEnabled: true,
  });
});

test("Trakt preference patches retain only supported settings", () => {
  assert.deepEqual(parseTraktPreferencesPatch({ airingGraceDays: -2, diagnosticsEnabled: false, scan: { status: "running" } }), {
    airingGraceDays: 0,
    diagnosticsEnabled: false,
  });
});
