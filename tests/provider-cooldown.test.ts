import assert from "node:assert/strict";
import test from "node:test";
import { ProviderClient, ProviderCooldownTooLongError, ProviderHttpError } from "../lib/provider-client";
import { fakeClock, fakeFetch, json, runHarness } from "./provider-test-support";

const TMDB = "https://api.themoviedb.org/3/tv/1";
const MINUTE = 60_000;

function setup(respond: Parameters<typeof fakeFetch>[0]) {
  const time = fakeClock();
  const http = fakeFetch(respond);
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch });
  client.startRun();
  return { time, http, client };
}

const outcome = (promise: Promise<unknown>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
const cooldown = (result: { value?: unknown; error?: unknown }) => {
  assert.ok(result.error instanceof ProviderCooldownTooLongError, `expected a provider cooldown, got ${String(result.error ?? JSON.stringify(result.value))}`);
  return result.error;
};

test("a Retry-After of exactly 15 minutes is waited out; any longer is a provider cooldown, without sleeping", async () => {
  const waited = setup(({ index }) => index === 0 ? new Response(null, { status: 429, headers: { "Retry-After": "900" } }) : json({ ok: true }));
  assert.deepEqual(await waited.time.runUntil(waited.client.json(TMDB, {}, "TMDB")), { ok: true });
  assert.equal(waited.time.elapsed(), 15 * MINUTE);

  const later = new Date(Date.parse("2026-11-19T12:00:00.000Z") + 15 * MINUTE + 1_000).toUTCString();
  const refused = setup(() => new Response(null, { status: 429, headers: { "Retry-After": later } }));
  // An HTTP date has whole-second precision: this one asks for 15 minutes and 1 second.
  const error = cooldown(await refused.time.runUntil(outcome(refused.client.json(TMDB, {}, "TMDB"))));
  assert.equal(refused.time.elapsed(), 0, "no sleep before giving up");
  assert.equal(refused.http.requests.length, 1);
  assert.equal(error.provider, "TMDB");
  assert.equal(error.reason, "rate-limit");
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 15 * MINUTE + 1_000);
  assert.equal(error.deadline, refused.time.now() + 15 * MINUTE + 1_000);
  assert.equal(error.requested?.kind, "show");
});

test("a server error asking for a long wait is a provider cooldown that says the provider is unavailable, not rate limited", async () => {
  const { time, client } = setup(() => new Response(null, { status: 503, headers: { "Retry-After": "1200" } }));
  const error = cooldown(await time.runUntil(outcome(client.json(TMDB, {}, "TMDB"))));
  assert.equal(error.reason, "server");
  assert.equal(error.status, 503);
  assert.ok(!(error instanceof ProviderHttpError));
  assert.match(error.message, /TMDB is unavailable and asked Shelfcheck to wait 20 minutes/);
  assert.doesNotMatch(error.message, /rate|cooldown/i);
});

test("a long wait asked for on the final attempt is still recorded as a provider cooldown", async () => {
  const { time, http, client } = setup(({ index }) => index < 4
    ? new Response(null, { status: 502, headers: { "Retry-After": "1" } })
    : new Response(null, { status: 503, headers: { "Retry-After": "3600" } }));
  const error = cooldown(await time.runUntil(outcome(client.json(TMDB, {}, "TMDB"))));
  assert.equal(http.requests.length, 5);
  assert.equal(error.retryAfterMs, 60 * MINUTE);
  const next = await time.runUntil(outcome(client.json(TMDB, {}, "TMDB")));
  assert.equal(cooldown(next).deadline, error.deadline, "later requests in the run get the recorded cooldown");
  assert.equal(http.requests.length, 5, "without being sent");
});

test("requests already queued behind a cooldown are rejected without being sent", async () => {
  const { time, http, client } = setup(({ index }) => index === 0 ? new Response(null, { status: 429, headers: { "Retry-After": "1200" } }) : json({ ok: true }));
  const results = await time.runUntil(Promise.all([1, 2, 3].map(() => outcome(client.json(TMDB, {}, "TMDB")))));
  for (const result of results) cooldown(result);
  assert.equal(http.requests.length, 1);
  assert.ok(time.elapsed() < 1_000, `queued requests are rejected at once, not after sleeping: ${time.elapsed()} ms`);
});

