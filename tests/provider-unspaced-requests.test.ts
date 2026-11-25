import assert from "node:assert/strict";
import test from "node:test";
import { ProviderClient, ProviderCooldownTooLongError } from "../lib/provider-client";
import { fakeClock, fakeFetch, json } from "./provider-test-support";

const PLEX = "http://plex.local:32400";
const inventory = (key: number) => `${PLEX}/library/metadata/${key}/allLeaves?includeGuids=1`;
const metadata = (key: number) => `${PLEX}/library/metadata/${key}?includeGuids=1`;
const TMDB = "https://api.themoviedb.org/3/tv/1";
const UNSPACED = { spacing: "none" } as const;
const MINUTE = 60_000;

/** A client on a fake clock that records when each request was sent, by its URL path. */
function setup(respond: (request: { url: URL; index: number }) => Response | Promise<Response> = () => json({ ok: true })) {
  const time = fakeClock();
  const sent: { path: string; at: number }[] = [];
  const http = fakeFetch(({ url, index }) => { sent.push({ path: `${url.host}${url.pathname}`, at: time.elapsed() }); return respond({ url, index }); });
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch });
  client.startRun();
  const at = (path: string) => sent.filter((request) => request.path.endsWith(path)).map((request) => request.at);
  return { time, client, sent, at };
}

test("unspaced Plex requests start together, and other Plex requests keep their 25 ms spacing", async () => {
  const { time, client, at } = setup();
  await time.runUntil(Promise.all([
    client.json(metadata(1), {}, "Plex"),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((key) => client.json(inventory(key), {}, "Plex", undefined, UNSPACED)),
    client.json(metadata(2), {}, "Plex"),
    client.json(metadata(3), {}, "Plex"),
  ]));
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].flatMap((key) => at(`/${key}/allLeaves`)), [0, 0, 0, 0, 0, 0, 0, 0], "no start gap between unspaced requests");
  assert.deepEqual([1, 2, 3].flatMap((key) => at(`/metadata/${key}`)), [0, 25, 50], "unspaced requests neither delay nor shorten the spaced ones");
});

test("a Retry-After on either class holds back both unspaced and spaced Plex requests", async () => {
  for (const limited of ["unspaced", "spaced"] as const) {
    const { time, client, at } = setup(({ index }) => index === 0 ? new Response(null, { status: 429, headers: { "Retry-After": "10" } }) : json({ ok: true }));
    const first = limited === "unspaced" ? client.json(inventory(1), {}, "Plex", undefined, UNSPACED) : client.json(metadata(1), {}, "Plex");
    await time.advance(1_000);
    const later = Promise.all([client.json(inventory(2), {}, "Plex", undefined, UNSPACED), client.json(metadata(2), {}, "Plex")]);
    await time.runUntil(Promise.all([first, later]));
    assert.ok(Math.min(...at("/2/allLeaves")) >= 10_000, `${limited} 429: the unspaced request waits out the Retry-After, sent at ${at("/2/allLeaves")}`);
    assert.ok(Math.min(...at("/metadata/2")) >= 10_000, `${limited} 429: the spaced request waits out the Retry-After, sent at ${at("/metadata/2")}`);
  }
});

test("a Plex cooldown from an earlier run holds back both classes in the next run, and one over 15 minutes refuses them unsent", async () => {
  const { time, client, at } = setup(({ index }) => index === 0 ? new Response(null, { status: 503, headers: { "Retry-After": "1800" } }) : json({ ok: true }));
  const raised = await time.runUntil(client.json(inventory(1), {}, "Plex", undefined, UNSPACED).then(() => undefined, (error: unknown) => error));
  assert.ok(raised instanceof ProviderCooldownTooLongError);

  await time.advance(5 * MINUTE);
  client.startRun();
  for (const refused of [() => client.json(inventory(2), {}, "Plex", undefined, UNSPACED), () => client.json(metadata(2), {}, "Plex")]) {
    await assert.rejects(time.runUntil(refused()), ProviderCooldownTooLongError);
  }
  assert.deepEqual([...at("/2/allLeaves"), ...at("/metadata/2")], [], "neither class is sent while over 15 minutes remain");

  await time.advance(15 * MINUTE);
  client.startRun();
  await time.runUntil(Promise.all([client.json(inventory(3), {}, "Plex", undefined, UNSPACED), client.json(metadata(3), {}, "Plex")]));
  assert.deepEqual([at("/3/allLeaves"), at("/metadata/3")], [[30 * MINUTE], [30 * MINUTE]], "within 15 minutes both classes wait out the remainder");
});

test("unspaced Plex requests leave other providers' spacing unchanged", async () => {
  const { time, client, sent } = setup();
  await time.runUntil(Promise.all([
    ...[1, 2, 3].map(() => client.json(TMDB, {}, "TMDB")),
    ...[1, 2, 3].map((key) => client.json(inventory(key), {}, "Plex", undefined, UNSPACED)),
  ]));
  assert.deepEqual(sent.filter((request) => request.path.includes("themoviedb")).map((request) => request.at), [0, 50, 100]);
  await assert.rejects(time.runUntil(client.json(TMDB, {}, "TMDB", undefined, { spacing: "none" })), /only Plex/);
});
