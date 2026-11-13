import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CoverageIssueReport, CoverageWarning } from "../app/reports/components/coverage-issue-report";
import PlexPage from "../app/plex/page";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { episodeCheckIssue } = await import("../lib/episode-check-issues");
hook.deregister();

// An Episode-scoped failure is explained in 05 — Scan Issues while the affected
// episode keeps its normal missing presentation on /plex: no new status, report or retry control.

const show = { ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20 };
const issue = episodeCheckIssue(show, { operation: "compound-matching", episode: { provider: "TVDB", id: 102, season: 1, episode: 2 }, kind: "missing-title", reason: "TVDB returned no usable title for this episode.", dependents: [{ provider: "TVDB", id: 101, season: 1, episode: 1 }], local: { season: 1, episode: 1, tmdbEpisodeId: 9001 } });
const covered = episodeCheckIssue(show, { operation: "compound-matching", episode: { provider: "TVDB", id: 103, season: 1, episode: 3 }, kind: "missing-title", reason: "TVDB returned no usable title for this episode.", dependents: [], local: { season: 1, episode: 1, tmdbEpisodeId: 9001 }, coveredBy: "manual-match" });

async function dom(t: test.TestContext, url: string, fetcher?: typeof fetch) {
  const browser = new Window({ url });
  const globals = { window: browser, self: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true, ...(fetcher ? { fetch: fetcher } : {}) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  });
  return { container, root };
}

test("05 — Scan Issues explains the failed episode check, its identities, relationships and outcome", async t => {
  const { container, root } = await dom(t, "http://localhost/reports/coverage-issues");
  await act(async () => root.render(createElement("div", null, createElement(CoverageWarning, { issues: [issue, covered] }), createElement(CoverageIssueReport, { issues: [issue, covered] }))));
  const content = container.querySelector('[aria-label="Show and episode issues"]')!.textContent!;
  for (const value of ["Target", "Plex ratingKey:target · TMDB 10 · TVDB 20", "TVDB 102 show 20 S01E02", "TVDB · Episode Matching", "Combined/split episode matching could not be checked: TVDB returned no usable title for this episode.",
    "owned TMDB episode 9001 (S01E01)", "TVDB 101 (S01E01)", "this episode remains in missing results", "A complete-set Manual Match established coverage for this episode, so it remains collected", "Check this episode's title at TVDB"]) assert.ok(content.includes(value), value);
  assert.ok(!content.includes("Source unknown"), "a matching check is not presented as a provider lookup");
  assert.ok(!content.includes("Response:"));
  assert.match(container.textContent!, /Scan Issues \(2\)/);
  assert.equal(container.querySelectorAll("button").length, 0, "no retry control");
});

test("/plex keeps an episode with a failed check in the normal missing results", async t => {
  const report = { lastScan: "2026-11-06T12:00:00.000Z", shows: [{ ...show, tvdbSlug: "target", plexEpisodes: 2, missing: [{ season: 1, episode: 2, airDate: "2020-01-01", tvdbEpisodeId: 102, sources: ["TVDB"] }] }] };
  const fetcher: typeof fetch = async input => {
    if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state") return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (input === "/api/plex/scan") return Response.json({ scan: { status: "completed", processed: 1, total: 1 }, report, coverage: { revision: 0, pending: 0, issues: [issue] } });
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const { container, root } = await dom(t, "http://localhost:3000/plex", fetcher);
  await act(async () => root.render(createElement(PlexPage)));
  const article = container.querySelector(".show-list article")!;
  assert.ok(article, "the show is listed with its missing episodes");
  assert.match(article.textContent!, /2 collected · 1 missing episode/);
  assert.match(article.textContent!, /S01E02/);
  assert.match(container.textContent!, /Scan Issues \(1\)/, "the existing overall warning links to the explanation");
  assert.ok(!/unverified|retry/i.test(container.textContent!), "no new status or retry control");
});
