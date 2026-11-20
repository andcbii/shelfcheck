import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoverageIssue } from "../lib/coverage-issues";
import type { PlexShowResult } from "../lib/plex-scan";
// The report components import types from server-only modules.
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { UnmatchedShowReport } = await import("../app/reports/components/unmatched-show-report");
const { CoverageIssueReport } = await import("../app/reports/components/coverage-issue-report");
hook.deregister();

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("an Unmatched Shows row gives each provider's cause", () => {
  const show: PlexShowResult = {
    ratingKey: "ratingKey:1", title: "The Adventures of Young Indiana Jones", plexEpisodes: 3, missing: [], tmdbId: 323094, tvdbId: 82643,
    providerResolution: { tmdb: false, tvdb: false, status: "unmatched", providers: {
      tmdb: { state: "total-failure", catalogue: "none", cause: "404 — record not found" },
      tvdb: { state: "total-failure", catalogue: "none", cause: "TVDB network request failed" },
    } },
  };
  const row = text(renderToStaticMarkup(createElement(UnmatchedShowReport, { shows: [show] })));
  assert.match(row, /TMDB lookup 404 — record not found/);
  assert.match(row, /TVDB lookup TVDB network request failed/);

  const tmdbOnly = text(renderToStaticMarkup(createElement(UnmatchedShowReport, { shows: [{ ...show, tvdbId: undefined, providerResolution: { tmdb: false, tvdb: false, status: "unmatched", providers: { tmdb: show.providerResolution!.providers!.tmdb, tvdb: { state: "no-series" } } } }] })));
  assert.match(tmdbOnly, /TVDB lookup No TVDB series ID from Plex or TMDB/);
});

test("a failing multi-ID provider's Scan Issues entry lists each candidate's ID and cause", () => {
  const issue: CoverageIssue = {
    id: "catalogue-refresh:TMDB:ratingKey:1", scope: "show", provider: "TMDB", operation: "catalogue-refresh", category: "Provider Lookup", show: { title: "Example", tmdbId: 100 },
    cause: "404 — record not found", action: "Check the Plex provider ID reference.",
    candidates: [{ id: 100, cause: "404 — record not found" }, { id: 20, cause: "TMDB network request failed" }],
  };
  const entry = text(renderToStaticMarkup(createElement(CoverageIssueReport, { issues: [issue] })));
  assert.match(entry, /Candidates tried: TMDB 100: 404 — record not found · TMDB 20: TMDB network request failed/);
});
