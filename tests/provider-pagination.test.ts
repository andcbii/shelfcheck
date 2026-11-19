import assert from "node:assert/strict";
import test from "node:test";
import { ProviderClient, type ProviderAuth } from "../lib/provider-client";
import { fakeClock, fakeFetch, json } from "./provider-test-support";

const COLLECTION = "https://api.trakt.tv/sync/collection/shows?extended=full,images";

/** A login whose token a 401 replaces once, recording each recovery. */
function login() {
  let token = "first";
  const recoveries: string[] = [];
  const auth: ProviderAuth = {
    ready: async () => {},
    credential: () => ({ token, headers: { Authorization: `Bearer ${token}` } }),
    recover: async (rejected) => { recoveries.push(rejected); if (rejected === token) token = "second"; },
  };
  return { auth, recoveries };
}

function setup(respond: Parameters<typeof fakeFetch>[0]) {
  const time = fakeClock();
  const http = fakeFetch(respond);
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch });
  client.startRun();
  return { time, http, client };
}

const page = (url: URL) => Number(url.searchParams.get("page"));

test("pages are requested with page and limit until Trakt's page count, and their items joined in order", async () => {
  const { time, http, client } = setup(({ url }) => json([`item-${page(url)}`], { headers: { "X-Pagination-Page-Count": "3" } }));
  const { auth } = login();
  assert.deepEqual(await time.runUntil(client.pages<string>(COLLECTION, {}, "Trakt", auth)), ["item-1", "item-2", "item-3"]);
  assert.deepEqual(http.requests.map(({ url }) => [url.searchParams.get("extended"), url.searchParams.get("page"), url.searchParams.get("limit")]), [["full,images", "1", "100"], ["full,images", "2", "100"], ["full,images", "3", "100"]]);
});

test("without a page count, only the first page is read; at most 100 pages are read", async () => {
  const single = setup(() => json(["only"]));
  assert.deepEqual(await single.time.runUntil(single.client.pages<string>(COLLECTION, {}, "Trakt", login().auth)), ["only"]);
  assert.equal(single.http.requests.length, 1);

  const endless = setup(({ url }) => json([page(url)], { headers: { "X-Pagination-Page-Count": "500" } }));
  const items = await endless.time.runUntil(endless.client.pages<number>(COLLECTION, {}, "Trakt", login().auth));
  assert.equal(items.length, 100);
  assert.equal(endless.http.requests.length, 100);
});

test("each page goes through the paced, authenticated path: a 401 mid-way is recovered and that page replayed", async () => {
  const { time, http, client } = setup(({ url, init }) => {
    const token = new Headers(init.headers).get("Authorization");
    if (page(url) === 2 && token === "Bearer first") return json({}, { status: 401 });
    return json([page(url)], { headers: { "X-Pagination-Page-Count": "3" } });
  });
  const { auth, recoveries } = login();
  assert.deepEqual(await time.runUntil(client.pages<number>(COLLECTION, {}, "Trakt", auth)), [1, 2, 3]);
  assert.deepEqual(recoveries, ["first"]);
  assert.deepEqual(http.requests.map(({ url, init }) => `${page(url)}:${new Headers(init.headers).get("Authorization")}`), ["1:Bearer first", "2:Bearer first", "2:Bearer second", "3:Bearer second"]);
  assert.ok(time.elapsed() >= 300, "pages are paced like any other Trakt request");
});
