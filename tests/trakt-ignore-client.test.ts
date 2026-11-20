import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import TraktPage from "../app/trakt/page";
import { mountDom } from "./dom-environment";

// These tests pin today's Trakt Ignore behaviour through the rendered page and
// the payloads it saves, so the Ignore code can move underneath them.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const alpha = { title: "Alpha Show", year: 2020, ids: { trakt: 101, slug: "alpha-show" } };
const bravo = { title: "Bravo Show", year: 2021, ids: { trakt: 202, slug: "bravo-show" } };
const report = {
  shows: [{ show: alpha }, { show: bravo }],
  missing: [
    { show: alpha, season: 1, episode: 1 },
    { show: alpha, season: 2, episode: 1 },
    { show: bravo, season: 1, episode: 3 },
  ],
  lastScan: "2026-11-18T12:00:00.000Z",
  scanCache: { "101": {}, "202": {} },
};
const plexSeed = { settings: { ignoredShows: [{ ratingKey: "plex-only", title: "Plex Only Show", duration: "forever" }], ignoredSeasons: [] } };

type TraktState = { ignoredShows?: unknown[]; ignoredSeasons?: unknown[]; diagnosticsEnabled?: boolean; airingGraceDays?: number; report?: Omit<typeof report, "scanCache"> & { scanCache: Record<string, unknown> }; scan?: unknown };

