import assert from "node:assert/strict";
import test from "node:test";
import { hasMultipleProviderMatches } from "../lib/plex-reporting";

test("reports one Plex show linked to multiple TMDB series", () => {
  assert.equal(hasMultipleProviderMatches({ plexGuids: ["plex://show/animaniacs"], providerMatches: { tmdb: [{ id: 82 }, { id: 107124 }], tvdb: [{ id: 72879 }] } }), true);
});

test("reports multiple Plex shows converging on one provider pair", () => {
  assert.equal(hasMultipleProviderMatches({ plexGuids: ["plex://show/baseball", "plex://show/tenth-inning"], providerMatches: { tmdb: [{ id: 19215 }], tvdb: [{ id: 81381 }] } }), true);
});

test("omits an ordinary one-to-one provider match", () => {
  assert.equal(hasMultipleProviderMatches({ plexGuids: ["plex://show/example"], providerMatches: { tmdb: [{ id: 1 }], tvdb: [{ id: 2 }] } }), false);
});
