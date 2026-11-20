import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import PlexPage from "../app/plex/page";
import { mountDom } from "./dom-environment";

// These tests pin today's Plex Clear cache behaviour through the rendered page:
// the request it sends, the message or error it shows, and what it does to the
// shown report and its cache keys.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const report = {
  shows: [
    { ratingKey: "one", title: "Example Show", plexEpisodes: 1, missing: [{ season: 1, episode: 2, sources: ["TMDB"] }] },
    { ratingKey: "two/b", title: "Other Show", plexEpisodes: 1, missing: [{ season: 1, episode: 3, sources: ["TMDB"] }] },
  ],
  lastScan: "2026-11-06T12:00:00.000Z",
  scanCache: { one: { fingerprint: "one" }, "two/b": { fingerprint: "two" } },
};

type ClearReply = () => Promise<Response>;

async function renderPlex(t: test.TestContext, clearReply: ClearReply) {
  const clears: { url: string; method?: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (url === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
    if (url === "/api/plex/state") return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (url.startsWith("/api/plex/scan") && init?.method === "DELETE") { clears.push({ url, method: init.method }); return clearReply(); }
    if (url === "/api/plex/scan" && !init?.method) return Response.json({ scan: { status: "completed", processed: 2, total: 2 }, report });
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
  };
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  await act(async () => { root.render(createElement(PlexPage)); });
  const buttons = () => Array.from(container.querySelectorAll("button"));
  async function click(label: string) {
    const button = buttons().find((element) => (element.getAttribute("aria-label") || element.textContent || "").includes(label));
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
  const errorText = () => container.querySelector(".error")?.textContent || "";
  const messages = () => Array.from(container.querySelectorAll(".cache-message")).map((element) => element.textContent);
  const cacheStatus = () => container.querySelector(".scan-cache-status")?.textContent?.split(" · ")[0];
  const showMenuOpen = () => container.querySelector(".show-action-menu") !== null;
  return { container, clears, click, confirmClear, confirmButton, shownTitles, errorText, messages, cacheStatus, showMenuOpen };
}

const cleared = (count: number) => () => Promise.resolve(Response.json({ cleared: count }));

test("Plex whole Clear cache removes the report and says how many show results were cleared", async (t) => {
  const page = await renderPlex(t, cleared(2));
  await page.click("Plex preferences");
  assert.equal(page.cacheStatus(), "Cached results for 2 shows");
  await page.click("Clear scan cache");
  await page.confirmClear();

  assert.deepEqual(page.clears, [{ url: "/api/plex/scan", method: "DELETE" }]);
  assert.deepEqual(page.messages(), ["2 cached Plex show results cleared. The next scan will rebuild them."]);
  assert.equal(page.cacheStatus(), "Cached results for 0 shows");
  assert.equal(page.confirmButton(), null, "the confirmation closes");
  await page.click("Close");
  assert.deepEqual(page.shownTitles(), [], "the report is removed");
});

test("Plex whole Clear cache reports zero when nothing was cached", async (t) => {
  const page = await renderPlex(t, () => Promise.resolve(Response.json({})));
  await page.click("Plex preferences");
  await page.click("Clear scan cache");
  await page.confirmClear();
  assert.deepEqual(page.messages(), ["0 cached Plex show results cleared. The next scan will rebuild them."]);
});

for (const failure of [
  { name: "a refused clear shows the server's error", reply: () => Promise.resolve(Response.json({ error: "Plex scan is running." }, { status: 409 })), error: "Plex scan is running." },
  { name: "a refused clear without an error shows the fallback", reply: () => Promise.resolve(new Response("nope", { status: 500 })), error: "Shelfcheck could not clear the Plex scan cache." },
  { name: "a clear that never reaches the server shows its error", reply: () => Promise.reject(new Error("Failed to fetch")), error: "Failed to fetch" },
]) {
  test(`Plex whole Clear cache: ${failure.name} and keeps the report`, async (t) => {
    const page = await renderPlex(t, failure.reply);
    await page.click("Plex preferences");
    await page.click("Clear scan cache");
    await page.confirmClear();
    assert.deepEqual(page.messages(), []);
    assert.equal(page.cacheStatus(), "Cached results for 2 shows");
    assert.equal(page.confirmButton()?.disabled, false, "the confirmation stays open and usable");
    assert.equal(page.confirmButton()?.textContent, "Clear cache");
    await page.click("Close");
    assert.match(page.errorText(), new RegExp(failure.error));
    assert.deepEqual(page.shownTitles(), ["Example Show", "Other Show"]);
  });
}

test("Plex whole Clear cache holds the clearing control until the reply arrives", async (t) => {
  const reply = deferred<Response>();
  const page = await renderPlex(t, () => reply.promise);
  await page.click("Plex preferences");
  await page.click("Clear scan cache");
  await page.confirmClear();
  assert.equal(page.confirmButton()?.textContent, "Clearing…");
  assert.equal(page.confirmButton()?.disabled, true);
  await act(async () => { reply.resolve(Response.json({ error: "busy" }, { status: 409 })); });
  assert.equal(page.confirmButton()?.textContent, "Clear cache");
  assert.equal(page.confirmButton()?.disabled, false);
});

test("Plex show Clear cache clears only that show's cache key and closes the show menu", async (t) => {
  const page = await renderPlex(t, cleared(1));
  await page.click("Other Show");
  assert.equal(page.showMenuOpen(), true);
  await page.click("Clear show's cache");

  assert.deepEqual(page.clears, [{ url: "/api/plex/scan?ratingKey=two%2Fb", method: "DELETE" }]);
  assert.equal(page.showMenuOpen(), false);
  assert.deepEqual(page.messages(), ["Other Show will be rebuilt during the next scan."]);
  assert.deepEqual(page.shownTitles(), ["Example Show", "Other Show"], "the report stays");
  await page.click("Plex preferences");
  assert.equal(page.cacheStatus(), "Cached results for 1 show");
});

test("Plex show Clear cache says when the show was not cached", async (t) => {
  const page = await renderPlex(t, cleared(0));
  await page.click("Example Show");
  await page.click("Clear show's cache");
  assert.deepEqual(page.messages(), ["Example Show was not cached."]);
});

for (const failure of [
  { name: "a refused clear shows the server's error", reply: () => Promise.resolve(Response.json({ error: "Plex scan is running." }, { status: 409 })), error: "Plex scan is running." },
  { name: "a refused clear without an error shows the fallback", reply: () => Promise.resolve(new Response("nope", { status: 500 })), error: "Shelfcheck could not clear Example Show's cache." },
  { name: "a clear that never reaches the server shows its error", reply: () => Promise.reject(new Error("Failed to fetch")), error: "Failed to fetch" },
]) {
  test(`Plex show Clear cache: ${failure.name} and keeps the cache`, async (t) => {
    const page = await renderPlex(t, failure.reply);
    await page.click("Example Show");
    await page.click("Clear show's cache");
    assert.equal(page.showMenuOpen(), false);
    assert.deepEqual(page.messages(), []);
    assert.match(page.errorText(), new RegExp(failure.error));
    assert.deepEqual(page.shownTitles(), ["Example Show", "Other Show"]);
    await page.click("Plex preferences");
    assert.equal(page.cacheStatus(), "Cached results for 2 shows");
  });
}

test("Plex show Clear cache reports a rejected request that is not an Error with the fallback", async (t) => {
  const page = await renderPlex(t, () => Promise.reject("offline"));
  await page.click("Example Show");
  await page.click("Clear show's cache");
  assert.match(page.errorText(), /Shelfcheck could not clear Example Show's cache\./);
});

test("Plex whole Clear cache reports a rejected request that is not an Error with the fallback", async (t) => {
  const page = await renderPlex(t, () => Promise.reject("offline"));
  await page.click("Plex preferences");
  await page.click("Clear scan cache");
  await page.confirmClear();
  await page.click("Close");
  assert.match(page.errorText(), /Shelfcheck could not clear the Plex scan cache\./);
});
