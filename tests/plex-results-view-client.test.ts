import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import PlexPage from "../app/plex/page";
import { mountDom } from "./dom-environment";

// Far past and far future air dates keep these checks independent of the real today.
const report = {
  shows: [
    { ratingKey: "one", title: "Example Show", plexEpisodes: 3, missing: [
      { season: 1, episode: 1, airDate: "2000-01-01", sources: ["TMDB"] },
      { season: 1, episode: 2, airDate: "2999-01-01", sources: ["TMDB"] },
      { season: 1, episode: 3, sources: ["TMDB"] },
    ] },
  ],
  lastScan: "2026-11-06T12:00:00.000Z",
  scanCache: {},
};

async function mountPlex(t: test.TestContext, settings: Record<string, unknown>) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(`${init?.method || "GET"} ${String(input)}`);
    if (input === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state") return Response.json(init?.method === "PATCH" ? {} : { settings: { ignoredShows: [], ignoredSeasons: [], ...settings } });
    if (input === "/api/plex/scan") return Response.json({ scan: { status: "completed", processed: 1, total: 1 }, report });
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const { browser, container, root } = mountDom(t, { self: undefined, navigator: undefined, Element: undefined, fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  await act(async () => { root.render(createElement(PlexPage)); });
  const heading = () => container.querySelector(".report-heading h2")?.textContent;
  const percent = () => container.querySelector(".collection-percent strong")?.textContent;
  const episodes = () => Array.from(container.querySelectorAll(".plex-episode-trigger > span")).map((element) => element.textContent);
  return { container, requests, heading, percent, episodes };
}

test("the Plex page draws aired episodes and a filtered percent, and redraws when Hide unaired episodes is turned off", async (t) => {
  const page = await mountPlex(t, { hideUnairedEpisodes: true, airingOffsetDays: 0 });
  assert.equal(page.heading(), "1 missing episodes");
  assert.deepEqual(page.episodes(), ["S01E01"]);
  assert.equal(page.percent(), "75%");

  const gear = page.container.querySelector<HTMLButtonElement>('button[aria-label="Plex preferences"]')!;
  await act(async () => { gear.click(); });
  const hideUnaired = Array.from(page.container.querySelectorAll(".plex-preference")).find((element) => element.textContent?.includes("Hide unaired episodes"))!.querySelector<HTMLInputElement>("input")!;
  const scanRequests = page.requests.filter((request) => request.includes("/api/plex/scan")).length;
  await act(async () => { hideUnaired.click(); });
  assert.equal(page.heading(), "3 missing episodes");
  assert.deepEqual(page.episodes(), ["S01E01", "S01E02", "S01E03"]);
  assert.equal(page.percent(), "50%");
  assert.equal(page.requests.filter((request) => request.includes("/api/plex/scan")).length, scanRequests);
});

test("the Plex gear menu calls the setting Air-date delay and the help texts use that name", async (t) => {
  const page = await mountPlex(t, {});
  const gear = page.container.querySelector<HTMLButtonElement>('button[aria-label="Plex preferences"]')!;
  await act(async () => { gear.click(); });
  const text = page.container.querySelector('[aria-labelledby="plex-preferences-title"]')!.textContent || "";
  assert.match(text, /Air-date delay/);
  assert.match(text, /Treat each episode’s air date as this many calendar days later before showing it as missing\./);
  assert.match(text, /Hide episodes until their listed air date plus the Air-date delay below\./);
  assert.doesNotMatch(text, /offset/i);
});