// A fake server with separate Trakt and Plex state. Unknown requests fail the test.
function fakeServer(initial: Partial<TraktState> = {}) {
  const trakt: TraktState = { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0, report, ...initial };
  const plex = structuredClone(plexSeed);
  const saves: { url: string; body: Record<string, unknown> }[] = [];
  const stateReads: (RequestInit | undefined)[] = [];
  // intercept answers a request first when it returns a response, so a test can
  // hold a save or a re-read open and decide when and how it resolves.
  const server = { trakt, plex, saves, stateReads, failSaves: false, intercept: null as null | ((url: string, init?: RequestInit) => Promise<Response> | undefined) };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/state" && !init?.method) stateReads.push(init);
    if (url === "/api/state" && init?.method === "PATCH") saves.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const intercepted = server.intercept?.(url, init);
    if (intercepted) return intercepted;
    if (url === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (url === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (url === "/api/state" && !init?.method) return Response.json({ state: structuredClone(trakt) });
    if ((url === "/api/state" || url === "/api/plex/state") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url !== "/api/state") saves.push({ url, body });
      if (server.failSaves) return Response.json({ error: "failed" }, { status: 500 });
      Object.assign(url === "/api/state" ? trakt : plex.settings, body);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
  };
  return { server, fetcher };
}

async function renderTrakt(t: test.TestContext, initial: Partial<TraktState> = {}, prepare?: (server: ReturnType<typeof fakeServer>["server"]) => void) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { server, fetcher } = fakeServer(initial);
  prepare?.(server);
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  await act(async () => { root.render(createElement(TraktPage)); });
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((element) => (element.getAttribute("aria-label") || element.textContent || "").includes(label));
    assert.ok(button, `Expected button: ${label}`);
    await act(async () => { button.click(); });
  }
  async function chooseSeasonDuration(value: string) {
    const select = container.querySelector<HTMLSelectElement>(".season-ignore-modal select");
    assert.ok(select, "season duration select");
    await act(async () => { select.value = value; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
  }
  async function toggleSeason(label: string) {
    const input = Array.from(container.querySelectorAll<HTMLLabelElement>(".season-ignore-list label")).find((element) => element.textContent?.includes(label))?.querySelector("input");
    assert.ok(input, `Expected season: ${label}`);
    await act(async () => { input.click(); });
  }
  const shownTitles = () => Array.from(container.querySelectorAll(".show-name-button")).map((element) => element.textContent);
  const episodeCodes = () => Array.from(container.querySelectorAll(".episode-code-tile")).map((element) => element.textContent);
  const ignoredCount = () => container.querySelector(".ignored-stat strong")?.textContent;
  // The Ignore manager rows as "title: expiry", with expiry the saved deadline or Forever.
  const managerRows = () => Array.from(container.querySelectorAll(".ignored-manager .ignored-row")).map((row) => `${row.querySelector('button[aria-label^="Restore "]')?.getAttribute("aria-label")?.slice("Restore ".length)}: ${row.querySelector("time")?.getAttribute("datetime") || "Forever"}`);
  const errorText = () => container.querySelector(".error")?.textContent || "";
  const traktSaves = () => server.saves.filter((save) => save.url === "/api/state").map((save) => save.body);
  const collectionCount = () => Array.from(container.querySelectorAll("div")).find((element) => element.querySelector("span")?.textContent === "SHOWS IN COLLECTION")?.querySelector("strong")?.textContent;
  // The settings dialog's cached-results line, without its latest-scan suffix.
  async function cacheStatus() {
    if (!container.querySelector(".scan-cache-status")) await click("Trakt settings");
    return container.querySelector(".scan-cache-status")?.textContent?.split(" · ")[0];
  }
  return { container, server, click, chooseSeasonDuration, toggleSeason, shownTitles, episodeCodes, ignoredCount, managerRows, errorText, traktSaves, collectionCount, cacheStatus };
}

const alphaThirtyDays = { ...alpha, duration: "30d", expiresAt: "2026-12-01T12:00:00.000Z" };

const expectedDurations = [
  { label: "30 days", duration: "30d", expiresAt: "2026-12-19T12:00:00.000Z" },
  { label: "90 days", duration: "90d", expiresAt: "2027-02-17T12:00:00.000Z" },
  { label: "6 months", duration: "6m" },
  { label: "Forever", duration: "forever" },
];

for (const expected of expectedDurations) {
  test(`Trakt Ignore this show for ${expected.label} saves the show and removes its results`, async (t) => {
    const page = await renderTrakt(t);
    assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show"]);
    await page.click("Alpha Show");
    await page.click("Ignore this show");
    await page.click(expected.label);

    assert.deepEqual(page.shownTitles(), ["Bravo Show"]);
    assert.equal(page.ignoredCount(), "1");
    const saves = page.traktSaves();
    assert.equal(saves.length, 1);
    assert.deepEqual(Object.keys(saves[0]), ["ignoredShows"]);
    const [saved] = saves[0].ignoredShows as { expiresAt?: string }[];
    if (expected.duration === "6m") {
      // Six months is a calendar step in local time: 19 May 2027, same local clock time.
      const expires = new Date(String(saved.expiresAt));
      const now = new Date(NOW);
      assert.deepEqual([expires.getFullYear(), expires.getMonth(), expires.getDate(), expires.getHours(), expires.getMinutes()], [2027, 4, 19, now.getHours(), now.getMinutes()]);
      assert.deepEqual(saves[0].ignoredShows, [{ ...alpha, duration: "6m", expiresAt: saved.expiresAt }]);
    } else {
      assert.deepEqual(saves[0].ignoredShows, [{ ...alpha, duration: expected.duration, ...(expected.expiresAt ? { expiresAt: expected.expiresAt } : {}) }]);
    }
  });
}

test("Trakt Restore of a show saves the shorter list and keeps its old results removed", async (t) => {
  const page = await renderTrakt(t, { ignoredShows: [{ ...bravo, duration: "forever" }, alphaThirtyDays] });
  assert.deepEqual(page.shownTitles(), []);
  await page.click("IGNORED SHOWS");
  await page.click("Restore Alpha Show");

  assert.deepEqual(page.traktSaves(), [{ ignoredShows: [{ ...bravo, duration: "forever" }] }]);
  assert.equal(page.ignoredCount(), "1");
  assert.deepEqual(page.shownTitles(), [], "results saved before Restore stay removed until a new scan");
});

test("Trakt Restore of a season ignore saves the shorter list and shows the season again", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [2], duration: "forever" }] });
  assert.deepEqual(page.episodeCodes(), ["S01E01", "S01E03"]);
  assert.match(page.container.textContent || "", /Ignored S02/);
  await page.click("IGNORED SHOWS");
  await page.click("Restore Alpha Show (▤ S02)");

  assert.deepEqual(page.traktSaves(), [{ ignoredSeasons: [] }]);
  assert.equal(page.ignoredCount(), "0");
  assert.deepEqual(page.episodeCodes(), ["S01E01", "S02E01", "S01E03"]);
});

