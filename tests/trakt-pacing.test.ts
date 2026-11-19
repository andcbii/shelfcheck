import assert from "node:assert/strict";
import test from "node:test";
import { ProviderClient, ProviderCooldownTooLongError } from "../lib/provider-client";
import { fakeClock, fakeFetch, json, runHarness } from "./provider-test-support";

const TRAKT = "https://api.trakt.tv/shows/1";
const START = Date.parse("2026-11-19T12:00:00.000Z");
const MINUTE = 60_000;

/** Trakt's X-Ratelimit header: `remaining` calls left until `until`, offset from the test start. */
const limit = (remaining: unknown, untilOffset?: number) => ({ "X-Ratelimit": JSON.stringify({ name: "AUTHED_API_GET_LIMIT", period: 300, limit: 1000, remaining, ...(untilOffset === undefined ? {} : { until: new Date(START + untilOffset).toISOString() }) }) });

function setup(headersFor: (index: number) => Record<string, string> = () => ({})) {
  const time = fakeClock(START);
  const runs = runHarness(time.now);
  const starts: number[] = [];
  const http = fakeFetch(({ index }) => { starts.push(time.elapsed()); return json({ index }, { headers: headersFor(index) }); });
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch, run: () => runs.runs.bound() });
  client.startRun();
  const request = () => client.json(TRAKT, {}, "Trakt");
  return { time, runs, http, client, starts, request };
}

const gaps = (starts: number[]) => starts.slice(1).map((start, index) => start - starts[index]);

test("Trakt requests start 100 ms apart while plenty of calls remain", async () => {
  const { time, starts, request } = setup(() => limit(900, 5 * MINUTE));
  await time.runUntil(Promise.all([request(), request(), request()]));
  assert.deepEqual(gaps(starts), [100, 100]);
});

test("with 100 or fewer calls left, even requests already queued start 300 ms apart", async () => {
  const { time, starts, request } = setup((index) => limit(index === 0 ? 100 : 99, 5 * MINUTE));
  await time.runUntil(Promise.all([request(), request(), request()]));
  assert.deepEqual(gaps(starts), [100, 300], "the second was already queued, but its successor's spacing follows the first response");
});

test("with 50 or fewer calls left, the next request waits for the reported reset plus 250 ms, and the run shows the pause", async () => {
  const { time, runs, starts, client } = setup((index) => index === 0 ? limit(50, 10_000) : {});
  const run = runs.start("trakt", async () => {
    client.startRun();
    await client.json(TRAKT, {}, "Trakt");
    const next = client.json(TRAKT, {}, "Trakt");
    await time.clock.sleep(1_000);
    assert.equal(runs.statuses.trakt?.rateLimitPaused, true, "the pause is shown while the request waits");
    assert.equal(runs.statuses.trakt?.rateLimitResumeAt, new Date(START + 10_250).toISOString());
    await next;
  });
  await time.runUntil(run.settled);
  assert.deepEqual(starts, [0, 10_250]);
});

test("missing, malformed, non-finite and expired rate-limit headers are ignored", async () => {
  const headers: Record<string, string>[] = [
    {},
    { "X-Ratelimit": "not json" },
    { "X-Ratelimit": JSON.stringify({ remaining: "lots", until: "soon" }) },
    limit(10, -1_000),
    {},
  ];
  const { time, starts, request } = setup((index) => headers[index] || {});
  await time.runUntil(Promise.all(headers.map(() => request())));
  assert.deepEqual(gaps(starts), [100, 100, 100, 100], "no pause and no slower spacing from unusable or expired headers");
});

test("a reset pause of exactly 15 minutes is waited out", async () => {
  const { time, starts, request } = setup((index) => index === 0 ? limit(0, 15 * MINUTE - 250) : {});
  await time.runUntil(request());
  await time.runUntil(request());
  assert.deepEqual(starts, [0, 15 * MINUTE]);
});

