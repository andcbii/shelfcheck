import assert from "node:assert/strict";
import test from "node:test";
import type { CoverageIssue } from "../lib/coverage-issues";
import { isUnmatchedShow } from "../lib/plex-reporting";
import { shownScanIssues } from "../lib/scan-issues-shown";

const own = (ratingKey: string): CoverageIssue => ({ id: `catalogue-refresh:TMDB:${ratingKey}`, scope: "show", provider: "TMDB", operation: "catalogue-refresh", show: { ratingKey }, cause: "404 — record not found", action: "Check the Plex provider ID reference." });

test("a result saved before scans judged each provider is Unmatched by the legacy rule in both reports", () => {
  const legacy = { ratingKey: "ratingKey:1", providerResolution: { tmdb: false, tvdb: false } };
  const compared = { ratingKey: "ratingKey:2", providerResolution: { tmdb: true, tvdb: false } };
  assert.equal(isUnmatchedShow(legacy), true, "neither provider was compared");
  assert.equal(isUnmatchedShow(compared), false);
  assert.equal(isUnmatchedShow({ ratingKey: "ratingKey:3" }), false, "a result with no provider resolution is not listed");
  assert.equal(isUnmatchedShow({ ratingKey: "ratingKey:4", providerResolution: { tmdb: false, tvdb: false, status: "partially-matched" } }), false, "a judged status wins over the legacy rule");
  const shown = shownScanIssues([own("ratingKey:1"), own("ratingKey:2")], [legacy, compared]);
  assert.deepEqual(shown.map(issue => issue.id), ["catalogue-refresh:TMDB:ratingKey:2"], "the legacy Unmatched show's own entry is hidden too");
});
