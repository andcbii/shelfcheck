import assert from "node:assert/strict";
import test from "node:test";
import { PLEX_SCAN_WORKERS, PROVIDER_REQUEST_SPACING_MS } from "../lib/plex-provider-policy";
import { hasPlexEpisodeCoordinate } from "../lib/plex-inventory";

test("Plex scans overlap three shows while retaining a single 200ms TVDB gate", () => {
  assert.equal(PLEX_SCAN_WORKERS, 3);
  assert.equal(PROVIDER_REQUEST_SPACING_MS.TVDB, 200);
});

test("season episode zero is a valid Plex coordinate", () => {
  assert.equal(hasPlexEpisodeCoordinate({ parentIndex: 1, index: 0 }), true);
});
