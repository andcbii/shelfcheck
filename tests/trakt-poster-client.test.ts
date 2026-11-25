import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import TraktPage from "../app/trakt/page";
import { TraktPoster } from "../app/components/trakt-poster";
import { mountDom } from "./dom-environment";
import { installWindowClock } from "./window-clock";
import type { PlexArtworkEntry } from "../lib/plex-artwork";
import type { TraktShow } from "../lib/trakt-model";

type Ids = TraktShow["ids"];
type IndexEntry = PlexArtworkEntry;

const GUID = "5d9c083cffd9ef001e990367";
const OTHER_GUID = "6e9c083cffd9ef001e990368";
const traktPoster = (id: number) => `media.trakt.tv/shows/${id}/medium/poster.webp`;
const traktSrc = (id: number) => `/api/poster?src=${encodeURIComponent(traktPoster(id))}`;
const plexSrc = (thumb: string) => `/api/plex/poster?thumb=${encodeURIComponent(thumb)}`;
const thumb = (ratingKey: string) => `/library/metadata/${ratingKey}/thumb/1700000000`;

function traktShow(title: string, ids: Omit<Ids, "slug">, poster?: string) {
  return { title, year: 2020, ids: { slug: title.toLowerCase().replace(/\W+/g, "-"), ...ids }, ...(poster ? { images: { poster: [poster] } } : {}), collection: { aired: 4, completed: 1 } };
}

function reportOf(shows: ReturnType<typeof traktShow>[]) {
  return { shows: shows.map((show) => ({ show })), missing: shows.map((show) => ({ show, season: 1, episode: 1, firstAired: "2001-01-01T20:00:00.000Z" })), lastScan: "2026-11-20T12:00:00.000Z" };
}

/** A controllable answer for the artwork index: resolve it with entries, fail it, or leave it pending. */
function deferredIndex() {
  let settle!: (response: Response) => void;
  const answer = new Promise<Response>((resolve) => { settle = resolve; });
  return { answer, resolve: (shows: IndexEntry[]) => settle(Response.json({ shows })), fail: () => settle(new Response("nope", { status: 500 })) };
}

async function mountTrakt(t: test.TestContext, shows: ReturnType<typeof traktShow>[], index: readonly IndexEntry[] | Promise<Response> | "reject") {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method || "GET"} ${url}`);
    if (url === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (url === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (url === "/api/state" && init?.method === "PATCH") return Response.json({});
    if (url === "/api/state") return Response.json({ state: { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0, report: reportOf(shows) } });
    if (url === "/api/plex/artwork") {
      assert.equal(init?.cache, "no-store");
      if (index === "reject") throw new TypeError("Failed to fetch");
      return index instanceof Promise ? index : Response.json({ shows: index });
    }
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
  };
  const { browser, container, root } = mountDom(t, { self: undefined, navigator: undefined, Element: undefined, fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  installWindowClock(t, browser, new Date(2026, 10, 21, 12, 0));
  await act(async () => { root.render(createElement(TraktPage)); });
  const article = (title: string) => Array.from(container.querySelectorAll("article")).find((element) => element.querySelector(".show-name-button")?.textContent === title)!;
  /** The poster a show displays: its image source, or its initials when it has none. */
  const poster = (title: string) => {
    const box = article(title).querySelector(".show-index")!;
    const image = box.querySelector("img");
    return image ? image.getAttribute("src") : `initials ${box.querySelector("span")?.textContent}`;
  };
  const fire = async (title: string, type: "load" | "error") => {
    await act(async () => { article(title).querySelector(".show-index img")!.dispatchEvent(new browser.Event(type) as unknown as Event); });
  };
  const settle = () => act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
  return { poster, fire, settle, requests, artworkRequests: () => requests.filter((request) => request === "GET /api/plex/artwork").length };
}

test("a Trakt poster that loads is kept, and the Plex index never delays it", async (t) => {
  const index = deferredIndex();
  const page = await mountTrakt(t, [traktShow("Alpha", { trakt: 1, plex: { guid: GUID } }, traktPoster(1))], index.answer);
  assert.equal(page.poster("Alpha"), traktSrc(1), "the Trakt poster shows before the index arrives");
  await page.fire("Alpha", "load");
  index.resolve([{ ratingKey: "10", plexGuids: [`plex://show/${GUID}`], thumb: thumb("10") }]);
  await page.settle();
  assert.equal(page.poster("Alpha"), traktSrc(1), "a loaded Trakt poster never falls back");
  assert.equal(page.artworkRequests(), 1);
});

