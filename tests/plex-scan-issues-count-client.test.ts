import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import PlexPage from "../app/plex/page";

const at = "2026-11-11T12:00:00.000Z";
const report = {
  shows: [
    { ratingKey: "ratingKey:1", title: "Lost", plexEpisodes: 1, missing: [], providerResolution: { tmdb: false, tvdb: false, status: "unmatched" } },
    { ratingKey: "ratingKey:2", title: "Found", plexEpisodes: 1, missing: [], providerResolution: { tmdb: false, tvdb: true, status: "partially-matched" } },
  ],
  lastScan: at,
};
const issue = (ratingKey: string) => ({ id: `catalogue-refresh:TMDB:${ratingKey}`, scope: "show", provider: "TMDB", operation: "catalogue-refresh", show: { ratingKey }, cause: "404 — record not found", action: "Check the Plex provider ID reference." });
const coverage = { revision: 1, pending: 0, issues: [issue("ratingKey:1"), issue("ratingKey:2"), { id: "provider-authentication:TVDB", scope: "library", provider: "TVDB", operation: "authentication", cause: "TVDB sign-in failed", action: "Check TVDB credentials." }] };

test("the Plex page's Scan Issues count leaves out an Unmatched show's own hidden entries", async (t) => {
  const browser = new Window({ url: "http://localhost:3000/plex" });
  const globals = {
    window: browser, self: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: unknown) => {
      if (input === "/api/scan-runs") return Response.json({ activeScanRun: null });
      if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
      if (input === "/api/plex/state") return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
      if (input === "/api/plex/scan") return Response.json({ scan: { status: "completed", processed: 2, total: 2 }, report, coverage });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => { root.render(createElement(PlexPage)); });
  const link = container.querySelector('a[href="/reports/coverage-issues"]');
  assert.equal(link?.textContent, "Scan Issues (2)", "the sign-in failure and the Partially matched show's entry");
});
