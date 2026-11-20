import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, StrictMode } from "react";
import PlexPage from "../app/plex/page";
import { mountDom } from "./dom-environment";
import { pressEscape, pressOn, watchDocumentPointerListeners } from "./menu-closing-support";

// These tests pin how the Plex page closes its menus on an outside press or Escape.

const report = {
  shows: [{ ratingKey: "one", title: "Example Show", plexEpisodes: 1, missing: [{ season: 1, episode: 2, sources: ["TMDB"] }, { season: 2, episode: 1, sources: ["TMDB"] }] }],
  lastScan: "2026-11-06T12:00:00.000Z",
  scanCache: { one: { fingerprint: "example" } },
};

const fetcher: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === "/api/scan-runs") return Response.json({ activeScanRun: null });
  if (url === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
  if (url === "/api/plex/state" && !init?.method) return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
  if (url === "/api/plex/scan" && !init?.method) return Response.json({ scan: { status: "completed", processed: 1, total: 1 }, report });
  throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
};

async function renderPlex(t: test.TestContext, strictMode = false) {
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const pointerListeners = watchDocumentPointerListeners(t);
  await act(async () => { root.render(strictMode ? createElement(StrictMode, null, createElement(PlexPage)) : createElement(PlexPage)); });
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((element) => (element.getAttribute("aria-label") || element.textContent || "").includes(label));
    assert.ok(button, `Expected button: ${label}`);
    await act(async () => { button.click(); });
  }
  const find = (selector: string) => {
    const element = container.querySelector(selector);
    assert.ok(element, `Expected element: ${selector}`);
    return element;
  };
  const isOpen = {
    sort: () => container.querySelector(".sort-menu") !== null,
    show: () => container.querySelector(".show-action-menu") !== null,
    episode: () => container.querySelector(".plex-episode-menu") !== null,
    ignored: () => container.querySelector(".ignored-manager") !== null,
    seasons: () => container.querySelector(".season-ignore-modal") !== null,
    connection: () => container.querySelector("#plex-providers-title") !== null,
    settings: () => container.querySelector("#plex-preferences-title") !== null,
  };
  return { container, root, click, find, isOpen, pointerListeners };
}

const menus = [
  { name: "sort menu", open: "By title", key: "sort", inside: ".sort-menu" },
  { name: "show actions menu", open: "Example Show", key: "show", inside: ".show-action-menu" },
  { name: "episode menu", open: "S01E02", key: "episode", inside: ".plex-episode-menu" },
  { name: "Ignored Shows summary", open: "IGNORED SHOWS", key: "ignored", inside: ".ignored-manager" },
] as const;

for (const menu of menus) {
  test(`Plex ${menu.name} stays open on a press inside it and closes on a press outside`, async (t) => {
    const page = await renderPlex(t);
    await page.click(menu.open);
    assert.ok(page.isOpen[menu.key](), "menu opens");

    await pressOn(page.find(menu.inside));
    assert.ok(page.isOpen[menu.key](), "a press inside keeps it open");

    await pressOn(page.find("footer"));
    assert.equal(page.isOpen[menu.key](), false, "a press outside closes it");
  });
}

test("Plex outside presses leave the connection and Settings panels open", async (t) => {
  const page = await renderPlex(t);
  await page.click("Plex configured");
  await page.click("Plex preferences");
  assert.deepEqual([page.isOpen.connection(), page.isOpen.settings()], [true, true]);

  await pressOn(page.find("footer"));
  assert.deepEqual([page.isOpen.connection(), page.isOpen.settings()], [true, true]);
});

test("Plex Escape closes every open menu, the season Ignore dialog and both panels", async (t) => {
  const page = await renderPlex(t);
  await page.click("Example Show");
  await page.click("Ignore seasons");
  await page.click("Example Show");
  await page.click("S01E02");
  await page.click("By title");
  await page.click("IGNORED SHOWS");
  await page.click("Plex configured");
  await page.click("Plex preferences");
  const all = () => [page.isOpen.sort(), page.isOpen.show(), page.isOpen.episode(), page.isOpen.ignored(), page.isOpen.seasons(), page.isOpen.connection(), page.isOpen.settings()];
  assert.deepEqual(all(), [true, true, true, true, true, true, true]);

  await pressEscape();
  assert.deepEqual(all(), [false, false, false, false, false, false, false]);
});

test("Plex with no menu open listens for no presses, and a press changes nothing", async (t) => {
  const page = await renderPlex(t);
  const before = page.container.innerHTML;
  assert.equal(page.pointerListeners(), 0);
  await pressOn(page.find("footer"));
  await pressEscape();
  assert.equal(page.container.innerHTML, before);
});

test("Plex keeps one press listener under StrictMode and none after unmounting with a menu open", async (t) => {
  const page = await renderPlex(t, true);
  await page.click("By title");
  assert.equal(page.pointerListeners(), 1);
  await page.click("S01E02");
  assert.equal(page.pointerListeners(), 1);

  await act(async () => { page.root.unmount(); });
  assert.equal(page.pointerListeners(), 0);
});
