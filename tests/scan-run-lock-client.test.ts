import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { act, createElement, type FunctionComponent } from "react";
import PlexPage from "../app/plex/page";
import TraktPage from "../app/trakt/page";
import { mountDom } from "./dom-environment";

// Pages observe the Scan run that owns the lock through GET /api/scan-runs and
// lock their scan controls while the other kind runs. Fake timers drive the
// one-second observation; every response is controlled by the test.

type ActiveScanRun = { kind: "trakt" | "plex"; startedAt: string } | null;
type Reply = Response | Promise<Response>;

const PLEX_RUN = { kind: "plex", startedAt: "2026-11-18T12:00:00.000Z" } as const;
const TRAKT_RUN = { kind: "trakt", startedAt: "2026-11-18T12:00:00.000Z" } as const;
const PLEX_LOCKS_TRAKT = "A Plex scan is running. You can start a Trakt scan when it finishes.";
const TRAKT_LOCKS_PLEX = "A Trakt scan is running. You can start a Plex scan when it finishes.";

const traktShow = { title: "Example", year: 2020, ids: { trakt: 7, slug: "example" } };
const traktReport = { shows: [{ show: traktShow }], missing: [{ show: traktShow, season: 1, episode: 2 }], lastScan: "2026-11-17T12:00:00.000Z", scanCache: { 7: {} } };
const plexReport = { shows: [{ ratingKey: "one", title: "Example Show", tmdbId: 10, plexEpisodes: 1, missing: [{ season: 1, episode: 2, sources: ["TMDB"] }] }], lastScan: "2026-11-17T12:00:00.000Z", scanCache: { one: {} } };

type Server = {
  /** What GET /api/scan-runs answers; a function answers one request at a time. */
  activity: ActiveScanRun | (() => Reply);
  activityRequests: number;
  /** The page's own status answers, in order; the last one repeats. */
  statuses: Record<string, unknown>[];
  statusRequests: number;
  starts: unknown[];
  start: () => Reply;
  /** The Trakt status the page bootstraps from /api/state. */
  stateScan: Record<string, unknown>;
};

