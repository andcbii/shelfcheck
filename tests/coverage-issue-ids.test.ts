import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPARISON_PENDING_ISSUE, INITIAL_COMPARISON_INPUTS_ISSUE, SCAN_FAILURE_ISSUE, TRAKT_AUTHENTICATION_ISSUE, TVDB_AUTHENTICATION_ISSUE,
  comparisonFailureIssueId, comparisonInputsIssueId, inventoryDetailsIssueId, plexInventoryIssueId,
  catalogueIssueIds, catalogueRecordIssueId, episodeCheckIssueId, episodeCheckPrefix, episodeCheckShowPrefix, episodeCheckTvdbEpisodePrefix,
  lookupFailureIssueId, titleRecoveryIssueId, providerVerificationIssueId,
} from "../lib/coverage-issue-ids";

// Every expected value is written out: these are the stored IDs and cause links saved by earlier
// versions, so a constructor that changes them would orphan saved Coverage Issues.

test("library-wide Coverage Issue IDs keep their saved text", () => {
  assert.equal(SCAN_FAILURE_ISSUE, "scan-failure");
  assert.equal(TVDB_AUTHENTICATION_ISSUE, "provider-authentication:TVDB");
  assert.equal(TRAKT_AUTHENTICATION_ISSUE, "provider-authentication:Trakt");
  assert.equal(INITIAL_COMPARISON_INPUTS_ISSUE, "comparison-inputs:initial");
  assert.equal(COMPARISON_PENDING_ISSUE, "comparison-pending");
  assert.equal(providerVerificationIssueId("TMDB"), "provider-verification:TMDB");
  assert.equal(providerVerificationIssueId("TVDB"), "provider-verification:TVDB");
});

test("show-scoped Coverage Issue IDs keep their saved text, including rating keys with colons", () => {
  assert.equal(plexInventoryIssueId("tvdb:81189", "4412"), "inventory:tvdb:81189:4412");
  assert.equal(plexInventoryIssueId("4412", "4412"), "inventory:4412:4412");
  assert.equal(plexInventoryIssueId("tvdb:81189", undefined), "inventory:tvdb:81189:undefined", "a record without a rating key keeps its saved text");
  assert.equal(inventoryDetailsIssueId("4412"), "inventory-details:4412");
  assert.equal(inventoryDetailsIssueId("tmdb:1396|tvdb:81189"), "inventory-details:tmdb:1396|tvdb:81189");
  assert.equal(comparisonInputsIssueId("4412"), "comparison-inputs:4412");
  assert.equal(comparisonInputsIssueId("tvdb:81189"), "comparison-inputs:tvdb:81189");
  assert.equal(comparisonFailureIssueId("4412"), "comparison-failure:4412");
  assert.equal(comparisonFailureIssueId("tvdb:81189"), "comparison-failure:tvdb:81189");
});

test("a show's catalogue refresh and fallback refresh IDs name the provider and the show", () => {
  assert.deepEqual(catalogueIssueIds("tmdb", "4412"), { refreshId: "catalogue-refresh:TMDB:4412", fallbackId: "catalogue-fallback-refresh:TMDB:4412" });
  assert.deepEqual(catalogueIssueIds("tvdb", "tvdb:81189"), { refreshId: "catalogue-refresh:TVDB:tvdb:81189", fallbackId: "catalogue-fallback-refresh:TVDB:tvdb:81189" });
});

