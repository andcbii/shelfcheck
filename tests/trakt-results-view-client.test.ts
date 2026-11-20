import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import TraktPage from "../app/trakt/page";
import { mountDom } from "./dom-environment";
import { installWindowClock } from "./window-clock";

// Local times in whatever zone the test runs in; the fixed-zone matrix covers
// converting Trakt's UTC timestamps in specific zones.
const beforeMidnight = new Date(2026, 10, 20, 23, 59, 0);
const midnight = new Date(2026, 10, 21);
const at = (year: number, monthIndex: number, day: number) => new Date(year, monthIndex, day, 20, 0).toISOString();

// Trakt counts Alpha 25% collected and Bravo 20%. Counted from the episodes left
// after filtering, Bravo (2 collected, 1 shown missing) would sort above Alpha.
const alpha = { title: "Alpha Show", year: 2020, ids: { trakt: 101, slug: "alpha-show" }, collection: { aired: 4, completed: 1 } };
const bravo = { title: "Bravo Show", year: 2021, ids: { trakt: 202, slug: "bravo-show" }, collection: { aired: 10, completed: 2 } };
const report = {
  shows: [{ show: alpha }, { show: bravo }],
  missing: [
    { show: alpha, season: 1, episode: 1, firstAired: at(2000, 0, 1) },
    { show: alpha, season: 1, episode: 2, firstAired: at(2026, 10, 21) },
    { show: alpha, season: 1, episode: 3 },
    { show: bravo, season: 1, episode: 1, firstAired: at(2001, 0, 1) },
    ...[2, 3, 4, 5, 6, 7, 8].map((episode) => ({ show: bravo, season: 1, episode, firstAired: at(2999, 0, 1) })),
  ],
  lastScan: "2026-11-20T12:00:00.000Z",
  scanCache: { "101": {}, "202": {} },
};

async function mountTrakt(t: test.TestContext, { airingGraceDays = 0 } = {}) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method || "GET"} ${url}`);
    if (url === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (url === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (url === "/api/state" && init?.method === "PATCH") return Response.json({});
    if (url === "/api/state") return Response.json({ state: { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays, report: structuredClone(report) } });
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
  };
  const { browser, container, root } = mountDom(t, { self: undefined, navigator: undefined, Element: undefined, fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const clock = installWindowClock(t, browser, beforeMidnight);
  await act(async () => { root.render(createElement(TraktPage)); });
  const run = async (action: () => void) => { await act(async () => { action(); }); };
  const texts = (selector: string) => Array.from(container.querySelectorAll(selector)).map((element) => element.textContent);
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find((element) => (element.getAttribute("aria-label") || element.textContent || "").includes(label))!;
  // react-dom loads before the DOM globals exist, so it watches the focused field's value on keyup.
  const type = (input: HTMLInputElement, value: string) => run(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
  return {
    browser, container, clock, requests, run, type, button,
    heading: () => container.querySelector(".report-heading h2")?.textContent,
    summary: () => texts(".scan-summary > div > strong").slice(1, 3),
    episodes: () => texts(".episode-code-tile"),
    titles: () => texts(".show-name-button"),
    percents: () => texts(".collection-percent strong"),
  };
}

test("an open Trakt page shows an episode at local midnight with no request, and shows undated episodes", async (t) => {
  const page = await mountTrakt(t);
  assert.equal(page.heading(), "3 missing episodes");
  assert.deepEqual(page.episodes(), ["S01E01", "S01E03", "S01E01"], "the undated Alpha S1E3 shows; unaired episodes do not");
  const requests = page.requests.length;

  await page.run(() => page.clock.advanceTo(new Date(midnight.getTime() - 1)));
  assert.equal(page.heading(), "3 missing episodes");
  await page.run(() => page.clock.advanceTo(midnight));
  assert.equal(page.heading(), "4 missing episodes");
  assert.deepEqual(page.episodes(), ["S01E01", "S01E02", "S01E03", "S01E01"]);
  assert.deepEqual(page.summary(), ["2", "4"]);
  assert.equal(page.requests.length, requests, "no request");
});

test("changing the Air-date delay on the Trakt page redraws both ways with no scan", async (t) => {
  const page = await mountTrakt(t);
  await page.run(() => page.clock.advanceTo(new Date(2026, 10, 21, 12)));
  await page.run(() => page.button("Trakt settings").click());
  const delay = page.container.querySelector<HTMLInputElement>(".grace-input input")!;
  const scans = () => page.requests.filter((request) => request.includes("/api/scan") && !request.includes("scan-runs")).length;
  const before = scans();
  await page.type(delay, "1");
  assert.equal(page.heading(), "3 missing episodes");
  await page.type(delay, "0");
  assert.equal(page.heading(), "4 missing episodes");
  assert.equal(scans(), before);
});

test("percent sort uses Trakt's collection count even when filtering removes episodes", async (t) => {
  const page = await mountTrakt(t);
  await page.run(() => page.button("By title").click());
  await page.run(() => page.button("Percent collected").click());
  // Percent sort starts highest first.
  assert.deepEqual(page.titles(), ["Alpha Show", "Bravo Show"]);
  assert.deepEqual(page.percents(), ["25%", "20%"]);
});

test("the Trakt heading and summary count every shown episode before search", async (t) => {
  const page = await mountTrakt(t);
  await page.type(page.container.querySelector<HTMLInputElement>(".search input")!, "no such show");
  assert.deepEqual(page.titles(), []);
  assert.equal(page.heading(), "3 missing episodes");
  assert.deepEqual(page.summary(), ["2", "3"]);
});

test("the Trakt gear menu calls the setting Air-date delay with the Plex help text", async (t) => {
  const page = await mountTrakt(t);
  await page.run(() => page.button("Trakt settings").click());
  const text = page.container.querySelector('[aria-labelledby="settings-title"]')!.textContent || "";
  assert.match(text, /Air-date delay/);
  assert.match(text, /Treat each episode’s air date as this many calendar days later before showing it as missing\./);
  assert.doesNotMatch(text, /grace period/i);
});