async function mountPage(t: TestContext, page: "trakt" | "plex", initial: Partial<Server> = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server: Server = { activity: null, activityRequests: 0, statuses: [{ status: "completed", processed: 1, total: 1 }], statusRequests: 0, starts: [], start: () => Response.json({ error: "unexpected start" }, { status: 500 }), stateScan: { status: "idle", processed: 0, total: 0 }, ...initial };
  const status = () => server.statuses[Math.min(server.statusRequests++, server.statuses.length - 1)];
  const fetcher: typeof fetch = async (input, init) => {
    if (input === "/api/scan-runs") {
      server.activityRequests += 1;
      return typeof server.activity === "function" ? server.activity() : Response.json({ activeScanRun: server.activity });
    }
    if (init?.method === "POST") { server.starts.push(init.body ? JSON.parse(String(init.body)) : {}); return server.start(); }
    if (input === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (input === "/api/state") return Response.json({ state: { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0, report: traktReport, scan: server.stateScan } });
    if (input === "/api/scan") return Response.json({ scan: status() });
    if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state") return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (input === "/api/plex/scan") return Response.json({ scan: status(), report: plexReport, coverage: { revision: 0, pending: 0, issues: [] } });
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  // The progress poller waits on window timers; route them through the fake clock too.
  for (const key of ["setTimeout", "clearTimeout"] as const) Object.defineProperty(browser, key, { configurable: true, writable: true, value: (...args: unknown[]) => (globalThis[key] as (...values: unknown[]) => unknown)(...args) });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  await act(async () => { root.render(createElement((page === "trakt" ? TraktPage : PlexPage) as FunctionComponent)); });
  await settle();
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label);
  const click = async (label: string) => { const target = button(label); assert.ok(target, `${label} is shown`); await act(async () => { target.click(); }); await settle(); };
  const lockMessage = () => container.querySelector(".scan-run-lock")?.textContent || "";
  const advance = async (ms: number) => { await act(async () => { t.mock.timers.tick(ms); }); await settle(); };
  const unmount = async () => { await act(async () => { root.unmount(); }); };
  return { server, container, button, click, lockMessage, advance, unmount };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

test("an idle Trakt page locks its scan controls within a second of a Plex scan run starting, and unlocks after it finishes", async (t) => {
  const page = await mountPage(t, "trakt");
  assert.equal(page.button("Quick scan")?.disabled, false);
  assert.equal(page.lockMessage(), "");

  page.server.activity = PLEX_RUN;
  await page.advance(1000);
  assert.equal(page.button("Quick scan")?.disabled, true);
  assert.equal(page.button("Run Deep Scan")?.disabled, true);
  assert.equal(page.lockMessage(), PLEX_LOCKS_TRAKT);

  page.server.activity = null;
  await page.advance(1000);
  assert.equal(page.button("Quick scan")?.disabled, false);
  assert.equal(page.lockMessage(), "");
  assert.deepEqual(page.server.starts, []);
});

test("a Trakt page opened during a Plex scan run shows locked controls without waiting for a poll", async (t) => {
  const page = await mountPage(t, "trakt", { activity: PLEX_RUN });
  assert.equal(page.server.activityRequests, 1, "activity is fetched on mount");
  assert.equal(page.button("Quick scan")?.disabled, true);
  assert.equal(page.lockMessage(), PLEX_LOCKS_TRAKT);
  assert.ok(!page.button("Quick scan")?.textContent?.includes("Checking"), "the other kind's run never looks like this page scanning");
});

test("an open Deep Scan confirmation and show menu cannot start a scan once a Plex scan run locks the Trakt page", async (t) => {
  const page = await mountPage(t, "trakt");
  await page.click("Example");
  assert.equal(page.button("Force check now")?.disabled, false);
  await page.click("Run Deep Scan");
  const confirm = () => Array.from(page.container.querySelectorAll(".rescan-modal button")).find((item) => item.textContent?.includes("Run Deep Scan")) as HTMLButtonElement | undefined;
  assert.equal(confirm()?.disabled, false);

  page.server.activity = PLEX_RUN;
  await page.advance(1000);
  assert.equal(confirm()?.disabled, true, "the open confirmation locks");
  await act(async () => { confirm()?.click(); });
  assert.equal(page.button("Force check now")?.disabled, true, "the open show menu locks its single-show check");
  await act(async () => { page.button("Force check now")?.click(); });
  await settle();
  assert.deepEqual(page.server.starts, []);
});

test("clearing the Trakt scan cache stays available during a Plex scan run", async (t) => {
  const page = await mountPage(t, "trakt", { activity: PLEX_RUN });
  await page.click("Trakt settings");
  assert.equal(page.button("Clear scan cache")?.disabled, false);
});

test("a Trakt start refused by a race shows the server's message and locks the page at once", async (t) => {
  const page = await mountPage(t, "trakt", { start: () => Response.json({ error: PLEX_LOCKS_TRAKT, activeScanRun: { ...PLEX_RUN, status: { status: "running", processed: 3, total: 9 } } }, { status: 409 }) });
  // The poll that is in flight when the 409 arrives started before the race and still reports no owner.
  const late = deferred();
  page.server.activity = () => late.promise;
  await page.advance(1000);
  // The observation the 409 triggers is still pending when the older one answers.
  const refreshed = deferred();
  page.server.activity = () => refreshed.promise;
  const before = page.server.activityRequests;

  await page.click("Quick scan");
  assert.equal(page.server.starts.length, 1);
  assert.ok(page.container.querySelector(".error")?.textContent?.includes(PLEX_LOCKS_TRAKT));
  assert.equal(page.lockMessage(), PLEX_LOCKS_TRAKT, "the 409's owner locks the page immediately");
  assert.equal(page.button("Quick scan")?.disabled, true);

  late.resolve(Response.json({ activeScanRun: null }));
  await settle();
  assert.equal(page.button("Quick scan")?.disabled, true, "a response older than the 409 does not unlock the page");
  assert.equal(page.server.activityRequests, before + 1, "activity is observed again at once, without waiting for the next poll");
  refreshed.resolve(Response.json({ activeScanRun: PLEX_RUN }));
  await settle();
  assert.equal(page.lockMessage(), PLEX_LOCKS_TRAKT);
});

test("a failed observation keeps the Trakt page locked", async (t) => {
  const page = await mountPage(t, "trakt", { activity: PLEX_RUN });
  page.server.activity = () => Response.json({ error: "unavailable" }, { status: 500 });
  await page.advance(1000);
  assert.equal(page.lockMessage(), PLEX_LOCKS_TRAKT);
  page.server.activity = () => Promise.reject(new TypeError("network down"));
  await page.advance(1000);
  assert.equal(page.button("Quick scan")?.disabled, true);
  page.server.activity = null;
  await page.advance(1000);
  assert.equal(page.button("Quick scan")?.disabled, false, "observation keeps going after failures");
});

test("a Trakt page opened while a Trakt scan runs in another tab follows its progress with one poller, and keeps observing after it completes", async (t) => {
  const page = await mountPage(t, "trakt", {
    activity: TRAKT_RUN,
    statuses: [{ status: "running", processed: 1, total: 4 }, { status: "running", processed: 2, total: 4 }, { status: "running", processed: 3, total: 4 }, { status: "completed", processed: 4, total: 4 }],
  });
  assert.equal(page.lockMessage(), "", "its own kind does not lock the page with the other-kind message");
  assert.match(page.button("Checking")?.textContent || "", /Checking 1 of 4/, "the other tab's progress is shown");
  assert.equal(page.server.statusRequests, 1, "one progress request so far");

  await page.advance(1000);
  assert.match(page.button("Checking")?.textContent || "", /Checking 2 of 4/);
  assert.equal(page.server.statusRequests, 2, "activity ticks do not start a second progress loop");
  await page.advance(1000);
  await page.advance(1000);
  assert.equal(page.server.statusRequests, 4);
  assert.equal(page.button("Quick scan")?.disabled, false, "the completed run unlocks the page");

  await page.advance(3000);
  assert.equal(page.server.statusRequests, 4, "the same finished run is not followed again while it releases the lock");

  page.server.activity = PLEX_RUN;
  await page.advance(1000);
  assert.equal(page.lockMessage(), PLEX_LOCKS_TRAKT, "a completed own status does not stop observation");
});

test("a Trakt page that resumes its own running scan from its saved status is not given a second progress loop by observation", async (t) => {
  const running = { status: "running", processed: 1, total: 4 };
  const page = await mountPage(t, "trakt", { activity: TRAKT_RUN, stateScan: running, statuses: [running] });
  const atMount = page.server.statusRequests;
  for (let second = 1; second <= 3; second += 1) {
    await page.advance(1000);
    assert.equal(page.server.statusRequests, atMount + second, "one progress request a second");
  }
});

test("unmounting the Trakt page stops observation, and a response arriving after it changes nothing", async (t) => {
  const page = await mountPage(t, "trakt");
  const late = deferred();
  page.server.activity = () => late.promise;
  await page.advance(1000);
  const requests = page.server.activityRequests;
  await page.unmount();
  late.resolve(Response.json({ activeScanRun: PLEX_RUN }));
  await settle();
  await page.advance(5000);
  assert.equal(page.server.activityRequests, requests);
});

test("a Plex page locks New Plex search and single-show checks during a Trakt scan run, while clearing its cache stays available", async (t) => {
  const page = await mountPage(t, "plex", { activity: TRAKT_RUN });
  assert.equal(page.button("New Plex search")?.disabled, true);
  assert.equal(page.lockMessage(), TRAKT_LOCKS_PLEX);
  await page.click("Example Show");
  assert.equal(page.button("Force check now")?.disabled, true);
  await page.click("Plex preferences");
  assert.equal(page.button("Clear scan cache")?.disabled, false);

  page.server.activity = null;
  await page.advance(1000);
  assert.equal(page.button("New Plex search")?.disabled, false);
  assert.equal(page.lockMessage(), "");
  assert.deepEqual(page.server.starts, []);
});

test("a Plex start refused by a race shows the server's message and locks the page at once", async (t) => {
  const page = await mountPage(t, "plex", { start: () => { page.server.activity = TRAKT_RUN; return Response.json({ error: TRAKT_LOCKS_PLEX, activeScanRun: { ...TRAKT_RUN, status: { status: "running", processed: 1, total: 5 } } }, { status: 409 }); } });
  await page.click("New Plex search");
  assert.equal(page.server.starts.length, 1);
  assert.ok(page.container.querySelector(".error")?.textContent?.includes(TRAKT_LOCKS_PLEX));
  assert.equal(page.lockMessage(), TRAKT_LOCKS_PLEX);
  assert.equal(page.button("New Plex search")?.disabled, true);
});

test("a Plex page follows a Plex scan run started in another tab once, then refreshes activity on completion", async (t) => {
  const page = await mountPage(t, "plex", { statuses: [{ status: "completed", processed: 1, total: 1 }, { status: "running", processed: 1, total: 2 }, { status: "completed", processed: 2, total: 2 }] });
  assert.equal(page.server.statusRequests, 1, "the page loads its last status");
  page.server.activity = PLEX_RUN;
  await page.advance(1000);
  assert.match(page.button("Checking")?.textContent || "", /Checking 1 of 2/);
  await page.advance(1000);
  assert.equal(page.button("New Plex search")?.disabled, false);
  assert.equal(page.server.statusRequests, 3);
  await page.advance(3000);
  assert.equal(page.server.statusRequests, 3, "the same run is not followed again, and no progress loop keeps running");
});

test("a page's scan controls stay locked, with no lock message, until the first activity observation arrives", async (t) => {
  const first = deferred();
  const page = await mountPage(t, "trakt", { activity: () => first.promise });
  assert.equal(page.button("Quick scan")?.disabled, true, "scan controls are locked from the first render");
  assert.equal(page.button("Run Deep Scan")?.disabled, true);
  assert.equal(page.lockMessage(), "", "an unknown owner shows no lock message");
  await act(async () => { page.button("Quick scan")?.removeAttribute("disabled"); page.button("Quick scan")?.click(); });
  await settle();
  assert.deepEqual(page.server.starts, [], "the handler guard refuses a start while the owner is unknown");

  first.resolve(Response.json({ activeScanRun: null }));
  await settle();
  assert.equal(page.button("Quick scan")?.disabled, false);
  assert.equal(page.lockMessage(), "");
});

test("a failed first observation keeps the page locked, and polling retries until an owner is known", async (t) => {
  const page = await mountPage(t, "plex", { activity: () => Response.json({ error: "unavailable" }, { status: 500 }) });
  assert.equal(page.button("New Plex search")?.disabled, true);
  assert.equal(page.lockMessage(), "");
  await page.click("Plex preferences");
  assert.equal(page.button("Clear scan cache")?.disabled, false, "clearing the cache is not affected by an unknown owner");

  page.server.activity = () => Promise.reject(new TypeError("network down"));
  await page.advance(1000);
  assert.equal(page.button("New Plex search")?.disabled, true);

  page.server.activity = null;
  await page.advance(1000);
  assert.equal(page.button("New Plex search")?.disabled, false, "the first successful observation unlocks the page");
});
