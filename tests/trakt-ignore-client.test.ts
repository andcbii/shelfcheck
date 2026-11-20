import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import TraktPage from "../app/trakt/page";
import { mountDom } from "./dom-environment";

// These tests pin today's Trakt Ignore behaviour through the rendered page and
// the payloads it saves, so the Ignore code can move underneath them.

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

type TraktState = { ignoredShows?: unknown[]; ignoredSeasons?: unknown[]; diagnosticsEnabled?: boolean; airingGraceDays?: number; report?: typeof report };

// A fake server with separate Trakt and Plex state. Unknown requests fail the test.
function fakeServer(initial: Partial<TraktState> = {}) {
  const trakt: TraktState = { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0, report, ...initial };
  const plex = structuredClone(plexSeed);
  const saves: { url: string; body: Record<string, unknown> }[] = [];
  const server = { trakt, plex, saves, failSaves: false };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (url === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (url === "/api/state" && !init?.method) return Response.json({ state: structuredClone(trakt) });
    if ((url === "/api/state" || url === "/api/plex/state") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      saves.push({ url, body });
      if (server.failSaves) return Response.json({ error: "failed" }, { status: 500 });
      Object.assign(url === "/api/state" ? trakt : plex.settings, body);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
  };
  return { server, fetcher };
}

async function renderTrakt(t: test.TestContext, initial: Partial<TraktState> = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { server, fetcher } = fakeServer(initial);
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
  const traktSaves = () => server.saves.filter((save) => save.url === "/api/state").map((save) => save.body);
  return { container, server, click, chooseSeasonDuration, toggleSeason, shownTitles, episodeCodes, ignoredCount, traktSaves };
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

test("Trakt shows the error and undoes nothing when an Ignore save fails", async (t) => {
  const page = await renderTrakt(t, { ignoredSeasons: [{ traktId: 202, title: "Bravo Show", seasons: [1], duration: "forever" }] });
  page.server.failSaves = true;
  await page.click("Alpha Show");
  await page.click("Ignore this show");
  await page.click("Forever");
  await page.click("IGNORED SHOWS");
  await page.click("Restore Bravo Show (▤ S01)");

  assert.equal(page.traktSaves().length, 2);
  assert.match(page.container.querySelector(".error")?.textContent || "", /Shelfcheck could not save the settings\./);
  assert.deepEqual(page.shownTitles(), ["Bravo Show"], "the failed whole-show Ignore stays applied");
  assert.deepEqual(page.episodeCodes(), ["S01E03"], "the failed season Restore stays applied");
  assert.equal(page.ignoredCount(), "1");
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