test("a later scan run fails fast while over 15 minutes remain, waits only the remainder within 15, and recovers after expiry", async () => {
  const sent: number[] = [];
  const { time, client } = setup(({ index }) => { sent.push(time.elapsed()); return index === 0 ? new Response(null, { status: 503, headers: { "Retry-After": "1800" } }) : json({ ok: true }); });
  const first = cooldown(await time.runUntil(outcome(client.json(TMDB, {}, "TMDB"))));
  assert.equal(first.retryAfterMs, 30 * MINUTE);

  await time.advance(5 * MINUTE);
  client.startRun();
  const early = cooldown(await time.runUntil(outcome(client.json(TMDB, {}, "TMDB"))));
  assert.equal(early.retryAfterMs, 25 * MINUTE, "reports the remaining time");
  assert.equal(early.deadline, first.deadline);
  assert.equal(time.elapsed(), 5 * MINUTE, "fails at once");
  assert.equal(sent.length, 1);

  await time.advance(15 * MINUTE);
  client.startRun();
  assert.deepEqual(await time.runUntil(client.json(TMDB, {}, "TMDB")), { ok: true });
  assert.equal(sent[1], 30 * MINUTE, "waited only until the original deadline");

  await time.advance(MINUTE);
  client.startRun();
  assert.deepEqual(await time.runUntil(client.json(TMDB, {}, "TMDB")), { ok: true });
  assert.equal(sent[2], 31 * MINUTE, "after expiry the request goes straight out");
});

test("a shorter cooldown answered later never shortens a longer one", async () => {
  const { time, client } = setup(async ({ index }) => {
    if (index === 0) { await time.clock.sleep(1_000); return new Response(null, { status: 429, headers: { "Retry-After": "3600" } }); }
    return new Response(null, { status: 429, headers: { "Retry-After": "1200" } });
  });
  const [longer, shorter] = await time.runUntil(Promise.all([outcome(client.json(TMDB, {}, "TMDB")), outcome(client.json(TMDB, {}, "TMDB"))]));
  const kept = time.now() + 60 * MINUTE;
  assert.equal(cooldown(longer).deadline, kept);
  cooldown(shorter);
  await time.advance(30 * MINUTE);
  client.startRun();
  assert.equal(cooldown(await time.runUntil(outcome(client.json(TMDB, {}, "TMDB")))).deadline, kept);
});

test("an unreadable Retry-After falls back to the bounded backoff", async () => {
  const { time, client } = setup(({ index }) => index === 0 ? new Response(null, { status: 503, headers: { "Retry-After": "later, please" } }) : json({ ok: true }));
  assert.deepEqual(await time.runUntil(client.json(TMDB, {}, "TMDB")), { ok: true });
  assert.equal(time.elapsed(), 1_000);
});

test("a later scan run waiting out the last 15 minutes of a rate-limit cooldown shows that pause", async () => {
  const time = fakeClock();
  const runs = runHarness(time.now);
  const http = fakeFetch(({ index }) => index === 0 ? new Response(null, { status: 429, headers: { "Retry-After": "1800" } }) : json({ ok: true }));
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch, run: () => runs.runs.bound() });
  const first = runs.start("plex", async () => { client.startRun(); await client.json(TMDB, {}, "TMDB").catch(() => {}); });
  await time.runUntil(first.settled);
  await time.advance(20 * MINUTE);
  const second = runs.start("plex", async () => { client.startRun(); await client.json(TMDB, {}, "TMDB"); });
  await time.advance(1_000);
  assert.equal(runs.statuses.plex?.rateLimitPaused, true);
  assert.equal(runs.statuses.plex?.rateLimitResumeAt, new Date(time.now() - 20 * MINUTE - 1_000 + 30 * MINUTE).toISOString());
  await time.runUntil(second.settled);
  assert.equal(http.requests.length, 2);
});

test("a Retry-After within the limit on the final attempt is still honoured by later requests", async () => {
  const { time, client } = setup(({ index }) => index < 5
    ? new Response(null, { status: 503, headers: { "Retry-After": index === 4 ? "600" : "1" } })
    : json({ ok: true }));
  const failure = await time.runUntil(outcome(client.json(TMDB, {}, "TMDB")));
  assert.ok("error" in failure && failure.error instanceof ProviderHttpError, "the exhausted request fails with its HTTP status");
  const failedAt = time.elapsed();
  client.startRun();
  assert.deepEqual(await time.runUntil(client.json(TMDB, {}, "TMDB")), { ok: true });
  assert.ok(time.elapsed() >= failedAt + 600_000, `the next request waited out the final Retry-After: ${time.elapsed()}`);
});
