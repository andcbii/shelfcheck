import assert from "node:assert/strict";
import test from "node:test";

import { checkpointIsUsable, mergeScanProgress, PLEX_CACHE_VERSION, pruneEpisodeIdentityCache } from "../lib/plex-scan-cache";

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