test("a show without a Trakt poster link uses its Plex artwork once the index arrives", async (t) => {
  const index = deferredIndex();
  const page = await mountTrakt(t, [traktShow("Bravo", { trakt: 2, plex: { guid: GUID } })], index.answer);
  assert.equal(page.poster("Bravo"), "initials BR");
  index.resolve([{ ratingKey: "10", plexGuids: [`plex://show/${GUID}`], thumb: thumb("10") }]);
  await page.settle();
  assert.equal(page.poster("Bravo"), plexSrc(thumb("10")));
});

test("a failed Trakt poster falls back to Plex, and a failed Plex image to initials, without looping", async (t) => {
  const page = await mountTrakt(t, [traktShow("Charlie", { trakt: 3, tmdb: 300 }, traktPoster(3))], [{ ratingKey: "30", plexGuids: [], tmdbId: 300, thumb: thumb("30") }]);
  await page.settle();
  assert.equal(page.poster("Charlie"), traktSrc(3));
  await page.fire("Charlie", "error");
  assert.equal(page.poster("Charlie"), plexSrc(thumb("30")));
  await page.fire("Charlie", "error");
  assert.equal(page.poster("Charlie"), "initials CH");
  await page.settle();
  assert.equal(page.poster("Charlie"), "initials CH", "neither source is retried");
  assert.equal(page.artworkRequests(), 1);
});

test("a failed Trakt poster recovers with Plex artwork that arrives later", async (t) => {
  const index = deferredIndex();
  const page = await mountTrakt(t, [traktShow("Delta", { trakt: 4, tvdb: 400 }, traktPoster(4))], index.answer);
  await page.fire("Delta", "error");
  assert.equal(page.poster("Delta"), "initials DE");
  index.resolve([{ ratingKey: "40", plexGuids: [], tvdbId: 400, thumb: thumb("40") }]);
  await page.settle();
  assert.equal(page.poster("Delta"), plexSrc(thumb("40")));
});

for (const [name, index] of [["fails", "reject"], ["answers with an error", Promise.resolve(new Response("down", { status: 500 }))], ["is empty", []]] as const) {
  test(`the Trakt report stays usable when the Plex artwork index ${name}`, async (t) => {
    const page = await mountTrakt(t, [traktShow("Echo", { trakt: 5, plex: { guid: GUID } }, traktPoster(5)), traktShow("Foxtrot", { trakt: 6, plex: { guid: GUID } })], index);
    await page.settle();
    assert.equal(page.poster("Echo"), traktSrc(5));
    assert.equal(page.poster("Foxtrot"), "initials FO");
    await page.fire("Echo", "error");
    assert.equal(page.poster("Echo"), "initials EC");
  });
}

test("a Trakt show matches its Plex show by bare or prefixed GUID, against the GUID and every alias", async (t) => {
  const page = await mountTrakt(t, [
    traktShow("Bare", { trakt: 7, plex: { guid: GUID } }),
    traktShow("Prefixed", { trakt: 8, plex: { guid: `plex://show/${OTHER_GUID}` } }),
    traktShow("Upper", { trakt: 9, plex: { guid: GUID.toUpperCase() } }),
  ], [
    { ratingKey: "70", plexGuids: [`plex://show/${"a".repeat(24)}`, `plex://show/${GUID}`], thumb: thumb("70") },
    { ratingKey: "80", plexGuids: [`plex://show/${OTHER_GUID}`], thumb: thumb("80") },
  ]);
  await page.settle();
  assert.equal(page.poster("Bare"), plexSrc(thumb("70")), "a bare GUID matches an alias");
  assert.equal(page.poster("Prefixed"), plexSrc(thumb("80")), "a prefixed GUID is not prefixed twice");
  assert.equal(page.poster("Upper"), plexSrc(thumb("70")));
});