test("Trakt Change duration starts a new duration from now for a show", async (t) => {
  const page = await renderTrakt(t, { ignoredShows: [alphaThirtyDays] });
  await page.click("IGNORED SHOWS");
  await page.click("Change ignore duration for Alpha Show");
  await page.click("90 days");

  assert.deepEqual(page.traktSaves(), [{ ignoredShows: [{ ...alpha, duration: "90d", expiresAt: "2027-02-17T12:00:00.000Z" }] }]);
  assert.match(page.container.textContent || "", /Until/);
});

test("Trakt Change duration to Forever clears a season ignore's expiry", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [2], duration: "30d", expiresAt: "2026-12-01T12:00:00.000Z" }] });
  await page.click("IGNORED SHOWS");
  await page.click("Change ignore duration for Alpha Show (▤ S02)");
  await page.click("Forever");

  assert.deepEqual(page.traktSaves(), [{ ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [2], duration: "forever" }] }]);
  assert.match(page.container.querySelector(".ignored-manager")?.textContent || "", /Forever/);
});

test("Trakt season save hides the chosen seasons and saves them with the chosen duration", async (t) => {
  const page = await renderTrakt(t);
  await page.click("Alpha Show");
  await page.click("Ignore seasons");
  await page.toggleSeason("Season 02");
  await page.toggleSeason("Season 01");
  await page.chooseSeasonDuration("30d");
  await page.click("Save seasons");

  assert.deepEqual(page.traktSaves(), [{ ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [1, 2], duration: "30d", expiresAt: "2026-12-19T12:00:00.000Z" }] }]);
  assert.deepEqual(page.episodeCodes(), ["S01E03"]);
  assert.equal(page.ignoredCount(), "1");
});

test("Trakt season save with an unchanged duration keeps the original deadline", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [2], duration: "30d", expiresAt: "2026-12-01T12:00:00.000Z" }] });
  await page.click("Alpha Show");
  await page.click("Ignore seasons");
  await page.toggleSeason("Season 01");
  await page.click("Save seasons");

  assert.deepEqual(page.traktSaves(), [{ ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [1, 2], duration: "30d", expiresAt: "2026-12-01T12:00:00.000Z" }] }]);
  assert.deepEqual(page.episodeCodes(), ["S01E03"]);
});

test("Trakt season save with no seasons selected removes the season ignore", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [2], duration: "forever" }] });
  await page.click("Alpha Show");
  await page.click("Ignore seasons");
  await page.toggleSeason("Season 02");
  await page.click("Save seasons");

  assert.deepEqual(page.traktSaves(), [{ ignoredSeasons: [] }]);
  assert.deepEqual(page.episodeCodes(), ["S01E01", "S02E01", "S01E03"]);
});

test("Trakt shows the error and the saved Ignore lists when Ignore saves fail", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 202, title: "Bravo Show", seasons: [1], duration: "forever" }] });
  page.server.failSaves = true;
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  await page.click("IGNORED SHOWS");
  await page.click("Restore Bravo Show (▤ S01)");

  assert.equal(page.traktSaves().length, 2);
  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.deepEqual(page.server.stateReads.slice(1).map((init) => init?.cache), ["no-store", "no-store"], "each failed save re-reads without caching");
  assert.deepEqual(page.managerRows(), ["Bravo Show (▤ S01): Forever"], "the saved lists show: no Alpha Ignore, Bravo's season Ignore kept");
  assert.equal(page.ignoredCount(), "1");
  assert.ok(!page.episodeCodes().includes("S01E03"), "Bravo's saved season Ignore hides its season again");
});

