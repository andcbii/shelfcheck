import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowPlexMissingEpisode } from "../lib/plex-airdate";

test("episodes without an air date are hidden when unaired episodes are hidden", () => {
  assert.equal(shouldShowPlexMissingEpisode(undefined, true, 0, "2026-08-09"), false);
});

test("episodes without an air date remain visible when unaired filtering is disabled", () => {
  assert.equal(shouldShowPlexMissingEpisode(undefined, false, 0, "2026-08-09"), true);
});

test("aired episodes become visible after the configured offset", () => {
  assert.equal(shouldShowPlexMissingEpisode("2026-08-08", true, 2, "2026-08-09"), false);
  assert.equal(shouldShowPlexMissingEpisode("2026-08-08", true, 2, "2026-08-10"), true);
});

test("invalid air dates are treated as unaired", () => {
  assert.equal(shouldShowPlexMissingEpisode("unknown", true, 0, "2026-08-09"), false);
});
