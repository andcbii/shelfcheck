import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { act, createElement, type FunctionComponent } from "react";
import PlexPage from "../app/plex/page";
import TraktPage from "../app/trakt/page";
import { mountDom } from "./dom-environment";
import { installWindowClock } from "./window-clock";

// The progress box under each report heading shows the shows the Scan run is
// checking and their step, from the page's status answers. Every server answer
// is faked; the clock (Date and the page's window timers) moves only when a
// test moves it, one second at a time.

type Status = Record<string, unknown>;
type Reply = Status | Error | Promise<Status>;

const START = new Date("2026-11-24T12:00:00.000Z");
const SHOWS = ["Severance", "The Bear", "Slow Horses", "Andor", "Shrinking", "Fallout", "Silo"];
const running = (extra: Status = {}): Status => ({ status: "running", processed: 41, total: 312, rateLimitPaused: false, ...extra });
const active = (...shows: [show: string, phase: string][]) => shows.map(([show, phase], index) => ({ key: String(index + 1), show, phase }));

type Server = {
  /** The page's own status answers, in order; the last one repeats. */
  statuses: Reply[];
  statusRequests: number;
  /** The Trakt status the page bootstraps from /api/state. */
  stateScan: Status;
};

async function mountPage(t: TestContext, page: "trakt" | "plex", initial: Partial<Server> = {}) {
  const server: Server = { statuses: [{ status: "completed", processed: 1, total: 1 }], statusRequests: 0, stateScan: { status: "idle", processed: 0, total: 0 }, ...initial };
  const status = async () => {
    const reply = server.statuses[Math.min(server.statusRequests++, server.statuses.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const fetcher: typeof fetch = async (input) => {
    if (input === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (input === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (input === "/api/state") return Response.json({ state: { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0, scan: server.stateScan } });
    if (input === "/api/scan") return Response.json({ scan: await status() });
    if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state") return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (input === "/api/plex/scan") return Response.json({ scan: await status(), report: null, coverage: { revision: 0, pending: 0, issues: [] } });
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const clock = installWindowClock(t, browser, START);
  await act(async () => { root.render(createElement((page === "trakt" ? TraktPage : PlexPage) as FunctionComponent)); });
  await settle();
  const box = () => container.querySelector(".scan-progress");
  const lines = () => Array.from(container.querySelectorAll(".scan-progress-shows li")).map((line) => [line.querySelector(".scan-progress-show")?.textContent, line.querySelector(".scan-progress-step")?.textContent]);
  /** Moves the clock one second at a time, settling fetch and React work after each. */
  const advance = async (seconds = 1) => {
    for (let second = 0; second < seconds; second += 1) {
      await act(async () => { clock.advanceTo(new Date(Date.now() + 1000)); });
      await settle();
    }
  };
  /** Replaces the status answers and restarts their count, so the next poll gets the first. */
  const nextStatuses = (...statuses: Reply[]) => { server.statuses = statuses; server.statusRequests = 0; };
  return { server, container, root, box, lines, advance, nextStatuses };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
}

function pending() {
  let resolve!: (status: Status) => void;
  const promise = new Promise<Status>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a Trakt page opened mid-scan lists the shows being checked before its first poll answers", async (t) => {
  const firstPoll = pending();
  const shows = active([SHOWS[0], "collection-progress"], [SHOWS[1], "air-dates"], [SHOWS[2], "poster"], [SHOWS[3], "collection-progress"], [SHOWS[4], "starting"], [SHOWS[5], "collection-progress"]);
  const page = await mountPage(t, "trakt", { stateScan: running({ activeShows: shows }), statuses: [firstPoll.promise] });

  assert.equal(page.box()?.querySelector(".scan-progress-head strong")?.textContent, "Now checking");
  assert.match(page.box()?.textContent || "", /Progress is saved periodically\./);
  assert.deepEqual(page.lines(), [
    ["Severance", "Checking your Trakt collection"],
    ["The Bear", "Looking up air dates"],
    ["Slow Horses", "Fetching the poster"],
    ["Andor", "Checking your Trakt collection"],
    ["Shrinking", "Starting"],
    ["Fallout", "Checking your Trakt collection"],
  ]);
  assert.doesNotMatch(page.box()?.textContent || "", /Comparing show|41 of 312/, "the box does not repeat the scan button's count");
  assert.match(page.container.querySelector("button.primary")?.textContent || "", /^Checking 41 of 312/, "the scan button still shows the count");
  assert.equal((page.box()?.querySelector(".scan-progress-bar") as HTMLElement | null)?.style.width, "13%", "the acid bar stays along the bottom");
});

test("each Trakt step reads in plain English, and an unknown step reads neutrally", async (t) => {
  const cases: [phase: string, wording: string][] = [
    ["collection-progress", "Checking your Trakt collection"],
    ["air-dates", "Looking up air dates"],
    ["poster", "Fetching the poster"],
    ["starting", "Starting"],
    ["a-step-added-later", "Working on it"],
  ];
  for (const [phase, wording] of cases) {
    await t.test(phase, async (t) => {
      const scan = running({ activeShows: active(["Severance", phase]) });
      const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
      assert.deepEqual(page.lines(), [["Severance", wording]]);
    });
  }
});

test("a Trakt show leaves the box or changes step on the next status answer", async (t) => {
  const first = running({ activeShows: active(["Severance", "collection-progress"], ["The Bear", "air-dates"]) });
  const page = await mountPage(t, "trakt", { stateScan: first, statuses: [first] });
  assert.deepEqual(page.lines(), [["Severance", "Checking your Trakt collection"], ["The Bear", "Looking up air dates"]]);

  page.nextStatuses(running({ processed: 42, activeShows: [{ key: "2", show: "The Bear", phase: "poster" }] }));
  await page.advance();
  assert.deepEqual(page.lines(), [["The Bear", "Fetching the poster"]]);
});

test("the Trakt box shows at most six shows, as many as a Trakt scan checks at once", async (t) => {
  const scan = running({ activeShows: active(...SHOWS.map((show) => [show, "starting"] as [string, string])) });
  const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
  assert.deepEqual(page.lines().map(([show]) => show), SHOWS.slice(0, 6));
});

test("an older saved Trakt status without show details still shows the box", async (t) => {
  const scan = { status: "running", processed: 3, total: 12 };
  const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
  assert.ok(page.box(), "the box shows");
  assert.equal(page.box()?.querySelector(".scan-progress-head strong")?.textContent, "Now checking");
  assert.deepEqual(page.lines(), []);

  page.nextStatuses({ ...scan, activeShows: [null, { key: 1 }, "Severance", { key: "2", show: "The Bear", phase: "air-dates" }] });
  await page.advance();
  assert.deepEqual(page.lines(), [["The Bear", "Looking up air dates"]], "malformed entries are skipped");
});

test("the Trakt box goes away when the scan completes or fails", async (t) => {
  await t.test("completes", async (t) => {
    const scan = running({ activeShows: active(["Severance", "poster"]) });
    const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
    assert.ok(page.box());
    page.nextStatuses({ status: "completed", processed: 312, total: 312 });
    await page.advance();
    assert.equal(page.box(), null);
  });
  await t.test("fails", async (t) => {
    const scan = running({ activeShows: active(["Severance", "poster"]) });
    const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
    page.nextStatuses({ status: "error", processed: 41, total: 312, error: "Trakt is unreachable." });
    await page.advance();
    assert.equal(page.box(), null);
    assert.match(page.container.querySelector(".error")?.textContent || "", /Trakt is unreachable\./);
  });
});

test("a Plex page opened mid-scan lists the shows being checked, then follows the next status answer", async (t) => {
  const nextPoll = pending();
  const first = running({ processed: 72, total: 188, currentPhase: "processing-3-shows", activeShows: active(["Doctor Who (2005)", "episode-crosswalk"], ["Bluey", "tmdb-show-and-seasons"], ["The Expanse", "plex-inventory"]) });
  const page = await mountPage(t, "plex", { statuses: [first, nextPoll.promise] });

  assert.equal(page.box()?.querySelector(".scan-progress-head strong")?.textContent, "Now checking");
  assert.match(page.box()?.textContent || "", /Progress is saved periodically\./);
  assert.deepEqual(page.lines(), [
    ["Doctor Who (2005)", "Matching episode numbers between providers"],
    ["Bluey", "Getting the episode list from TMDB"],
    ["The Expanse", "Reading episodes in Plex"],
  ]);
  assert.doesNotMatch(page.box()?.textContent || "", /SCANNING PLEX AND PROVIDERS|72 of 188/, "the box does not repeat the scan button's count");
  assert.equal((page.box()?.querySelector(".scan-progress-bar") as HTMLElement | null)?.style.width, "38%");

  nextPoll.resolve(running({ processed: 73, total: 188, activeShows: active(["Bluey", "tvdb-series-and-episodes"], ["Silo", "starting"]) }));
  await page.advance();
  assert.deepEqual(page.lines(), [["Bluey", "Getting the episode list from TVDB"], ["Silo", "Starting"]]);
});

test("each Plex step reads in plain English", async (t) => {
  const cases: [phase: string, wording: string][] = [
    ["plex-inventory", "Reading episodes in Plex"],
    ["tmdb-show-and-seasons", "Getting the episode list from TMDB"],
    ["tvdb-series-and-episodes", "Getting the episode list from TVDB"],
    ["episode-crosswalk", "Matching episode numbers between providers"],
    ["starting", "Starting"],
    ["a-step-added-later", "Working on it"],
  ];
  for (const [phase, wording] of cases) {
    await t.test(phase, async (t) => {
      const scan = running({ activeShows: active(["Bluey", phase]) });
      const page = await mountPage(t, "plex", { statuses: [scan] });
      assert.deepEqual(page.lines(), [["Bluey", wording]]);
    });
  }
});

test("the Plex box shows at most three shows, as many as a Plex scan checks at once", async (t) => {
  const scan = running({ activeShows: active(...SHOWS.slice(0, 4).map((show) => [show, "plex-inventory"] as [string, string])) });
  const page = await mountPage(t, "plex", { statuses: [scan] });
  assert.deepEqual(page.lines().map(([show]) => show), SHOWS.slice(0, 3));
});

test("a Plex page opened before the first show starts says it is getting ready, until a show starts", async (t) => {
  const nextPoll = pending();
  const page = await mountPage(t, "plex", { statuses: [running({ processed: 0, total: 0, currentPhase: "initializing" }), nextPoll.promise] });
  assert.equal(page.box()?.querySelector(".scan-progress-solo")?.textContent, "Getting ready…", "shown from the first load, before any poll answers");
  assert.deepEqual(page.lines(), []);

  nextPoll.resolve(running({ processed: 0, total: 188, currentPhase: "plex-inventory", activeShows: active(["Bluey", "plex-inventory"]) }));
  await page.advance();
  assert.equal(page.box()?.querySelector(".scan-progress-solo"), null);
  assert.deepEqual(page.lines(), [["Bluey", "Reading episodes in Plex"]]);
});

test("a Plex scan between shows, past getting ready, does not say it is getting ready", async (t) => {
  const page = await mountPage(t, "plex", { statuses: [running({ currentPhase: "processing" })] });
  assert.ok(page.box());
  assert.equal(page.box()?.querySelector(".scan-progress-solo"), null);
});

test("the Plex box goes away when the scan completes or fails", async (t) => {
  await t.test("completes", async (t) => {
    const page = await mountPage(t, "plex", { statuses: [running({ activeShows: active(["Bluey", "plex-inventory"]) })] });
    assert.ok(page.box());
    page.nextStatuses({ status: "completed", processed: 188, total: 188 });
    await page.advance();
    assert.equal(page.box(), null);
  });
  await t.test("fails", async (t) => {
    const page = await mountPage(t, "plex", { statuses: [running({ activeShows: active(["Bluey", "plex-inventory"]) })] });
    page.nextStatuses({ status: "error", processed: 41, total: 188, error: "Plex is unreachable." });
    await page.advance();
    assert.equal(page.box(), null);
    assert.match(page.container.querySelector(".error")?.textContent || "", /Plex is unreachable\./);
  });
});
