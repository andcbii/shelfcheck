import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import TraktPage from "../app/trakt/page";
import { mountDom } from "./dom-environment";

// These tests pin today's Trakt Clear cache behaviour through the rendered page:
// the request it sends, the message or error it shows, and what it does to the
// shown results and their cache keys.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const alpha = { title: "Alpha Show", year: 2020, ids: { trakt: 101, slug: "alpha-show" } };
const bravo = { title: "Bravo Show", year: 2021, ids: { trakt: 202, slug: "bravo-show" } };
const report = {
  shows: [{ show: alpha }, { show: bravo }],
  missing: [{ show: alpha, season: 1, episode: 1 }, { show: bravo, season: 1, episode: 3 }],
  lastScan: "2026-11-18T12:00:00.000Z",
  scanCache: { "101": {}, "202": {} },
};

type ClearReply = () => Promise<Response>;

async function renderTrakt(t: test.TestContext, clearReply: ClearReply) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T12:00:00.000Z") });
  const clears: { url: string; method?: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (url === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (url === "/api/state" && !init?.method) return Response.json({ state: { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0, report } });
    if (url === "/api/plex/state" && !init?.method) return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (url.startsWith("/api/scan") && init?.method === "DELETE") { clears.push({ url, method: init.method }); return clearReply(); }
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
  };
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
  const confirmButton = () => container.querySelector<HTMLButtonElement>(".cache-clear-confirm");
  async function confirmClear() {
    const button = confirmButton();
    assert.ok(button, "Clear cache confirmation");
    await act(async () => { button.click(); });
  }
  const shownTitles = () => Array.from(container.querySelectorAll(".show-name-button")).map((element) => element.textContent);
  const episodeCodes = () => Array.from(container.querySelectorAll(".episode-code-tile")).map((element) => element.textContent);
  const errorText = () => container.querySelector(".error")?.textContent || "";
  const messages = () => Array.from(container.querySelectorAll(".cache-message")).map((element) => element.textContent);
  const cacheStatus = () => container.querySelector(".scan-cache-status")?.textContent?.split(" · ")[0];
  const showMenuOpen = () => container.querySelector(".show-action-menu") !== null;
  return { clears, click, confirmClear, confirmButton, shownTitles, episodeCodes, errorText, messages, cacheStatus, showMenuOpen };
}

const cleared = (count: number) => () => Promise.resolve(Response.json({ cleared: count }));

test("Trakt whole Clear cache keeps the shown results, empties their cache keys and says how many were cleared", async (t) => {
  const page = await renderTrakt(t, cleared(2));
  await page.click("Trakt settings");
  assert.equal(page.cacheStatus(), "Cached results for 2 shows");
  await page.click("Clear scan cache");
  await page.confirmClear();

  assert.deepEqual(page.clears, [{ url: "/api/scan", method: "DELETE" }]);
  assert.deepEqual(page.messages(), ["2 cached show results cleared. The next scan will rebuild them."]);
  assert.equal(page.cacheStatus(), "Cached results for 0 shows");
  assert.equal(page.confirmButton(), null, "the confirmation closes");
  await page.click("Close");
  assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show"], "the results stay");
  assert.equal(page.episodeCodes().length, 2);
});

test("Trakt whole Clear cache reports zero when nothing was cached", async (t) => {
  const page = await renderTrakt(t, () => Promise.resolve(Response.json({})));
  await page.click("Trakt settings");
  await page.click("Clear scan cache");
  await page.confirmClear();
  assert.deepEqual(page.messages(), ["0 cached show results cleared. The next scan will rebuild them."]);
});

