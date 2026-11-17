import assert from "node:assert/strict";
import test from "node:test";
import { multipleProviderIdEntries, selectionSummary } from "../lib/multiple-provider-ids-report";
import type { ProviderCatalogueSelection, ShowCatalogueSelection } from "../lib/catalogue-selection-store";

const single = (id: number): ProviderCatalogueSelection => ({ candidates: [{ id }], automaticId: id, preferredId: id, current: { preferredId: id, usingId: id, state: "preferred", selectedAt: "2026-01-01T00:00:00Z" } });
const scooby = (tmdb: Partial<ProviderCatalogueSelection> = {}): ShowCatalogueSelection => ({
  tmdb: { candidates: [{ id: 2150, name: "The Scooby-Doo/Dynomutt Hour" }, { id: 337142, name: "The Scooby-Doo Show" }], automaticId: 2150, preferredId: 2150,
    current: { preferredId: 2150, usingId: 2150, state: "preferred", selectedAt: "2026-01-01T00:00:00Z" }, ...tmdb },
  tvdb: single(73817),
});

test("lists every scanned show with several IDs on either provider, collected or not, by title", () => {
  const entries = multipleProviderIdEntries({
    selections: { "plex://show/b": scooby(), "ratingKey:2": { tmdb: single(5), tvdb: { ...single(7), candidates: [{ id: 7 }, { id: 8 }] } }, "ratingKey:3": { tmdb: single(9), tvdb: single(10) }, "ratingKey:gone": scooby() },
    shows: [
      { ratingKey: "plex://show/b", title: "Scooby", year: 1976, providerMatches: { tmdb: [{ id: 2150, name: "Dynomutt", year: 1976 }], tvdb: [{ id: 73817, name: "TVDB Scooby", slug: "the-scooby-doo-show" }] } },
      { ratingKey: "ratingKey:2", title: "Animaniacs" },
      { ratingKey: "ratingKey:3", title: "Single" },
    ],
    issues: [],
  });
  assert.deepEqual(entries.map(entry => [entry.identity, entry.title]), [["ratingKey:2", "Animaniacs"], ["plex://show/b", "Scooby"]], "a show no longer scanned is not listed");
  const tmdb = entries[1].panels.tmdb;
  assert.equal(tmdb.hasMultipleIds, true);
  assert.deepEqual(tmdb.candidates.map(candidate => [candidate.id, candidate.name, candidate.year, candidate.href, candidate.automatic]), [
    [2150, "The Scooby-Doo/Dynomutt Hour", 1976, "https://www.themoviedb.org/tv/2150", true],
    [337142, "The Scooby-Doo Show", undefined, "https://www.themoviedb.org/tv/337142", false],
  ]);
  assert.equal(entries[1].panels.tvdb.hasMultipleIds, false);
  assert.equal(entries[1].panels.tvdb.candidates[0].href, "https://thetvdb.com/series/the-scooby-doo-show");
  assert.equal(entries[0].panels.tvdb.candidates[1].href, "https://thetvdb.com/dereferrer/series/8");
});

test("attaches the show's catalogue and comparison Coverage Issues", () => {
  const issue = (id: string, ratingKey: string, scope: "show" | "episode" = "show") => ({ id, operation: id.split(":")[0].replace("comparison-inputs", "comparison"), scope, cause: "c", action: "a", show: { ratingKey } });
  const [entry] = multipleProviderIdEntries({ selections: { "ratingKey:1": scooby() }, shows: [{ ratingKey: "ratingKey:1", title: "S" }],
    issues: [issue("catalogue-refresh:TMDB:ratingKey:1", "ratingKey:1"), issue("comparison-inputs:ratingKey:1", "ratingKey:1"), issue("episode-identity:x", "ratingKey:1", "episode"), issue("catalogue-refresh:TMDB:ratingKey:2", "ratingKey:2")] });
  assert.deepEqual(entry.issues.map(issue => issue.id), ["catalogue-refresh:TMDB:ratingKey:1", "comparison-inputs:ratingKey:1"]);
});

test("the automatic choice is described as automatic, not as the user's choice", () => {
  assert.deepEqual(selectionSummary("tmdb", scooby().tmdb), {
    using: "The Scooby-Doo/Dynomutt Hour (2150)",
    preference: "Automatic: The Scooby-Doo/Dynomutt Hour (2150), the lowest ID",
  });
});

test("a fallback keeps the saved preference and explains why it is not in use", () => {
  const summary = selectionSummary("tmdb", scooby({ override: 337142, preferredId: 337142,
    current: { preferredId: 337142, usingId: 2150, state: "fallback", selectedAt: "2026-03-04T00:00:00Z", preferredDownloadedAt: "2026-01-01T12:00:00Z", preferredUsableUntil: "2026-03-02T12:00:00Z", preferredFailedAt: "2026-03-04T00:00:00Z" } }).tmdb);
  assert.equal(summary.preference, "Override: The Scooby-Doo Show (337142)");
  assert.equal(summary.using, "Fallback: The Scooby-Doo/Dynomutt Hour (2150)");
  assert.equal(summary.explanation, "Preferred: 337142 · Currently using: 2150 · 337142 unavailable; saved catalogue expired 2026-03-02.");
});

test("saved data of an unavailable series shows its last download and 60-day deadline", () => {
  const summary = selectionSummary("tmdb", scooby({ override: 337142, preferredId: 337142,
    current: { preferredId: 337142, usingId: 337142, state: "saved-unavailable", selectedAt: "2026-01-03T00:00:00Z", preferredDownloadedAt: "2026-01-01T12:00:00Z", preferredUsableUntil: "2026-03-02T12:00:00Z", preferredFailedAt: "2026-01-03T00:00:00Z" } }).tmdb);
  assert.equal(summary.using, "Saved catalogue: The Scooby-Doo Show (337142)");
  assert.equal(summary.explanation, "337142 could not be loaded; its saved catalogue is in use. Last successful download 2026-01-01 · usable until 2026-03-02.");
});

test("a preference not yet compared says which catalogue results still use", () => {
  const summary = selectionSummary("tmdb", scooby({ override: 337142, preferredId: 337142 }).tmdb);
  assert.equal(summary.using, "The Scooby-Doo/Dynomutt Hour (2150)");
  assert.equal(summary.explanation, "337142 has not been compared yet; results use 2150 until the next Plex scan downloads it.");
});

test("no usable catalogue is reported without claiming a comparison", () => {
  const summary = selectionSummary("tmdb", scooby({ current: { preferredId: 2150, state: "unavailable", selectedAt: "2026-01-01T00:00:00Z", preferredFailedAt: "2026-01-01T00:00:00Z" } }).tmdb);
  assert.equal(summary.using, "None");
  assert.equal(summary.explanation, "No reported TMDB series could supply a usable catalogue; last-good results are kept.");
});
