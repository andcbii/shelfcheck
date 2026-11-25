import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import PlexPage from "../app/plex/page";
import { mountDom } from "./dom-environment";
import { pending, START } from "./scan-progress-harness";
import { installWindowClock } from "./window-clock";

// The Plex page keeps its last completed report, shows and incomplete coverage
// groups, below the progress box while a Scan run goes on, and replaces it in
// full only when the run completes. Every server answer is faked; the clock
// (Date and the page's window timers) moves only when a test moves it.

type Body = Record<string, unknown>;
type Reply = Body | Error | Promise<Body>;

// A coverage group survives on the page only through a visible missing episode
// of a reported show, so each group names its own show's missing episode.
function reportWith(key: string, title: string, episodeId: number, lastScan: string) {
  const member = { provider: "TMDB", id: episodeId, showId: episodeId, show: title, title: "Combined", season: 1, episode: 1, url: `https://example.test/${episodeId}`, status: "missing" };
  return {
    shows: [{ ratingKey: key, title, plexEpisodes: 3, missing: [{ season: 1, episode: 1, airDate: "2020-01-01", tmdbEpisodeId: episodeId, sources: ["TMDB"] }] }],
    lastScan,
    scanCache: { [key]: {} },
    coverageGroups: [{ mappingId: `group-${key}`, members: [member], missing: [{ provider: "TMDB", id: episodeId, status: "missing", season: 1, airDate: "2020-01-01", showKey: key }] }],
  };
}
const REPORT_A = reportWith("a", "Andor", 100, "2026-11-20T12:00:00.000Z");
const REPORT_B = reportWith("b", "Bluey", 200, "2026-11-24T13:00:00.000Z");
const BOTH_REPORTS = { ...REPORT_A, shows: [...REPORT_A.shows, ...REPORT_B.shows], coverageGroups: [...REPORT_A.coverageGroups, ...REPORT_B.coverageGroups] };
const EMPTY_REPORT = { shows: [], coverageGroups: [], lastScan: "2026-11-24T13:00:00.000Z", scanCache: {} };

const running = { status: "running", processed: 41, total: 188, activeShows: [{ key: "1", show: "Silo", phase: "plex-inventory" }] };
const completed = { status: "completed", processed: 188, total: 188 };
const answer = (scan: Body, report: unknown, revision = 0): Body => ({ scan, report, coverage: { revision, pending: 0, issues: [] } });