for (const failure of [
  { name: "a refused clear shows the server's error", reply: () => Promise.resolve(Response.json({ error: "A scan is running." }, { status: 409 })), error: "A scan is running." },
  { name: "a refused clear without an error shows the fallback", reply: () => Promise.resolve(new Response("nope", { status: 500 })), error: "Shelfcheck could not clear the scan cache." },
  { name: "a clear that never reaches the server shows its error", reply: () => Promise.reject(new Error("Failed to fetch")), error: "Failed to fetch" },
  { name: "a rejected request that is not an Error shows the fallback", reply: () => Promise.reject("offline"), error: "Shelfcheck could not clear the scan cache." },
]) {
  test(`Trakt whole Clear cache: ${failure.name} and keeps the cache`, async (t) => {
    const page = await renderTrakt(t, failure.reply);
    await page.click("Trakt settings");
    await page.click("Clear scan cache");
    await page.confirmClear();
    assert.deepEqual(page.messages(), []);
    assert.equal(page.cacheStatus(), "Cached results for 2 shows");
    assert.equal(page.confirmButton()?.disabled, false, "the confirmation stays open and usable");
    assert.equal(page.confirmButton()?.textContent, "Clear cache");
    await page.click("Close");
    assert.ok(page.errorText().includes(failure.error), page.errorText());
    assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show"]);
  });
}

test("Trakt whole Clear cache holds the clearing control until the reply arrives", async (t) => {
  const reply = deferred<Response>();
  const page = await renderTrakt(t, () => reply.promise);
  await page.click("Trakt settings");
  await page.click("Clear scan cache");
  await page.confirmClear();
  assert.equal(page.confirmButton()?.textContent, "Clearing…");
  assert.equal(page.confirmButton()?.disabled, true);
  await act(async () => { reply.resolve(Response.json({ error: "busy" }, { status: 409 })); });
  assert.equal(page.confirmButton()?.textContent, "Clear cache");
  assert.equal(page.confirmButton()?.disabled, false);
});

test("Trakt show Clear cache clears only that show's cache key and closes the show menu", async (t) => {
  const page = await renderTrakt(t, cleared(1));
  await page.click("Bravo Show");
  assert.equal(page.showMenuOpen(), true);
  await page.click("Clear show's cache");

  assert.deepEqual(page.clears, [{ url: "/api/scan?traktId=202", method: "DELETE" }]);
  assert.equal(page.showMenuOpen(), false);
  assert.deepEqual(page.messages(), ["Bravo Show will be rebuilt during the next scan."]);
  assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show"], "the results stay");
  await page.click("Trakt settings");
  assert.equal(page.cacheStatus(), "Cached results for 1 show");
});

test("Trakt show Clear cache says when the show was not cached", async (t) => {
  const page = await renderTrakt(t, cleared(0));
  await page.click("Alpha Show");
  await page.click("Clear show's cache");
  assert.deepEqual(page.messages(), ["Alpha Show was not cached."]);
});

for (const failure of [
  { name: "a refused clear shows the server's error", reply: () => Promise.resolve(Response.json({ error: "A scan is running." }, { status: 409 })), error: "A scan is running." },
  { name: "a refused clear without an error shows the fallback", reply: () => Promise.resolve(new Response("nope", { status: 500 })), error: "Shelfcheck could not clear Alpha Show's cache." },
  { name: "a clear that never reaches the server shows its error", reply: () => Promise.reject(new Error("Failed to fetch")), error: "Failed to fetch" },
  { name: "a rejected request that is not an Error shows the fallback", reply: () => Promise.reject("offline"), error: "Shelfcheck could not clear Alpha Show's cache." },
]) {
  test(`Trakt show Clear cache: ${failure.name} and keeps the cache`, async (t) => {
    const page = await renderTrakt(t, failure.reply);
    await page.click("Alpha Show");
    await page.click("Clear show's cache");
    assert.equal(page.showMenuOpen(), false);
    assert.deepEqual(page.messages(), []);
    assert.ok(page.errorText().includes(failure.error), page.errorText());
    assert.deepEqual(page.shownTitles(), ["Alpha Show", "Bravo Show"]);
    await page.click("Trakt settings");
    assert.equal(page.cacheStatus(), "Cached results for 2 shows");
  });
}
