import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PlexPage from "../app/plex/page";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const report = {
  shows: [{ ratingKey: "one", title: "Example Show", plexEpisodes: 1, missing: [{ season: 1, episode: 2, sources: ["TMDB"] }] }],
  lastScan: "2026-11-06T12:00:00.000Z",
  scanCache: { one: { fingerprint: "example" } },
};
const completed = { scan: { status: "completed", processed: 1, total: 1 }, report };
const json = (body: unknown) => Response.json(body);

async function mountPage(t: test.TestContext, fetcher: typeof fetch, strictMode = false) {
  const browser = new Window({ url: "http://localhost:3000/plex" });
  const globals = {
    window: browser,
    self: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetcher,
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
  await act(async () => { root.render(strictMode ? createElement(StrictMode, null, createElement(PlexPage)) : createElement(PlexPage)); });
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((element) => (element.getAttribute("aria-label") || element.textContent || "").includes(label));
    assert.ok(button, `Expected button: ${label}`);
    await act(async () => { button.click(); });
  }
  return { container, click };
}

function configuredFetch(scanFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (input === "/api/plex/config") return json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state") return json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (input === "/api/plex/scan") return scanFetch(input, init);
    throw new Error(`Unexpected request: ${String(input)}`);
  };
}

test("Plex Restore keeps ignored results removed after a delayed scan response until a new scan", async (t) => {
  const startScan = deferred<Response>();
  const pendingReport = deferred<Response>();
  let scanning = false;
  let freshScan = false;
  const { container, click } = await mountPage(t, configuredFetch(async (_input, init) => {
    if (init?.method === "POST") {
      if (freshScan) return json({});
      scanning = true;
      return startScan.promise;
    }
    return scanning && !freshScan ? pendingReport.promise : json(completed);
  }));
  assert.equal(container.querySelectorAll(".show-list article").length, 1);

  // The scan POST is pending, so Ignore is still available on the saved report.
  await click("New Plex search");
  await click("Example Show");
  await click("Ignore this show");
  await click("Forever");
  await act(async () => { startScan.resolve(json({})); });
  // This response carries results serialized before the ignore was persisted.
  await act(async () => { pendingReport.resolve(json(completed)); });
  await click("IGNORED SHOWS");
  await click("Restore Example Show");
  await click("Close ignored shows");

  assert.equal(container.querySelectorAll(".show-list article").length, 0, "Restore must not reveal results from before Ignore");
  await click("Plex preferences");
  assert.match(container.textContent || "", /Cached results for 0 shows/);
  await click("Close");

  freshScan = true;
  await click("New Plex search");
  assert.equal(container.querySelector(".show-name-button")?.textContent, "Example Show", "a scan started after Restore can return fresh results");
  await click("Plex preferences");
  assert.match(container.textContent || "", /Cached results for 1 show/);
});

test("Plex keeps a fresh post-Restore scan when the initial report request arrives late", async (t) => {
  const initialReport = deferred<Response>();
  let firstLoad = true;
  let freshScan = false;
  const freshReport = { ...report, shows: [{ ...report.shows[0], missing: [{ season: 1, episode: 3, sources: ["TMDB"] }] }] };
  const { container, click } = await mountPage(t, configuredFetch(async (_input, init) => {
    if (init?.method === "POST") return json({});
    if (firstLoad) { firstLoad = false; return initialReport.promise; }
    return json(freshScan ? { ...completed, report: freshReport } : completed);
  }));
  await click("New Plex search");
  await click("Example Show");
  await click("Ignore this show");
  await click("Forever");
  await click("IGNORED SHOWS");
  await click("Restore Example Show");
  await click("Close ignored shows");
  freshScan = true;
  await click("New Plex search");
  await act(async () => { initialReport.resolve(json(completed)); });

  assert.equal(container.querySelector(".episode-code-tile span")?.textContent, "S01E03", "a report from an older request must not replace a fresh scan");
});