test("a reset more than 15 minutes away is a provider cooldown; the response that reported it is still used", async () => {
  const { time, http, request } = setup((index) => index === 0 ? limit(0, 15 * MINUTE) : {});
  assert.deepEqual(await time.runUntil(request()), { index: 0 }, "the far-future reset arrives with a usable response");
  const next = await time.runUntil(request().then(() => undefined, (error: unknown) => error));
  assert.ok(next instanceof ProviderCooldownTooLongError);
  assert.equal(next.reason, "rate-limit-reset");
  assert.equal(next.deadline, START + 15 * MINUTE + 250);
  assert.match(next.message, /Trakt's rate limit resets in 16 minutes/);
  assert.equal(http.requests.length, 1, "the next request is not sent");
  assert.equal(time.elapsed(), 0, "and does not sleep");
});

test("other providers keep their own spacing", async () => {
  const time = fakeClock(START);
  const starts: number[] = [];
  const http = fakeFetch(() => { starts.push(time.elapsed()); return json({}, { headers: limit(10, MINUTE) }); });
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch });
  client.startRun();
  await time.runUntil(Promise.all([1, 2, 3].map(() => client.json("https://api.themoviedb.org/3/tv/1", {}, "TMDB"))));
  assert.deepEqual(gaps(starts), [50, 50], "a rate-limit header on another provider changes nothing");
});

test("rate-limit headers that are not an object with a finite numeric quota are ignored and never break a successful response", async () => {
  const headers = [
    { "X-Ratelimit": "null" },
    { "X-Ratelimit": "42" },
    { "X-Ratelimit": "\"text\"" },
    { "X-Ratelimit": JSON.stringify({ remaining: null, until: new Date(START + 20 * MINUTE).toISOString() }) },
    { "X-Ratelimit": JSON.stringify({ remaining: "5", until: new Date(START + 20 * MINUTE).toISOString() }) },
    { "X-Ratelimit": JSON.stringify({ remaining: 3, until: 12345 }) },
    {},
  ];
  const { time, runs, http, starts, client } = setup((index) => (headers[index] || {}) as Record<string, string>);
  const run = runs.start("trakt", async () => {
    client.startRun();
    for (let index = 0; index < headers.length; index += 1) assert.deepEqual(await client.json(TRAKT, {}, "Trakt"), { index });
  });
  await time.runUntil(run.settled);
  assert.equal(http.requests.length, headers.length, "each response was used once, never retried");
  assert.deepEqual(gaps(starts), headers.slice(1).map(() => 100), "no pause, slower spacing or cooldown from a malformed header");
  for (const line of runs.lines.filter((entry) => /rate-limit/.test(entry.event))) {
    assert.ok(line.details && typeof line.details === "object" && !Array.isArray(line.details), `log details stay an object: ${JSON.stringify(line)}`);
  }
});

test("a failed response that reports a reset over 15 minutes away ends the request at once, without its Retry-After sleep", async () => {
  const time = fakeClock(START);
  const http = fakeFetch(() => new Response(null, { status: 429, headers: { ...limit(0, 20 * MINUTE), "Retry-After": "600" } }));
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch });
  client.startRun();
  const error = await time.runUntil(client.json(TRAKT, {}, "Trakt").then(() => undefined, (caught: unknown) => caught));
  assert.ok(error instanceof ProviderCooldownTooLongError);
  assert.equal(error.reason, "rate-limit-reset");
  assert.equal(time.elapsed(), 0, "no 600-second sleep first");
  assert.equal(http.requests.length, 1);
});

test("a request already waiting at the gate on an earlier reset is rejected as soon as another response reports a reset over 15 minutes away", async () => {
  // Two requests in flight: the first answers at 500 ms with a 10-minute reset, the second at 1,100 ms with a 20-minute one.
  const time = fakeClock(START);
  const http = fakeFetch(async ({ index }) => {
    await time.clock.sleep(index === 0 ? 500 : 1_000);
    return index === 0 ? json({ first: true }, { headers: limit(0, 10 * MINUTE) }) : json({ second: true }, { headers: limit(0, 20 * MINUTE) });
  });
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch });
  client.startRun();
  const first = client.json(TRAKT, {}, "Trakt");
  const second = client.json(TRAKT, {}, "Trakt");
  await time.advance(600);
  // Queued after the 10-minute reset is known, so it sleeps at the gate.
  const queued = client.json(TRAKT, {}, "Trakt").then(() => undefined, (caught: unknown) => caught);
  const [firstValue, secondValue, queuedError] = await time.runUntil(Promise.all([first, second, queued]));
  assert.deepEqual(firstValue, { first: true });
  assert.deepEqual(secondValue, { second: true }, "the response that reported the far-off reset is still used");
  assert.ok(queuedError instanceof ProviderCooldownTooLongError && queuedError.reason === "rate-limit-reset", String(queuedError));
  assert.ok(time.elapsed() < 5_000, `the queued request is rejected promptly, not after the 10-minute wait: ${time.elapsed()} ms`);
  assert.equal(http.requests.length, 2);
});