test("a GUID match wins over conflicting TMDB and TVDB matches, which apply in turn without one", async (t) => {
  const page = await mountTrakt(t, [
    traktShow("Guid First", { trakt: 11, tmdb: 1100, tvdb: 1101, plex: { guid: GUID } }),
    traktShow("Tmdb Next", { trakt: 12, tmdb: 1100, tvdb: 1201, plex: { guid: OTHER_GUID } }),
    traktShow("Tvdb Last", { trakt: 13, tmdb: 1300, tvdb: 1101 }),
    traktShow("Guid Without Art", { trakt: 14, tmdb: 1100, plex: { guid: "b".repeat(24) } }),
  ], [
    { ratingKey: "110", plexGuids: [`plex://show/${GUID}`], thumb: thumb("110") },
    { ratingKey: "111", plexGuids: [], tmdbId: 1100, thumb: thumb("111") },
    { ratingKey: "112", plexGuids: [], tvdbId: 1101, thumb: thumb("112") },
    { ratingKey: "140", plexGuids: [`plex://show/${"b".repeat(24)}`] },
  ]);
  await page.settle();
  assert.equal(page.poster("Guid First"), plexSrc(thumb("110")));
  assert.equal(page.poster("Tmdb Next"), plexSrc(thumb("111")), "an unmatched GUID falls through to TMDB");
  assert.equal(page.poster("Tvdb Last"), plexSrc(thumb("112")));
  assert.equal(page.poster("Guid Without Art"), "initials GU", "a GUID match without artwork never borrows another show's");
});

test("absent, malformed or invalid IDs and thumbnails never match", async (t) => {
  const page = await mountTrakt(t, [
    traktShow("Old Shape", { trakt: 21 }),
    traktShow("Nulls", { trakt: 22, tvdb: null, plex: { guid: null, slug: null } }),
    traktShow("Malformed", { trakt: 23, tmdb: 0, plex: { guid: "plex://movie/" + GUID } }),
    traktShow("Bad Thumb", { trakt: 24, tmdb: 2400 }),
  ], [
    { ratingKey: "200", plexGuids: [] , thumb: thumb("200") },
    { ratingKey: "201", plexGuids: [`plex://movie/${GUID}`, "plex://show/"], tmdbId: 0, thumb: thumb("201") },
    { ratingKey: "240", plexGuids: [], tmdbId: 2400, thumb: "/library/sections/1" },
  ]);
  await page.settle();
  assert.equal(page.poster("Old Shape"), "initials OL");
  assert.equal(page.poster("Nulls"), "initials NU");
  assert.equal(page.poster("Malformed"), "initials MA");
  assert.equal(page.poster("Bad Thumb"), "initials BA");
});

test("duplicate Plex candidates resolve the same way whatever their order, preferring one with artwork", async (t) => {
  const candidates: IndexEntry[] = [
    { ratingKey: "5", plexGuids: [], tmdbId: 3100 },
    { ratingKey: "10", plexGuids: [], tmdbId: 3100, thumb: thumb("10") },
    { ratingKey: "9", plexGuids: [], tmdbId: 3100, thumb: thumb("9") },
  ];
  for (const index of [candidates, [...candidates].reverse()]) {
    await t.test(`order ${index.map((entry) => entry.ratingKey).join(",")}`, async (t) => {
      const page = await mountTrakt(t, [traktShow("Twin", { trakt: 31, tmdb: 3100 })], index);
      await page.settle();
      assert.equal(page.poster("Twin"), plexSrc(thumb("9")));
    });
  }
});

test("a poster tries a replaced source again after an earlier failure", async (t) => {
  const { container, root, browser } = mountDom(t);
  const render = (props: Parameters<typeof TraktPoster>[0]) => act(async () => { root.render(createElement(TraktPoster, props)); });
  const poster = () => container.querySelector("img")?.getAttribute("src") ?? `initials ${container.querySelector("span")?.textContent}`;
  const fail = () => act(async () => { container.querySelector("img")!.dispatchEvent(new browser.Event("error") as unknown as Event); });

  await render({ title: "Golf", traktPoster: traktPoster(41), plexThumb: null });
  await fail();
  assert.equal(poster(), "initials GO");
  await render({ title: "Golf", traktPoster: traktPoster(41), plexThumb: null });
  assert.equal(poster(), "initials GO", "an unrelated re-render does not retry");
  await render({ title: "Golf", traktPoster: traktPoster(42), plexThumb: null });
  assert.equal(poster(), traktSrc(42), "a replaced Trakt link is tried");
  await render({ title: "Golf", traktPoster: traktPoster(41), plexThumb: thumb("41") });
  assert.equal(poster(), traktSrc(41), "a Trakt link that went away and came back is tried afresh");
  await fail();
  assert.equal(poster(), plexSrc(thumb("41")), "a newly matched Plex image is tried");
});