test("Trakt failed Restore of a whole-show Ignore shows the saved Ignore and keeps its pruned results removed", async (t) => {
  const page = await renderTrakt(t);
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  page.server.failSaves = true;
  await page.click("IGNORED SHOWS");
  await page.click("Restore Alpha Show");

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.deepEqual(page.managerRows(), ["Alpha Show: Forever"]);
  assert.equal(page.ignoredCount(), "1");
  assert.deepEqual(page.shownTitles(), ["Bravo Show"], "results removed by the accepted Ignore stay removed");
});

test("Trakt failed Restore of a season Ignore shows the saved season Ignore again", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [2], duration: "30d", expiresAt: "2026-12-01T12:00:00.000Z" }] });
  page.server.failSaves = true;
  await page.click("IGNORED SHOWS");
  await page.click("Restore Alpha Show (▤ S02)");

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.deepEqual(page.managerRows(), ["Alpha Show (▤ S02): 2026-12-01T12:00:00.000Z"]);
  assert.deepEqual(page.episodeCodes(), ["S01E01", "S01E03"]);
});

test("Trakt failed Change duration shows both saved lists and the saved expiry", async (t) => {
  const page = await renderTrakt(t, { ignoredShows: [alphaThirtyDays] });
  // Saved elsewhere since the page loaded: the re-read must bring in both lists.
  page.server.trakt.ignoredSeasons = [{ traktId: 202, title: "Bravo Show", seasons: [1], duration: "forever" }];
  page.server.failSaves = true;
  await page.click("IGNORED SHOWS");
  await page.click("Change ignore duration for Alpha Show");
  await page.click("90 days");

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.deepEqual(page.managerRows().sort(), ["Alpha Show: 2026-12-01T12:00:00.000Z", "Bravo Show (▤ S01): Forever"]);
  assert.equal(page.ignoredCount(), "2");
});

test("Trakt failed season save shows the saved seasons and expiry again", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [2], duration: "30d", expiresAt: "2026-12-01T12:00:00.000Z" }] });
  page.server.failSaves = true;
  await page.click("Alpha Show");
  await page.click("Ignore seasons");
  await page.toggleSeason("Season 01");
  await page.chooseSeasonDuration("90d");
  await page.click("Save seasons");

  assert.equal(page.traktSaves().length, 1);
  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.deepEqual(page.episodeCodes(), ["S01E01", "S01E03"]);
  await page.click("IGNORED SHOWS");
  assert.deepEqual(page.managerRows(), ["Alpha Show (▤ S02): 2026-12-01T12:00:00.000Z"]);
});

test("Trakt shows what the server saved, not the pre-click lists, when a failed save was kept", async (t) => {
  const page = await renderTrakt(t, { ignoredShows: [alphaThirtyDays] });
  page.server.intercept = (url, init) => {
    if (url !== "/api/state" || init?.method !== "PATCH") return undefined;
    Object.assign(page.server.trakt, JSON.parse(String(init.body)));
    return Promise.resolve(Response.json({ error: "failed" }, { status: 500 }));
  };
  await page.click("IGNORED SHOWS");
  await page.click("Change ignore duration for Alpha Show");
  await page.click("90 days");

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.deepEqual(page.managerRows(), ["Alpha Show: 2027-02-17T12:00:00.000Z"]);
});

const unusableRereads: [string, () => Promise<Response>][] = [
  ["a non-ok re-read", async () => Response.json({ error: "down" }, { status: 503 })],
  ["a rejected re-read", async () => { throw new TypeError("offline"); }],
  ["an unreadable re-read body", async () => new Response("not json", { headers: { "Content-Type": "application/json" } })],
  ["a null saved state", async () => Response.json({ state: null })],
];

for (const [name, reread] of unusableRereads) {
  test(`Trakt keeps the current view and shows the save error after ${name}`, async (t) => {
    const page = await renderTrakt(t, { ignoredShows: [alphaThirtyDays] });
    page.server.failSaves = true;
    page.server.intercept = (url, init) => url === "/api/state" && !init?.method ? reread() : undefined;
    await page.click("IGNORED SHOWS");
    await page.click("Restore Alpha Show");

    assert.equal(page.server.stateReads.length, 2, "the failed save re-read the saved state");
    assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
    assert.equal(page.ignoredCount(), "0", "the Restore stays shown");
  });
}