async function mountPlex(t: test.TestContext, answers: Reply[], options: { patchRevision?: number } = {}) {
  const server = { answers, reads: 0, starts: 0 };
  const fetcher: typeof fetch = async (input, init) => {
    if (input === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state" && init?.method === "PATCH") return Response.json(options.patchRevision === undefined ? {} : { coverageRevision: options.patchRevision });
    if (input === "/api/plex/state") return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (input === "/api/plex/manual-coverage") return Response.json({ revision: 1, mappings: [], pending: 0 });
    if (input === "/api/plex/scan" && init?.method === "POST") { server.starts += 1; return Response.json({}); }
    if (input === "/api/plex/scan") {
      const reply = server.answers[Math.min(server.reads++, server.answers.length - 1)];
      if (reply instanceof Error) throw reply;
      return Response.json(await reply);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const clock = installWindowClock(t, browser, START);
  await act(async () => { root.render(createElement(PlexPage)); });
  await settle();
  const advance = async (seconds = 1) => {
    for (let second = 0; second < seconds; second += 1) {
      await act(async () => { clock.advanceTo(new Date(Date.now() + 1000)); });
      await settle();
    }
  };
  /** Replaces the scan answers and restarts their count, so the next read gets the first. */
  const nextAnswers = (...replies: Reply[]) => { server.answers = replies; server.reads = 0; };
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((element) => (element.getAttribute("aria-label") || element.textContent || "").includes(label));
    assert.ok(button, `Expected button: ${label}`);
    await act(async () => { button.click(); });
    await settle();
  }
  const box = () => container.querySelector(".scan-progress");
  const shows = () => Array.from(container.querySelectorAll(".show-name-button")).map((button) => button.textContent);
  const groups = () => Array.from(container.querySelectorAll('[aria-label="Incomplete coverage group"] li a')).map((link) => link.textContent?.split(" · ")[1]);
  const empty = () => container.querySelector(".empty h3")?.textContent ?? null;
  const error = () => container.querySelector(".error")?.textContent ?? null;
  /** The progress box comes before the report's coverage groups and shows. */
  const boxAboveReport = () => {
    const report = container.querySelector('[aria-label="Incomplete coverage group"], .show-list, .empty');
    return Boolean(box() && report && box()!.compareDocumentPosition(report) & browser.Node.DOCUMENT_POSITION_FOLLOWING);
  };
  return { server, container, advance, nextAnswers, click, box, shows, groups, empty, error, boxAboveReport };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
}

test("starting a Plex scan keeps the loaded report below the progress box until the run completes", async (t) => {
  const page = await mountPlex(t, [answer(completed, REPORT_A)]);
  assert.deepEqual(page.shows(), ["Andor"]);
  assert.deepEqual(page.groups(), ["Andor"]);

  // A running answer carrying another report cannot replace the retained one.
  page.nextAnswers(answer(running, REPORT_B));
  await page.click("New Plex search");
  assert.equal(page.server.starts, 1);
  assert.ok(page.box(), "the progress box shows");
  assert.deepEqual(page.shows(), ["Andor"], "the previous shows stay");
  assert.deepEqual(page.groups(), ["Andor"], "the previous coverage groups stay");
  assert.ok(page.boxAboveReport(), "the progress box sits above the retained report");
  await page.advance(2);
  assert.deepEqual(page.shows(), ["Andor"]);
  assert.deepEqual(page.groups(), ["Andor"]);

  page.nextAnswers(answer(completed, REPORT_B));
  await page.advance();
  assert.equal(page.box(), null);
  assert.deepEqual(page.shows(), ["Bluey"], "the new shows replace the old");
  assert.deepEqual(page.groups(), ["Bluey"], "the new coverage groups replace the old together");
});

test("a Plex page opened mid-scan shows the saved report and the progress", async (t) => {
  const page = await mountPlex(t, [answer(running, REPORT_A)]);
  assert.ok(page.box());
  assert.deepEqual(page.shows(), ["Andor"]);
  assert.deepEqual(page.groups(), ["Andor"]);
  assert.ok(page.boxAboveReport());
});

test("a first-ever Plex scan shows only the progress box, not the empty report state", async (t) => {
  const page = await mountPlex(t, [answer(running, null)]);
  assert.ok(page.box());
  assert.equal(page.empty(), null, "no empty state contradicts the running scan");
  assert.deepEqual(page.shows(), []);
  assert.deepEqual(page.groups(), []);
});

test("a completed empty Plex report is a report: a scan keeps it, and the page says nothing matches", async (t) => {
  const page = await mountPlex(t, [answer(completed, EMPTY_REPORT)]);
  assert.equal(page.empty(), "No matching episode gaps");
  page.nextAnswers(answer(running, REPORT_B));
  await page.click("New Plex search");
  assert.ok(page.box());
  assert.equal(page.empty(), "No matching episode gaps", "the empty report stays, not the first-scan state");
  assert.deepEqual(page.shows(), []);
  assert.ok(page.boxAboveReport());
});

test("a Plex scan that completes with nothing missing replaces the old report with an empty one", async (t) => {
  const page = await mountPlex(t, [answer(running, REPORT_A)]);
  assert.deepEqual(page.shows(), ["Andor"]);
  page.nextAnswers(answer(completed, EMPTY_REPORT));
  await page.advance();
  assert.equal(page.box(), null);
  assert.deepEqual(page.shows(), []);
  assert.deepEqual(page.groups(), []);
  assert.equal(page.empty(), "No matching episode gaps");
});

test("a failed Plex scan or a lost connection keeps the old report", async (t) => {
  await t.test("the scan fails", async (t) => {
    const page = await mountPlex(t, [answer(running, REPORT_A)]);
    page.nextAnswers(answer({ status: "error", processed: 41, total: 188, error: "Plex is unreachable." }, REPORT_B));
    await page.advance();
    assert.equal(page.box(), null);
    assert.match(page.error() || "", /Plex is unreachable\./);
    assert.deepEqual(page.shows(), ["Andor"]);
    assert.deepEqual(page.groups(), ["Andor"]);
  });
  await t.test("the connection drops", async (t) => {
    const page = await mountPlex(t, [answer(running, REPORT_A)]);
    page.nextAnswers(new TypeError("network down"));
    await page.advance();
    assert.equal(page.box(), null);
    assert.deepEqual(page.shows(), ["Andor"]);
    assert.deepEqual(page.groups(), ["Andor"]);
  });
});

test("ignoring a show during a Plex scan removes it from the retained report, and completion does not bring it back", async (t) => {
  const page = await mountPlex(t, [answer(running, BOTH_REPORTS)]);
  assert.deepEqual(page.shows(), ["Andor", "Bluey"]);
  assert.deepEqual(page.groups(), ["Andor", "Bluey"]);

  await page.click("Andor");
  await page.click("Ignore this show");
  await page.click("Forever");
  assert.ok(page.box(), "the scan goes on");
  assert.deepEqual(page.shows(), ["Bluey"]);
  assert.deepEqual(page.groups(), ["Bluey"], "the ignored show's coverage group goes with it");

  await page.advance(2);
  assert.deepEqual(page.shows(), ["Bluey"], "a running answer does not bring it back");
  page.nextAnswers(answer(completed, BOTH_REPORTS));
  await page.advance();
  assert.deepEqual(page.shows(), ["Bluey"], "nor does completion");
});

test("a coverage change during a Plex scan refreshes the retained groups, and a stale answer after it cannot overwrite them", async (t) => {
  const stalePoll = pending();
  // The server rechecked the saved report: Andor's mapping no longer leaves it incomplete.
  const rechecked = { ...BOTH_REPORTS, coverageGroups: REPORT_B.coverageGroups };
  const page = await mountPlex(t, [answer(running, BOTH_REPORTS, 1), stalePoll.promise, answer(running, rechecked, 2)], { patchRevision: 2 });
  assert.deepEqual(page.groups(), ["Andor", "Bluey"]);

  // The saved Ignore rechecks cached comparisons and reports coverage revision 2.
  await page.click("Bluey");
  await page.click("Ignore this show");
  await page.click("Forever");
  assert.ok(page.box(), "the scan goes on");
  assert.deepEqual(page.shows(), ["Andor"]);
  assert.deepEqual(page.groups(), [], "the refreshed groups replace the old ones");

  stalePoll.resolve(answer(completed, REPORT_B, 1));
  await page.advance();
  assert.ok(page.box(), "the stale completion does not end the scan");
  assert.deepEqual(page.shows(), ["Andor"], "the stale answer does not overwrite the report");
  assert.deepEqual(page.groups(), []);

  page.nextAnswers(answer(completed, REPORT_A, 2));
  await page.advance();
  assert.equal(page.box(), null);
  assert.deepEqual(page.shows(), ["Andor"]);
  assert.deepEqual(page.groups(), ["Andor"], "completion replaces shows and groups together");
});

test("editing a retained coverage group during a Plex scan keeps the Manual Match scan guard", async (t) => {
  const page = await mountPlex(t, [answer(running, REPORT_A)]);
  await page.click("Edit coverage mapping");
  const manager = page.container.querySelector(".manual-coverage-manager");
  assert.ok(manager, "Matching Episodes opens");
  assert.match(manager.textContent || "", /A Plex scan is running\. Wait for it to finish before changing Manual Matches\./);
});
