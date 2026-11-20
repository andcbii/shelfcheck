import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, StrictMode } from "react";
import PlexPage from "../app/plex/page";
import { mountDom } from "./dom-environment";
import { countListeners, installWindowClock } from "./window-clock";

// Local times in whatever zone the test runs in; the fixed-zone matrix covers specific zones.
const beforeMidnight = new Date(2026, 10, 20, 23, 59, 0);
const midnight = new Date(2026, 10, 21);
const nextMidnight = new Date(2026, 10, 22);

const report = {
  shows: [
    { ratingKey: "one", title: "Example Show", plexEpisodes: 2, missing: [
      { season: 1, episode: 1, airDate: "2000-01-01", sources: ["TMDB"] },
      { season: 1, episode: 2, airDate: "2026-11-21", sources: ["TMDB"] },
      { season: 1, episode: 3, airDate: "2026-11-20", sources: ["TMDB"] },
    ] },
  ],
  lastScan: "2026-11-20T12:00:00.000Z",
  scanCache: {},
};

async function mountPlex(t: test.TestContext, { strict = false, airingOffsetDays = 0 } = {}) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(`${init?.method || "GET"} ${String(input)}`);
    if (input === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state") return Response.json(init?.method === "PATCH" ? {} : { settings: { ignoredShows: [], ignoredSeasons: [], hideUnairedEpisodes: true, airingOffsetDays } });
    if (input === "/api/plex/scan") return Response.json({ scan: { status: "completed", processed: 1, total: 1 }, report });
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const { browser, container, root } = mountDom(t, { self: undefined, navigator: undefined, Element: undefined, fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const clock = installWindowClock(t, browser, beforeMidnight);
  const focusListeners = countListeners(browser, "focus");
  const visibilityListeners = countListeners(browser.document, "visibilitychange");
  const page = createElement(PlexPage);
  await act(async () => { root.render(strict ? createElement(StrictMode, null, page) : page); });
  const heading = () => container.querySelector(".report-heading h2")?.textContent;
  const episodes = () => Array.from(container.querySelectorAll(".plex-episode-trigger > span")).map((element) => element.textContent);
  const run = async (action: () => void) => { await act(async () => { action(); }); };
  return { browser, container, root, clock, requests, heading, episodes, run, focusListeners, visibilityListeners };
}

test("an open Plex page shows an episode at local midnight with no request, and schedules the next midnight", async (t) => {
  const page = await mountPlex(t);
  assert.equal(page.heading(), "2 missing episodes");
  assert.deepEqual(page.episodes(), ["S01E01", "S01E03"]);
  const requests = page.requests.length;

  await page.run(() => page.clock.advanceTo(new Date(midnight.getTime() - 1)));
  assert.equal(page.heading(), "2 missing episodes");

  await page.run(() => page.clock.advanceTo(midnight));
  assert.equal(page.heading(), "3 missing episodes");
  assert.deepEqual(page.episodes(), ["S01E01", "S01E02", "S01E03"]);
  assert.equal(page.requests.length, requests);
  assert.ok(page.clock.pending().includes(nextMidnight.getTime()), "the following local midnight is scheduled");
});

test("after a missed midnight, focus or the page becoming visible updates today and re-arms the timer", async (t) => {
  for (const wake of ["focus", "visibilitychange"] as const) {
    await t.test(wake, async (t) => {
      const page = await mountPlex(t);
      page.clock.sleepUntil(new Date(2026, 10, 21, 8, 0));
      assert.equal(page.heading(), "2 missing episodes");
      await page.run(() => { (wake === "focus" ? page.browser : page.browser.document).dispatchEvent(new page.browser.Event(wake)); });
      assert.equal(page.heading(), "3 missing episodes");
      assert.ok(page.clock.pending().includes(nextMidnight.getTime()), "the next local midnight is scheduled");
      assert.ok(!page.clock.pending().includes(midnight.getTime()), "the stale midnight timer is gone");
    });
  }
});

test("the day-change clock leaves no extra timers or listeners under StrictMode or after unmount", async (t) => {
  // Next's links queue one-millisecond idle callbacks; the day-change timer is the one at midnight.
  const counts = (page: Awaited<ReturnType<typeof mountPlex>>) => [page.clock.pending().filter((at) => at >= midnight.getTime()).length, page.focusListeners(), page.visibilityListeners()];
  let normalCounts: number[] = [];
  await t.test("normal mount", async (t) => {
    const normal = await mountPlex(t);
    normalCounts = counts(normal);
    assert.equal(normal.clock.pending().filter((at) => at === midnight.getTime()).length, 1);
    await act(async () => normal.root.unmount());
    assert.deepEqual(counts(normal), [0, 0, 0]);
  });
  await t.test("StrictMode mount", async (t) => {
    const strict = await mountPlex(t, { strict: true });
    assert.deepEqual(counts(strict), normalCounts);
    await act(async () => strict.root.unmount());
    assert.deepEqual(counts(strict), [0, 0, 0]);
  });
});

test("changing the Air-date delay redraws both ways with no scan", async (t) => {
  const page = await mountPlex(t);
  const gear = page.container.querySelector<HTMLButtonElement>('button[aria-label="Plex preferences"]')!;
  await page.run(() => gear.click());
  const delay = page.container.querySelector<HTMLInputElement>(".grace-input input")!;
  // react-dom loads before the DOM globals exist, so it watches the focused field's value on keyup.
  const setDelay = (days: number) => page.run(() => {
    delay.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(delay), "value")!.set!.call(delay, String(days));
    delay.dispatchEvent(new page.browser.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
  const scans = () => page.requests.filter((request) => request.includes("/api/plex/scan")).length;
  const scansBefore = scans();

  await setDelay(1);
  assert.equal(page.heading(), "1 missing episodes");
  assert.deepEqual(page.episodes(), ["S01E01"]);
  await setDelay(0);
  assert.equal(page.heading(), "2 missing episodes");
  assert.deepEqual(page.episodes(), ["S01E01", "S01E03"]);
  assert.equal(scans(), scansBefore);
});