test("Trakt shows only the error when an Ignore save cannot reach the server", async (t) => {
  const page = await renderTrakt(t, { ignoredShows: [alphaThirtyDays] });
  page.server.intercept = (url, init) => url === "/api/state" && init?.method === "PATCH" ? Promise.reject(new TypeError("Failed to fetch")) : undefined;
  await page.click("IGNORED SHOWS");
  await page.click("Restore Alpha Show");

  assert.match(page.errorText(), /Failed to fetch/);
  assert.equal(page.server.stateReads.length, 1, "no re-read after a network failure");
  assert.equal(page.ignoredCount(), "0");
});

test("Trakt ignores a failed save's late re-read once a newer Ignore edit of either list has started", async (t) => {
  const page = await renderTrakt(t);
  const reread = deferred<Response>();
  page.server.failSaves = true;
  page.server.intercept = (url, init) => url === "/api/state" && !init?.method ? reread.promise : undefined;
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  assert.equal(page.server.stateReads.length, 2, "the failed whole-show save is re-reading");

  page.server.failSaves = false;
  await page.click("Bravo Show");
  await page.click("Ignore seasons");
  await page.toggleSeason("Season 01");
  await page.click("Save seasons");
  await act(async () => { reread.resolve(Response.json({ state: { ignoredShows: [], ignoredSeasons: [], report } })); });

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  await page.click("IGNORED SHOWS");
  assert.deepEqual(page.managerRows().sort(), ["Alpha Show: Forever", "Bravo Show (▤ S01): Forever"], "neither list goes back to the stale re-read");
  assert.deepEqual(page.shownTitles(), [], "the report is unchanged");
});

test("Trakt reconciles a failed Ignore save without overwriting a newer diagnostics save or the grace period", async (t) => {
  const page = await renderTrakt(t, { ignoredShows: [alphaThirtyDays], airingGraceDays: 7 });
  const reread = deferred<Response>();
  page.server.intercept = (url, init) => {
    if (url !== "/api/state") return undefined;
    if (!init?.method) return reread.promise;
    if ("ignoredShows" in JSON.parse(String(init.body))) return Promise.resolve(Response.json({ error: "failed" }, { status: 500 }));
    return undefined;
  };
  await page.click("IGNORED SHOWS");
  await page.click("Restore Alpha Show");
  await page.click("IGNORED SHOWS");
  await page.click("Trakt settings");
  const diagnostics = page.container.querySelector<HTMLInputElement>(".diagnostics-toggle input");
  assert.ok(diagnostics, "diagnostics toggle");
  await act(async () => { diagnostics.click(); });
  // The re-read was taken before the diagnostics save landed: it carries older unrelated values.
  await act(async () => { reread.resolve(Response.json({ state: { ignoredShows: [alphaThirtyDays], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0, report } })); });

  assert.deepEqual(page.traktSaves(), [{ ignoredShows: [] }, { diagnosticsEnabled: false }]);
  assert.equal(page.ignoredCount(), "1", "the failed Restore reconciles to the saved Ignore");
  assert.equal(diagnostics.checked, false, "the newer diagnostics setting stays");
  assert.equal(page.container.querySelector<HTMLInputElement>('input[aria-label="Airing grace period in days"]')?.value, "7", "the grace period is not replaced by the re-read");
});