test("Plex Restore cannot expose a report that arrived before saved whole-show ignores", async (t) => {
  const settings = deferred<Response>();
  const fallback = configuredFetch(async () => json(completed));
  const { container, click } = await mountPage(t, async (input, init) => input === "/api/plex/state" && !init?.method ? settings.promise : fallback(input, init));
  assert.equal(container.querySelectorAll(".show-list article").length, 1);
  await act(async () => { settings.resolve(json({ settings: { ignoredShows: [{ ratingKey: "one", title: "Example Show" }] } })); });
  await click("IGNORED SHOWS");
  await click("Restore Example Show");
  await click("Close ignored shows");

  assert.equal(container.querySelectorAll(".show-list article").length, 0);
  await click("Plex preferences");
  assert.match(container.textContent || "", /Cached results for 0 shows/);
});

test("Plex expiry keeps delayed whole-show results removed until a new scan", async (t) => {
  const startScan = deferred<Response>();
  const pendingReport = deferred<Response>();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  let scanning = false;
  let freshScan = false;
  const { container, click } = await mountPage(t, configuredFetch(async (_input, init) => {
    if (init?.method === "POST") {
      if (freshScan) return json({});
      scanning = true;
      return startScan.promise;
    }
    return scanning && !freshScan ? pendingReport.promise : json(completed);
  }));
  await click("New Plex search");
  await click("Example Show");
  await click("Ignore this show");
  await click("30 days");
  await act(async () => { startScan.resolve(json({})); });
  await act(async () => { pendingReport.resolve(json(completed)); });
  t.mock.method(Date, "now", () => now + 31 * 86_400_000);
  await act(async () => { window.dispatchEvent(new window.Event("focus")); });
  await click("IGNORED SHOWS");

  assert.match(container.textContent || "", /No shows are ignored/);
  await click("Close ignored shows");
  assert.equal(container.querySelectorAll(".show-list article").length, 0, "expiry must not reveal delayed results from before Ignore");
  freshScan = true;
  await click("New Plex search");
  assert.equal(container.querySelector(".show-name-button")?.textContent, "Example Show");
});

test("Plex ignores an aborted old poll after Restore and a fresh scan", async (t) => {
  const abortedBody = deferred<typeof completed>();
  const currentPoll = deferred<Response>();
  const startScan = deferred<Response>();
  const pendingReport = deferred<Response>();
  const freshReport = { ...report, shows: [{ ...report.shows[0], missing: [{ season: 1, episode: 3, sources: ["TMDB"] }] }] };
  let scanGets = 0;
  let freshScan = false;
  const { container, click } = await mountPage(t, configuredFetch(async (_input, init) => {
    if (init?.method === "POST") return freshScan ? json({}) : startScan.promise;
    scanGets += 1;
    // StrictMode repeats initial loading. Both running statuses start real polls;
    // the second poll aborts the first while its body is already being parsed.
    if (scanGets <= 2) return json({ ...completed, scan: { status: "running", processed: 0, total: 1 } });
    if (scanGets === 3) return Object.assign(json({}), { json: () => abortedBody.promise });
    if (scanGets === 4) return currentPoll.promise;
    return freshScan ? json({ ...completed, report: freshReport }) : pendingReport.promise;
  }), true);
  await act(async () => { currentPoll.resolve(json(completed)); });
  await click("New Plex search");
  await click("Example Show");
  await click("Ignore this show");
  await click("Forever");
  await act(async () => { startScan.resolve(json({})); });
  await act(async () => { pendingReport.resolve(json(completed)); });
  await click("IGNORED SHOWS");
  await click("Restore Example Show");
  await click("Close ignored shows");
  assert.equal(container.querySelectorAll(".show-list article").length, 0);
  freshScan = true;
  await click("New Plex search");
  await act(async () => { abortedBody.resolve(completed); });

  assert.equal(container.querySelector(".episode-code-tile span")?.textContent, "S01E03", "an aborted older poll must not replace the post-Restore scan");
});
