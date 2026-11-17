import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import PlexPage from "../app/plex/page";

const at = "2026-11-11T12:00:00.000Z";
const single = { candidates: [{ id: 20, name: "Scooby TVDB" }], automaticId: 20, preferredId: 20, current: { preferredId: 20, usingId: 20, state: "preferred", selectedAt: at } };
const missing = [{ season: 1, episode: 2, sources: ["TMDB"] }];
const report = {
  shows: [
    { ratingKey: "plex://show/scooby", title: "Scooby", tmdbId: 2150, plexEpisodes: 1, missing, catalogueSelection: {
      tmdb: { candidates: [{ id: 2150, name: "The Scooby-Doo/Dynomutt Hour" }, { id: 337142, name: "The Scooby-Doo Show" }], automaticId: 2150, override: 337142, preferredId: 337142,
        current: { preferredId: 337142, usingId: 2150, state: "fallback", selectedAt: at } },
      tvdb: single,
    } },
    { ratingKey: "ratingKey:7", title: "Single", tmdbId: 10, plexEpisodes: 1, missing, catalogueSelection: { tmdb: { ...single, candidates: [{ id: 10 }] }, tvdb: single } },
  ],
  lastScan: at,
};

async function mountPage(t: test.TestContext) {
  const browser = new Window({ url: "http://localhost:3000/plex" });
  const globals = {
    window: browser, self: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: unknown) => {
      if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
      if (input === "/api/plex/state") return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
      if (input === "/api/plex/scan") return Response.json({ scan: { status: "completed", processed: 2, total: 2 }, report });
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
  return container;
}

test("a result with several provider IDs shows the persisted selection between its summary and seasons, linking to its report entry", async (t) => {
  const container = await mountPage(t);
  const notices = Array.from(container.querySelectorAll(".catalogue-notice"));
  assert.equal(notices.length, 1, "only the show with several IDs gets a notice");
  const notice = notices[0];
  assert.match(notice.textContent || "", /Multiple TMDB IDs · Preferred TMDB 337142 · Using fallback The Scooby-Doo\/Dynomutt Hour \(2150\)/);
  const link = notice.querySelector("a");
  assert.equal(link?.textContent, "Review IDs");
  assert.equal(link?.getAttribute("href"), "/reports/multiple-provider-ids#show-plex%3A%2F%2Fshow%2Fscooby");
  assert.ok(notice.previousElementSibling?.classList.contains("compact-show-meta"), "below the collected/missing summary");
  assert.ok(notice.nextElementSibling?.classList.contains("plex-seasons"), "above the season rows");
});