test("Trakt Ignore edits save only to the Trakt state and leave the Plex Ignore list alone", async (t) => {
  const page = await renderTrakt(t);
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  await page.click("Bravo Show");
  await page.click("Ignore seasons");
  await page.toggleSeason("Season 01");
  await page.click("Save seasons");
  await page.click("IGNORED SHOWS");
  await page.click("Change ignore duration for Alpha Show");
  await page.click("30 days");
  await page.click("Restore Bravo Show (▤ S01)");

  assert.deepEqual(page.server.saves.map((save) => save.url), ["/api/state", "/api/state", "/api/state", "/api/state"]);
  assert.deepEqual(page.server.plex, plexSeed, "the Plex Ignore list is unchanged");
  assert.deepEqual(page.server.trakt.ignoredShows, [{ ...alpha, duration: "30d", expiresAt: "2026-12-19T12:00:00.000Z" }]);
  assert.deepEqual(page.server.trakt.ignoredSeasons, []);
});

test("Trakt brings back a cached show's results, episodes and cache when the server confirms its Ignore was not saved", async (t) => {
  const page = await renderTrakt(t);
  page.server.failSaves = true;
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.equal(page.ignoredCount(), "0");
  assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show"]);
  assert.deepEqual(page.episodeCodes().sort(), ["S01E01", "S01E03", "S02E01"]);
  assert.equal(page.collectionCount(), "2");
  assert.equal(await page.cacheStatus(), "Cached results for 2 shows");
});

test("Trakt brings back an uncached show without adding a cache key when its Ignore was not saved", async (t) => {
  const page = await renderTrakt(t, { report: { ...report, scanCache: { "202": {} } } });
  assert.equal(await page.cacheStatus(), "Cached results for 1 show");
  page.server.failSaves = true;
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");

  assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show"]);
  assert.deepEqual(page.episodeCodes().sort(), ["S01E01", "S01E03", "S02E01"]);
  assert.equal(page.collectionCount(), "2");
  assert.equal(await page.cacheStatus(), "Cached results for 1 show");
});

test("Trakt keeps a show's results removed when the server kept its Ignore despite the error", async (t) => {
  const page = await renderTrakt(t);
  page.server.intercept = (url, init) => {
    if (url !== "/api/state" || init?.method !== "PATCH") return undefined;
    Object.assign(page.server.trakt, JSON.parse(String(init.body)));
    return Promise.resolve(Response.json({ error: "failed" }, { status: 500 }));
  };
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.equal(page.ignoredCount(), "1");
  assert.deepEqual(page.shownTitles(), ["Bravo Show"]);
  assert.equal(page.collectionCount(), "1");
  assert.equal(await page.cacheStatus(), "Cached results for 1 show");
});

test("Trakt restored episodes stay filtered by a separate season Ignore", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 101, title: "Alpha Show", seasons: [2], duration: "forever" }] });
  page.server.failSaves = true;
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");

  assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show"]);
  assert.deepEqual(page.episodeCodes(), ["S01E01", "S01E03"]);
});

// Holds the failed Ignore's re-read open; it later confirms no Ignore was saved.
function holdReread(page: Awaited<ReturnType<typeof renderTrakt>>) {
  const reread = deferred<Response>();
  page.server.failSaves = true;
  page.server.intercept = (url, init) => url === "/api/state" && !init?.method && page.server.stateReads.length === 2 ? reread.promise : undefined;
  return async () => { await act(async () => { reread.resolve(Response.json({ state: { ignoredShows: [], ignoredSeasons: [], report } })); }); };
}

test("Trakt does not bring back results after a new scan started before the late rollback", async (t) => {
  const page = await renderTrakt(t);
  const resolveReread = holdReread(page);
  const scanStart = deferred<Response>();
  const intercept = page.server.intercept;
  page.server.intercept = (url, init) => url === "/api/scan" && init?.method === "POST" ? scanStart.promise : intercept?.(url, init);
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  await page.click("Quick scan");
  await resolveReread();

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.equal(page.ignoredCount(), "0");
  assert.deepEqual(page.shownTitles(), ["Bravo Show"], "the pre-scan rows stay removed");
  assert.equal(await page.cacheStatus(), "Cached results for 1 show");
  await act(async () => { scanStart.resolve(Response.json({ error: "stopped" }, { status: 500 })); });
});