test("a failed lookup's episode-identity ID wraps the lookup's stored key unchanged", () => {
  assert.equal(lookupFailureIssueId("4412", { kind: "tmdb-episode-by-tvdb-episode", tvdbEpisodeId: 349232 }), "episode-identity:4412:tmdb-episode-by-tvdb:349232");
  assert.equal(lookupFailureIssueId("tvdb:81189", { kind: "tmdb-series-by-tvdb-series", tvdbSeriesId: 81189 }), "episode-identity:tvdb:81189:tmdb-series-by-tvdb:81189");
  assert.equal(lookupFailureIssueId("4412", { kind: "tmdb-episode-by-show-season-episode", tmdbShowId: 1396, season: 0, episode: 3 }), "episode-identity:4412:tmdb-episode:1396:0:3");
  assert.equal(lookupFailureIssueId("4412", { kind: "tvdb-episode-extended", tvdbEpisodeId: 349232 }), "episode-identity:4412:tvdb-episode-extended:349232");
  assert.equal(lookupFailureIssueId("4412", { kind: "trakt-episode-search-by-tvdb-episode", tvdbEpisodeId: 349232 }), "episode-identity:4412:trakt-episode-by-tvdb:349232");
});

test("an episode check's ID names the show, operation, method or crosswalk and the provider episode", () => {
  assert.equal(episodeCheckIssueId("4412", { operation: "compound-matching", episode: { provider: "TVDB", id: 349232 } }), "episode-check:4412:compound-matching:TVDB:349232");
  assert.equal(episodeCheckIssueId("tvdb:81189", { operation: "episode-decision", method: "report-missing", episode: { provider: "TMDB", id: 62085 } }), "episode-check:tvdb:81189:episode-decision:report-missing:TMDB:62085");
  assert.equal(episodeCheckIssueId("4412", { operation: "episode-crosswalk", crosswalk: "IMDb", episode: { provider: "TVDB", id: 349232 } }), "episode-check:4412:episode-crosswalk:IMDb:TVDB:349232");
  assert.equal(titleRecoveryIssueId("tvdb:81189", 349232), "episode-check:tvdb:81189:title-recovery:TVDB:349232");
});

test("an episode check without a provider or episode ID falls back to Provider and its numbering", () => {
  assert.equal(episodeCheckIssueId("4412", { operation: "episode-decision", method: "coordinates", episode: { season: 2, episode: 5 } }), "episode-check:4412:episode-decision:coordinates:Provider:2x5");
  assert.equal(episodeCheckIssueId("4412", { operation: "auto-match-record", episode: { provider: "TVDB", season: 0, episode: 1 } }), "episode-check:4412:auto-match-record:TVDB:0x1");
  assert.equal(episodeCheckIssueId("4412", { operation: "auto-match-record", episode: {} }), "episode-check:4412:auto-match-record:Provider:undefinedxundefined");
});

test("a malformed catalogue record's ID uses its identity, else its numbering, else its response position", () => {
  assert.equal(catalogueRecordIssueId("4412", { provider: "TVDB", showId: 81189, position: "episode 3", id: 349232, problem: "no-numbering" }), "episode-check:4412:catalogue-record:TVDB:81189:349232");
  assert.equal(catalogueRecordIssueId("tvdb:81189", { provider: "TMDB", showId: 1396, position: "episode 3", season: 1, episode: 4, problem: "no-identity" }), "episode-check:tvdb:81189:catalogue-record:TMDB:1396:S1E4");
  assert.equal(catalogueRecordIssueId("4412", { provider: "TMDB", showId: 1396, position: "season 1 episode 3", problem: "no-identity-or-numbering" }), "episode-check:4412:catalogue-record:TMDB:1396:season 1 episode 3");
});

test("episode-check family prefixes keep their trailing delimiter", () => {
  assert.equal(episodeCheckShowPrefix("4412"), "episode-check:4412:");
  assert.equal(episodeCheckShowPrefix("tvdb:81189"), "episode-check:tvdb:81189:");
  assert.equal(episodeCheckPrefix("4412", { operation: "compound-matching" }), "episode-check:4412:compound-matching:");
  assert.equal(episodeCheckPrefix("4412", { operation: "episode-decision", method: "manual-match" }), "episode-check:4412:episode-decision:manual-match:");
  assert.equal(episodeCheckTvdbEpisodePrefix("tvdb:81189", { operation: "episode-crosswalk", crosswalk: "Trakt" }), "episode-check:tvdb:81189:episode-crosswalk:Trakt:TVDB:");
});
