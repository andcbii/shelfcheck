import assert from "node:assert/strict";
import test from "node:test";
import { ProviderClient } from "../lib/provider-client";
import { fakeClock, fakeFetch, json, runHarness } from "./provider-test-support";
import { SHELFCHECK_USER_AGENT } from "../lib/user-agent";

const TMDB = "https://api.themoviedb.org/3/tv/1";
const TRAKT = "https://api.trakt.tv/shows/1";

function setup(respond: Parameters<typeof fakeFetch>[0]) {
  const time = fakeClock();
  const runs = runHarness(time.now);
  const http = fakeFetch(respond);
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch, run: () => runs.runs.bound() });
  return { time, runs, http, client };
}

test("a later scan run waits out a Retry-After an earlier run received, and shows the pause", async () => {
  const sent: number[] = [];
  const { time, runs, http, client } = setup(({ index }) => {
    sent.push(time.elapsed());
    return index === 0 ? new Response(null, { status: 429, headers: { "Retry-After": "600" } }) : json({ ok: true });
  });
  // Run A gets the 429 and settles while its retry is still waiting.
  const first = runs.start("plex", async () => {
    client.startRun();
    void client.json(TMDB, {}, "TMDB").catch(() => {});
  });
  await time.advance(1_000);
  await first.settled;

  let secondResult: Promise<unknown> | undefined;
  const second = runs.start("plex", async () => {
    client.startRun();
    secondResult = client.json(TMDB, {}, "TMDB");
    await secondResult;
  });
  await time.advance(1_000);
  assert.equal(runs.statuses.plex?.rateLimitPaused, true, "the new run shows the provider pause it is waiting on");
  assert.equal(runs.statuses.plex?.rateLimitProvider, "TMDB");
  assert.equal(runs.statuses.plex?.rateLimitResumeAt, new Date(time.now() - 2_000 + 600_000).toISOString());

  await time.runUntil(second.settled);
  assert.deepEqual(await secondResult, { ok: true });
  assert.ok(sent.slice(1).every((at) => at >= 600_000), `no TMDB request started before the Retry-After passed: ${sent}`);
  assert.ok(http.requests.length >= 2, "the new run's request was sent once the wait ended");
});

test("a finished run's late response never reaches the next run's status or log", async () => {
  const { time, runs, client } = setup(async ({ index }) => {
    if (index === 0) { await time.clock.sleep(5_000); return new Response(null, { status: 429, headers: { "Retry-After": "10" } }); }
    return json({ ok: true });
  });
  const first = runs.start("trakt", async () => {
    client.startRun();
    void client.json(TRAKT, {}, "Trakt").catch(() => {});
  });
  await time.advance(1);
  await first.settled;

  const second = runs.start("plex", async () => {
    client.startRun();
    await client.json(TMDB, {}, "TMDB");
    await time.clock.sleep(20_000);
  });
  await time.runUntil(second.settled);

  assert.deepEqual(runs.linesOf(second.runId).filter((line) => line.details?.provider === "Trakt"), [], "no Trakt request line from the earlier run");
  assert.equal(runs.statuses.plex?.rateLimitProvider, undefined);
  assert.notEqual(runs.statuses.plex?.rateLimitPaused, true);
  assert.deepEqual(runs.linesOf(first.runId).filter((line) => line.event.includes("request")), [], "the settled run logs nothing more");
});

test("request log events use the dispatching run's event prefix and record queue and network time", async () => {
  const { time, runs, client } = setup(() => json({ ok: true }));
  const trakt = runs.start("trakt", async () => { client.startRun(); await client.json(TRAKT, {}, "Trakt"); });
  await time.runUntil(trakt.settled);
  const plex = runs.start("plex", async () => { client.startRun(); await client.json(TMDB, {}, "TMDB"); });
  await time.runUntil(plex.settled);

  const traktLine = runs.linesOf(trakt.runId).find((line) => line.event === "request.response");
  const plexLine = runs.linesOf(plex.runId).find((line) => line.event === "plex.request.response");
  assert.ok(traktLine, "the Trakt scan keeps its unprefixed request.response");
  assert.ok(plexLine, "the Plex scan keeps plex.request.response");
  for (const line of [traktLine, plexLine]) {
    assert.equal(typeof line.details?.queueWaitMs, "number");
    assert.equal(typeof line.details?.networkMs, "number");
    assert.equal(typeof line.details?.elapsedMs, "number");
  }
});

test("an attempt's 30-second deadline covers reading the body, and a timed-out attempt is retried", async () => {
  const { time, runs, http, client } = setup(({ index }) => index === 0
    ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"partial\":")); } }), { status: 200 })
    : json({ ok: true }));
  let result: unknown;
  const run = runs.start("plex", async () => { client.startRun(); result = await client.json(TMDB, {}, "TMDB"); });
  await time.runUntil(run.settled);
  assert.deepEqual(result, { ok: true });
  assert.equal(http.requests.length, 2);
  assert.ok(time.elapsed() >= 31_000 && time.elapsed() < 32_000, `retried after the 30 s deadline and a 1 s backoff: ${time.elapsed()}`);
  assert.ok(runs.linesOf(run.runId).some((line) => line.event === "plex.request.network-retry"));
});

test("every provider request identifies Shelfcheck with its User-Agent unless the caller set one", async () => {
  const { time, http, client } = setup(() => json({ ok: true }));
  await time.runUntil(client.json(TMDB, { headers: { Authorization: "Bearer test" } }, "TMDB"));
  await time.runUntil(client.json(TRAKT, { headers: { "User-Agent": "Caller/1" } }, "Trakt"));
  const agents = http.requests.map((request) => new Headers(request.init.headers).get("User-Agent"));
  assert.deepEqual(agents, [SHELFCHECK_USER_AGENT, "Caller/1"]);
  assert.equal(new Headers(http.requests[0].init.headers).get("Authorization"), "Bearer test", "the caller's headers are kept");
});

test("a settled run's late 429 and retry never change the next run's pause or metrics", async () => {
  const { time, runs, client } = setup(async ({ index }) => {
    if (index === 0) { await time.clock.sleep(5_000); return new Response(null, { status: 429, headers: { "Retry-After": "10" } }); }
    return json({ ok: true });
  });
  const first = runs.start("plex", async () => { client.startRun(); void client.json(TMDB, {}, "TMDB").catch(() => {}); });
  await time.advance(1);
  await first.settled;
  let metrics: ReturnType<ProviderClient["metrics"]> | undefined;
  // Run B starts at 2 s, before run A's late 429 arrives at 5 s, and requests TMDB at 6 s.
  await time.advance(1_999);
  const second = runs.start("plex", async () => {
    client.startRun();
    await time.clock.sleep(4_000);
    await client.json(TMDB, {}, "TMDB");
    await time.clock.sleep(10_000);
    metrics = structuredClone(client.metrics());
  });
  await time.advance(4_001);
  assert.equal(runs.statuses.plex?.rateLimitPaused, true, "run B shows the pause it waits on");
  await time.runUntil(second.settled);
  assert.equal(metrics?.TMDB.requests, 1, "only run B's own request is counted");
});
