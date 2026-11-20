import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import TraktPage from "../app/trakt/page";
import { pressEscape, pressOn, renderPage } from "./menu-closing-support";

// These tests pin how the Trakt page closes its menus on an outside press or Escape.

const alpha = { title: "Alpha Show", year: 2020, ids: { trakt: 101, slug: "alpha-show" } };
const bravo = { title: "Bravo Show", year: 2021, ids: { trakt: 202, slug: "bravo-show" } };
const state = {
  ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0,
  report: {
    shows: [{ show: alpha }, { show: bravo }],
    missing: [{ show: alpha, season: 1, episode: 1 }, { show: alpha, season: 2, episode: 1 }, { show: bravo, season: 1, episode: 3 }],
    lastScan: "2026-11-18T12:00:00.000Z",
    scanCache: { "101": {}, "202": {} },
  },
};

const fetcher: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === "/api/scan-runs") return Response.json({ activeScanRun: null });
  if (url === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
  if (url === "/api/state" && !init?.method) return Response.json({ state: structuredClone(state) });
  throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
};

async function renderTrakt(t: test.TestContext, strictMode = false) {
  const page = await renderPage(t, TraktPage, fetcher, strictMode);
  const isOpen = {
    sort: page.has(".sort-menu"),
    show: page.has(".show-action-menu"),
    ignored: page.has(".ignored-manager"),
    seasons: page.has(".season-ignore-modal"),
  };
  return { ...page, isOpen };
}

const menus = [
  { name: "sort menu", open: "By title", key: "sort", inside: ".sort-menu" },
  { name: "show actions menu", open: "Alpha Show", key: "show", inside: ".show-action-menu" },
  { name: "Ignored Shows manager", open: "IGNORED SHOWS", key: "ignored", inside: ".ignored-manager" },
] as const;

for (const menu of menus) {
  test(`Trakt ${menu.name} stays open on a press inside it and closes on a press outside`, async (t) => {
    const page = await renderTrakt(t);
    await page.click(menu.open);
    assert.ok(page.isOpen[menu.key](), "menu opens");

    await pressOn(page.find(menu.inside));
    assert.ok(page.isOpen[menu.key](), "a press inside keeps it open");

    await pressOn(page.find("footer"));
    assert.equal(page.isOpen[menu.key](), false, "a press outside closes it");
  });
}

test("Trakt Escape closes every open menu and the season Ignore dialog", async (t) => {
  const page = await renderTrakt(t);
  await page.click("Alpha Show");
  await page.click("Ignore seasons");
  await page.click("Alpha Show");
  await page.click("By title");
  await page.click("IGNORED SHOWS");
  assert.deepEqual([page.isOpen.sort(), page.isOpen.show(), page.isOpen.ignored(), page.isOpen.seasons()], [true, true, true, true]);

  await pressEscape();
  assert.deepEqual([page.isOpen.sort(), page.isOpen.show(), page.isOpen.ignored(), page.isOpen.seasons()], [false, false, false, false]);
});

test("Trakt with no menu open listens for no presses or keys, and a press changes nothing", async (t) => {
  const page = await renderTrakt(t);
  const before = page.container.innerHTML;
  assert.deepEqual(page.listeners(), { pointerdown: 0, keydown: 0 });
  await pressOn(page.find("footer"));
  await pressEscape();
  assert.equal(page.container.innerHTML, before);
});

test("Trakt keeps one press and one key listener under StrictMode and none after unmounting with a menu open", async (t) => {
  const page = await renderTrakt(t, true);
  await page.click("By title");
  assert.deepEqual(page.listeners(), { pointerdown: 1, keydown: 1 });
  await page.click("Alpha Show");
  assert.deepEqual(page.listeners(), { pointerdown: 1, keydown: 1 });

  await act(async () => { page.root.unmount(); });
  assert.deepEqual(page.listeners(), { pointerdown: 0, keydown: 0 });
});