test("Trakt does not bring back results or the cache key after the cache was cleared before the late rollback", async (t) => {
  const page = await renderTrakt(t);
  const resolveReread = holdReread(page);
  const intercept = page.server.intercept;
  page.server.intercept = (url, init) => url === "/api/scan" && init?.method === "DELETE" ? Promise.resolve(Response.json({ cleared: 1 })) : intercept?.(url, init);
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  await page.click("Trakt settings");
  await page.click("Clear scan cache");
  await page.click("Clear cache");
  assert.equal(await page.cacheStatus(), "Cached results for 0 shows");
  await resolveReread();

  assert.equal(page.ignoredCount(), "0");
  assert.deepEqual(page.shownTitles(), ["Bravo Show"], "unrelated rows survive; the target is not brought back");
  assert.equal(await page.cacheStatus(), "Cached results for 0 shows", "the cleared key is not added back");
});

const charlie = { title: "Charlie Show", year: 2022, ids: { trakt: 303, slug: "charlie-show" } };
const newerReport = {
  shows: [{ show: alpha }, { show: bravo }, { show: charlie }],
  missing: [
    { show: alpha, season: 1, episode: 1 },
    { show: bravo, season: 1, episode: 3 },
    { show: bravo, season: 1, episode: 4 },
    { show: charlie, season: 1, episode: 1 },
  ],
  lastScan: "2026-11-19T11:00:00.000Z",
  scanCache: { "101": {}, "202": {}, "303": {} },
};

test("Trakt keeps a newer report loaded before the late rollback instead of the captured rows", async (t) => {
  const reread = deferred<Response>();
  const scanStatus = deferred<Response>();
  // A scan is already running at load; its status poll is held until the test completes it.
  const page = await renderTrakt(t, { scan: { status: "running", processed: 1, total: 2 } }, (server) => {
    server.intercept = (url, init) => {
      if (url === "/api/scan" && !init?.method) return scanStatus.promise;
      if (url !== "/api/state" || init?.method) return undefined;
      if (server.stateReads.length === 2) return reread.promise;
      if (server.stateReads.length === 3) return Promise.resolve(Response.json({ state: { ignoredShows: [], ignoredSeasons: [], report: newerReport } }));
      return undefined;
    };
  });
  page.server.failSaves = true;
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  await act(async () => { scanStatus.resolve(Response.json({ scan: { status: "completed", processed: 2, total: 2 } })); });
  assert.deepEqual(page.shownTitles(), ["Bravo Show", "Charlie Show"], "the newer report loaded, still without the Ignored show");
  await act(async () => { reread.resolve(Response.json({ state: { ignoredShows: [], ignoredSeasons: [], report } })); });

  assert.match(page.errorText(), /Shelfcheck could not save the settings\./);
  assert.equal(page.ignoredCount(), "0");
  assert.deepEqual(page.shownTitles(), ["Bravo Show", "Charlie Show"], "the captured Alpha rows do not come back over the newer report");
  assert.deepEqual(page.episodeCodes(), ["S01E03", "S01E04", "S01E01"]);
  assert.equal(page.collectionCount(), "2");
  assert.equal(await page.cacheStatus(), "Cached results for 2 shows");
});

// A scan is running at load; its status poll is held until the test completes it with newerReport.
async function renderDuringScan(t: test.TestContext) {
  const scanStatus = deferred<Response>();
  const page = await renderTrakt(t, { scan: { status: "running", processed: 1, total: 2 } }, (server) => {
    server.intercept = (url, init) => url === "/api/scan" && !init?.method ? scanStatus.promise : undefined;
  });
  async function completeScan() {
    page.server.trakt.report = newerReport;
    await act(async () => { scanStatus.resolve(Response.json({ scan: { status: "completed", processed: 2, total: 2 } })); });
  }
  return { page, completeScan };
}

test("Trakt lets the scan's report show a show again once its rejected Ignore is rolled back", async (t) => {
  const { page, completeScan } = await renderDuringScan(t);
  page.server.failSaves = true;
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  await completeScan();

  assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show", "Charlie Show"]);
  assert.equal(await page.cacheStatus(), "Cached results for 3 shows");
});
