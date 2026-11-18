import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AsyncResource } from "node:async_hooks";
import test, { type TestContext } from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const scan = await import("../app/api/scan/route");
const scanRuns = await import("../app/api/scan-runs/route");
const state = await import("../app/api/state/route");
const config = await import("../lib/server-config");
const sqlite = await import("../lib/sqlite");
const plex = await import("../lib/plex-scan");
const issues = await import("../lib/coverage-issues");
const lifecycle = await import("../lib/scan-run");
hook.deregister();

// Characterizes today's Trakt scan through its public start and status routes,
// with a controlled Trakt API, before it moves onto the scan run lifecycle.
// The SHELFCHECK-54 tests at the end cover when Resume points are saved and reused.

const NOW = "2026-11-11T12:00:00.000Z";
const poster = { poster: ["walter.trakt.tv/poster.jpg"] };
const collected = (episodes: number[]) => [{ number: 1, episodes: episodes.map((number) => ({ number, collected_at: "2026-01-01T00:00:00.000Z" })) }];

/** Alpha is fully collected; Bravo lacks an aired episode and a future one; Charlie lacks one aired episode. */
function library() {
  return [
    { show: { title: "Alpha", year: 2020, ids: { trakt: 1, slug: "alpha" }, aired_episodes: 2, updated_at: "2026-01-01T00:00:00.000Z", images: poster }, seasons: collected([1, 2]) },
    { show: { title: "Bravo", year: 2021, ids: { trakt: 2, slug: "bravo" }, aired_episodes: 3, updated_at: "2026-01-01T00:00:00.000Z", images: poster }, seasons: collected([1]) },
    { show: { title: "Charlie", year: 2022, ids: { trakt: 3, slug: "charlie" }, aired_episodes: 2, updated_at: "2026-01-01T00:00:00.000Z", images: poster }, seasons: collected([1]) },
  ];
}

const progress: Record<number, { aired: number; completed: number; seasons: { number: number; episodes: { number: number; completed: boolean }[] }[] }> = {
  1: { aired: 2, completed: 2, seasons: [{ number: 1, episodes: [{ number: 1, completed: true }, { number: 2, completed: true }] }] },
  2: { aired: 3, completed: 1, seasons: [{ number: 1, episodes: [{ number: 1, completed: true }, { number: 2, completed: false }, { number: 3, completed: false }] }] },
  3: { aired: 2, completed: 1, seasons: [{ number: 1, episodes: [{ number: 1, completed: true }, { number: 2, completed: false }] }] },
};

const airDates: Record<number, string[]> = {
  1: ["2020-01-01T00:00:00.000Z", "2020-01-08T00:00:00.000Z"],
  2: ["2021-01-01T00:00:00.000Z", "2021-01-08T00:00:00.000Z", "2026-11-20T00:00:00.000Z"],
  3: ["2022-01-01T00:00:00.000Z", "2022-01-08T00:00:00.000Z"],
};

type Report = { shows: { show: { title: string; ids: { trakt: number } } }[]; missing: { show: { title: string }; season: number; episode: number }[]; lastScan: string; scanCache?: Record<string, unknown> };
type ScanStatus = { status: string; processed: number; total: number; error?: string; finishedAt?: string; rateLimitPaused?: boolean; rateLimitResumeAt?: string; heartbeatAt?: string; activeShows?: unknown[] };

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "trakt-scan-workflow-"));
  const previous = { data: process.env.SHELFCHECK_DATA_DIR, config: process.env.SHELFCHECK_CONFIG_DIR };
  process.env.SHELFCHECK_DATA_DIR = dir;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckNextRequestAt?: number; __shelfcheckRequestGate?: Promise<void>; __shelfcheckRateLimit?: unknown };
  delete global.__shelfcheckNextRequestAt;
  delete global.__shelfcheckRequestGate;
  delete global.__shelfcheckRateLimit;
  t.after(() => {
    global.__shelfcheckDatabase?.close();
    delete global.__shelfcheckDatabase;
    if (previous.data === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous.data;
    if (previous.config === undefined) delete process.env.SHELFCHECK_CONFIG_DIR; else process.env.SHELFCHECK_CONFIG_DIR = previous.config;
    rmSync(dir, { recursive: true, force: true });
  });
  // Request spacing and retry backoff run on the mocked clock: the test advances it, never sleeps.
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(NOW) });
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 86_400_000, redirectUri: "https://shelfcheck.example/callback" });
  await state.PATCH(new Request("http://localhost/api/state", { method: "PATCH", body: JSON.stringify({ diagnosticsEnabled: false, airingGraceDays: 0 }) }));

  const trakt = {
    library: library(),
    progress: structuredClone(progress),
    /** Responses, by request path, served before the normal answer. */
    failures: new Map<string, (Response | Promise<Response> | (() => Response | Promise<Response>))[]>(),
  };
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.trakt.tv", `no request leaves the controlled Trakt API: ${url}`);
    requests.push(url.pathname);
    const failure = trakt.failures.get(url.pathname)?.shift();
    if (failure) return typeof failure === "function" ? failure() : failure;
    if (url.pathname === "/sync/collection/shows") return Response.json(trakt.library, { headers: { "X-Pagination-Page-Count": "1" } });
    const show = url.pathname.match(/^\/shows\/(\d+)\/(progress\/collection|seasons)$/);
    if (show?.[2] === "progress/collection") return Response.json(trakt.progress[Number(show[1])]);
    if (show?.[2] === "seasons") return Response.json([{ number: 1, episodes: airDates[Number(show[1])].map((first_aired, index) => ({ season: 1, number: index + 1, first_aired })) }]);
    throw new Error(`Unexpected Trakt request: ${url}`);
  });

  /** Starts a scan through the route, without waiting for it. */
  const start = async (body: { force?: boolean; traktId?: number } = {}) => {
    requests.length = 0;
    const started = await scan.POST(new Request("http://localhost/api/scan", { method: "POST", body: JSON.stringify(body) }));
    assert.equal(started.status, 202);
  };
  /** Advances the mocked clock until the active Scan run settles, then returns the Trakt scan status. */
  const settle = async () => {
    for (let step = 0; step < 2_000; step += 1) {
      const { activeScanRun } = await (await scanRuns.GET()).json() as { activeScanRun: unknown };
      if (!activeScanRun) return (await (await scan.GET()).json() as { scan: ScanStatus }).scan;
      t.mock.timers.tick(250);
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("The Trakt scan did not settle.");
  };
  /** Starts a scan through the route and advances the mocked clock until its Scan run settles. */
  const run = async (body: { force?: boolean; traktId?: number } = {}) => {
    await start(body);
    return settle();
  };
  const report = async () => ((await (await state.GET()).json()) as { state: { report?: Report } }).state.report;
  const settings = (patch: Record<string, unknown>) => state.PATCH(new Request("http://localhost/api/state", { method: "PATCH", body: JSON.stringify(patch) }));
  return { trakt, requests, start, settle, run, report, settings };
}

const missing = (report: Report | undefined) => report?.missing.map((episode) => `${episode.show.title} S${episode.season}E${episode.episode}`);
const perShow = (requests: string[]) => requests.filter((request) => request.startsWith("/shows/")).sort();

test("a Quick scan reports every incomplete episode of a partly collected show and trusts a complete collection", async (t) => {
  const f = await fixture(t);
  const status = await f.run();
  assert.equal(status.status, "completed");
  assert.equal(status.processed, 3);
  assert.equal(status.total, 3);
  assert.deepEqual(perShow(f.requests), ["/shows/2/progress/collection", "/shows/3/progress/collection"]);
  const report = await f.report();
  assert.deepEqual(report?.shows.map((item) => item.show.title), ["Alpha", "Bravo", "Charlie"]);
  assert.deepEqual(missing(report), ["Bravo S1E2", "Bravo S1E3", "Charlie S1E2"]);
  assert.ok(Date.parse(report?.lastScan || "") >= Date.parse(NOW), "the report records when the scan finished");
  assert.deepEqual(Object.keys(report?.scanCache || {}).sort(), ["1", "2", "3"]);
});

test("a Deep Scan checks every show's progress and air dates and reports only incomplete episodes that have aired", async (t) => {
  const f = await fixture(t);
  const status = await f.run({ force: true });
  assert.equal(status.status, "completed");
  assert.equal(status.processed, 3);
  assert.deepEqual(perShow(f.requests), [
    "/shows/1/progress/collection",
    "/shows/2/progress/collection", "/shows/2/seasons",
    "/shows/3/progress/collection", "/shows/3/seasons",
  ]);
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Charlie S1E2"]);
});

test("a single-show check rechecks only that show and keeps the other shows' results", async (t) => {
  const f = await fixture(t);
  await f.run();
  const status = await f.run({ traktId: 2 });
  assert.equal(status.status, "completed");
  assert.equal(status.processed, 1);
  assert.equal(status.total, 1);
  assert.deepEqual(perShow(f.requests), ["/shows/2/progress/collection", "/shows/2/seasons"]);
  const report = await f.report();
  assert.deepEqual(report?.shows.map((item) => item.show.title), ["Alpha", "Bravo", "Charlie"]);
  assert.deepEqual(missing(report), ["Bravo S1E2", "Charlie S1E2"]);
});

test("a Quick scan reuses unchanged shows from the scan cache and rechecks a show whose collection changed", async (t) => {
  const f = await fixture(t);
  await f.run();
  const unchanged = await f.run();
  assert.equal(unchanged.status, "completed");
  assert.equal(unchanged.processed, 3);
  assert.deepEqual(f.requests, ["/sync/collection/shows"], "every show is reused from the scan cache");
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Bravo S1E3", "Charlie S1E2"]);

  f.trakt.library[2].seasons = collected([1, 2]);
  f.trakt.library[2].show.aired_episodes = 3;
  f.trakt.progress[3] = { aired: 3, completed: 2, seasons: [{ number: 1, episodes: [{ number: 1, completed: true }, { number: 2, completed: true }, { number: 3, completed: false }] }] };
  await f.run();
  assert.deepEqual(perShow(f.requests), ["/shows/3/progress/collection"], "only the changed show is rechecked");
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Bravo S1E3", "Charlie S1E3"]);
});

test("a failed scan run reports its error and keeps the last good report", async (t) => {
  const f = await fixture(t);
  await f.run();
  const lastGood = await f.report();
  f.trakt.library[2].show.aired_episodes = 3;
  f.trakt.failures.set("/shows/3/progress/collection", [new Response("{}", { status: 403 })]);
  const status = await f.run();
  assert.equal(status.status, "error");
  assert.match(status.error || "", /Trakt rejected this request \(403\)/);
  assert.deepEqual(await f.report(), lastGood);
});

test("a failed collection download fails the scan run and keeps the last good report", async (t) => {
  const f = await fixture(t);
  await f.run();
  const lastGood = await f.report();
  f.trakt.failures.set("/sync/collection/shows", [new Response("{}", { status: 403 })]);
  const status = await f.run({ force: true });
  assert.equal(status.status, "error");
  assert.deepEqual(perShow(f.requests), []);
  assert.deepEqual(await f.report(), lastGood);
});

test("a rate-limited or failing Trakt request is retried after its backoff on the scan clock", async (t) => {
  const f = await fixture(t);
  f.trakt.failures.set("/shows/2/progress/collection", [new Response("{}", { status: 429, headers: { "Retry-After": "30" } })]);
  f.trakt.failures.set("/shows/3/progress/collection", [new Response("{}", { status: 503 }), new Response("{}", { status: 503 })]);
  const started = Date.now();
  const status = await f.run();
  assert.equal(status.status, "completed");
  assert.ok(Date.now() - started >= 30_000, "the Retry-After wait elapsed on the mocked clock");
  assert.deepEqual(perShow(f.requests), [
    "/shows/2/progress/collection", "/shows/2/progress/collection",
    "/shows/3/progress/collection", "/shows/3/progress/collection", "/shows/3/progress/collection",
  ]);
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Bravo S1E3", "Charlie S1E2"]);
});

test("a Deep Scan rechecks a show Trakt updated, which a Quick scan reuses from the scan cache", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.trakt.library[2].show.updated_at = "2026-11-10T00:00:00.000Z";
  await f.run();
  assert.deepEqual(perShow(f.requests), [], "a Quick scan ignores a Trakt update alone");
  await f.run({ force: true });
  assert.deepEqual(perShow(f.requests), ["/shows/3/progress/collection", "/shows/3/seasons"]);
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Bravo S1E3", "Charlie S1E2"]);
});

// SHELFCHECK-53: the Trakt scan runs through the scan run lifecycle.

const status = async () => (await (await scan.GET()).json() as { scan: ScanStatus }).scan;

test("a Trakt scan run with no heartbeat for more than 90 seconds and no live owner is an Interrupted scan, written once", async (t) => {
  await fixture(t);
  sqlite.writeSingleUserScanStatus({ status: "running", processed: 1, total: 3, startedAt: new Date(Date.now() - 200_000).toISOString(), heartbeatAt: new Date(Date.now() - 90_000).toISOString() });
  assert.equal((await status()).status, "running", "exactly 90 seconds without a heartbeat is still running");
  t.mock.timers.tick(1);
  const first = await status();
  assert.equal(first.status, "error");
  assert.equal(first.error, "The scan was interrupted by a server restart. Start it again to resume.");
  assert.equal(first.processed, 1);
  t.mock.timers.tick(60_000);
  assert.deepEqual(await status(), first, "a later poll rewrites nothing");
  assert.deepEqual(issues.listCoverageIssues(), [], "an Interrupted Trakt scan raises no Coverage Issue");
});

const flush = async () => { for (let step = 0; step < 20; step += 1) await new Promise((resolve) => setImmediate(resolve)); };

test("a Trakt rate-limit pause and its resume time survive progress updates and heartbeats until the pause ends", async (t) => {
  const f = await fixture(t);
  let release!: (response: Response) => void;
  let charlieRequested!: () => void;
  // Bravo is rate limited once Charlie's progress request is in flight; Charlie's answer is held until the pause has started.
  const charlieInFlight = new Promise<void>((resolve) => { charlieRequested = resolve; });
  f.trakt.failures.set("/shows/2/progress/collection", [charlieInFlight.then(() => new Response("{}", { status: 429, headers: { "Retry-After": "60" } }))]);
  f.trakt.failures.set("/shows/3/progress/collection", [() => { charlieRequested(); return new Promise<Response>((resolve) => { release = resolve; }); }]);
  await f.start();
  let paused = await status();
  for (let step = 0; step < 100 && !paused.rateLimitPaused; step += 1) {
    t.mock.timers.tick(50);
    await flush();
    paused = await status();
  }
  assert.equal(paused.status, "running");
  assert.equal(paused.rateLimitPaused, true);
  assert.ok(Date.parse(paused.rateLimitResumeAt || "") >= Date.now() + 55_000, "the resume time is when Trakt said the pause ends");

  release(Response.json(progress[3]));
  await flush();
  const progressed = await status();
  assert.equal(progressed.processed, paused.processed + 1, "Charlie completed during the pause");
  assert.equal(progressed.rateLimitPaused, true, "a progress update keeps the pause");
  assert.equal(progressed.rateLimitResumeAt, paused.rateLimitResumeAt);

  t.mock.timers.tick(15_000);
  await flush();
  const beat = await status();
  assert.notEqual(beat.heartbeatAt, progressed.heartbeatAt, "the heartbeat ran");
  assert.equal(beat.rateLimitPaused, true, "a heartbeat keeps the pause");
  assert.equal(beat.rateLimitResumeAt, paused.rateLimitResumeAt);
  assert.deepEqual(beat.activeShows, [{ key: "2", show: "Bravo", phase: "collection-progress" }], "the heartbeat shows the show waiting out the pause");

  const finished = await f.settle();
  assert.equal(finished.status, "completed");
  assert.ok(!finished.rateLimitPaused, "the pause ended with the run");
  assert.equal(finished.rateLimitResumeAt, undefined);
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Bravo S1E3", "Charlie S1E2"]);
});

test("a late Trakt callback from a settled scan run reaches neither a following Trakt nor Plex scan run", async (t) => {
  const f = await fixture(t);
  const collection = () => Response.json(f.trakt.library, { headers: { "X-Pagination-Page-Count": "1" } });
  // Each scope keeps the async context of a Trakt request, as a late provider callback would.
  let late!: AsyncResource;
  let current!: AsyncResource;
  f.trakt.failures.set("/sync/collection/shows", [() => { late = new AsyncResource("late-trakt-callback"); return collection(); }]);
  assert.equal((await f.run()).status, "completed");
  const reaches = (scope: AsyncResource, kind: "trakt" | "plex") => scope.runInAsyncScope(() => Boolean(lifecycle.scanRuns.bound(kind)));

  let releaseCollection!: (response: Response) => void;
  f.trakt.failures.set("/sync/collection/shows", [() => { current = new AsyncResource("current-trakt-callback"); return new Promise<Response>((resolve) => { releaseCollection = resolve; }); }]);
  await f.start();
  for (let step = 0; step < 100 && !current; step += 1) { t.mock.timers.tick(50); await flush(); }
  assert.equal(reaches(current, "trakt"), true, "the following Trakt run's own callback reaches it");
  assert.equal(reaches(late, "trakt"), false, "the settled run's callback does not reach the following Trakt run");
  assert.equal(reaches(late, "plex"), false);
  releaseCollection(collection());
  assert.equal((await f.settle()).status, "completed");
  assert.equal(reaches(current, "trakt"), false, "once settled, its callbacks reach nothing");

  plex.startPlexScan();
  assert.equal(reaches(late, "plex"), false, "a settled Trakt run's callback does not reach a following Plex run");
  assert.equal(reaches(late, "trakt"), false);
  await f.settle();
  assert.equal((await status()).status, "completed", "the Plex run left the Trakt status alone");
});

test("Trakt scan runs raise no Coverage Issues, completed or failed", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).status, "completed");
  f.trakt.library[2].show.aired_episodes = 3;
  f.trakt.failures.set("/shows/3/progress/collection", [new Response("{}", { status: 403 })]);
  assert.equal((await f.run()).status, "error");
  assert.deepEqual(issues.listCoverageIssues(), []);
});

// SHELFCHECK-54: Trakt Resume point rules.

type ResumePoint = Report & { savedAt?: string; resumePointVersion?: number; airingGraceDays?: number };
const storedResumePoint = async () => ((await (await state.GET()).json()) as { state: { checkpoint?: ResumePoint | null } }).state.checkpoint || null;
const HOUR = 3_600_000;
/** A Resume point saved before 2.6.2: none of savedAt, format version or grace period. */
const legacy = { savedAt: undefined, resumePointVersion: undefined, airingGraceDays: undefined };

/**
 * After a completed Quick scan, stores a full-run Resume point built from its
 * report whose only result is Bravo S1E2, so a run that resumes from it reports
 * just that episode. `fields`, given the time it is stored, replaces its
 * current Resume point metadata. The next run loads it at that same time.
 */
async function seedResumePoint(f: Awaited<ReturnType<typeof fixture>>, fields: (now: number) => Partial<ResumePoint> = () => ({})) {
  assert.equal((await f.run()).status, "completed");
  const report = await f.report();
  const now = Date.now();
  const point: Record<string, unknown> = { ...report, missing: report!.missing.filter((episode) => episode.show.title === "Bravo" && episode.episode === 2), savedAt: new Date(now - HOUR).toISOString(), resumePointVersion: 1, airingGraceDays: 0, ...fields(now) };
  for (const [key, value] of Object.entries(point)) if (value === undefined) delete point[key];
  sqlite.patchSingleUserState({ checkpoint: point });
  return report!;
}

test("a full Trakt scan run resumes from a Resume point under 6 hours old with the current format and grace period", async (t) => {
  const f = await fixture(t);
  await seedResumePoint(f, (now) => ({ savedAt: new Date(now - 6 * HOUR + 1).toISOString() }));
  assert.equal((await f.run()).status, "completed");
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2"], "the run resumed from the Resume point");
  assert.equal(await storedResumePoint(), null, "a completed run clears its Resume point");
});

for (const [name, fields] of [
  ["a legacy Resume point without savedAt, format version or grace period", () => legacy],
  ["a Resume point exactly 6 hours old", (now: number) => ({ savedAt: new Date(now - 6 * HOUR).toISOString() })],
  ["a future-dated Resume point", (now: number) => ({ savedAt: new Date(now + 60_000).toISOString() })],
  ["a Resume point whose savedAt does not parse", () => ({ savedAt: "not a date" })],
  ["a Resume point of another format version", () => ({ resumePointVersion: 2 })],
  ["a Resume point of another airing grace period", () => ({ airingGraceDays: 3 })],
] as const) {
  test(`${name} is discarded and cleared, and the run falls back to the saved report and scan cache`, async (t) => {
    const f = await fixture(t);
    const lastGood = await seedResumePoint(f, fields);
    assert.equal((await f.run()).status, "completed");
    assert.deepEqual(perShow(f.requests), [], "every show is reused from the saved report's scan cache");
    const report = await f.report();
    assert.deepEqual(missing(report), missing(lastGood), "the saved report was used, not the Resume point");
    assert.deepEqual(report?.shows.map((item) => item.show.title), ["Alpha", "Bravo", "Charlie"]);
    assert.equal(await storedResumePoint(), null);
  });
}

test("a discarded Resume point is cleared even when the run then fails, and the saved report is kept", async (t) => {
  const f = await fixture(t);
  const lastGood = await seedResumePoint(f, () => legacy);
  f.trakt.failures.set("/sync/collection/shows", [new Response("{}", { status: 403 })]);
  assert.equal((await f.run()).status, "error");
  assert.deepEqual(await f.report(), lastGood, "the completed report is never erased");
  assert.equal(await storedResumePoint(), null);
});

test("a single-show check does not resume from a full-run Resume point, and keeps it without the checked show", async (t) => {
  const f = await fixture(t);
  await seedResumePoint(f);
  const stored = await storedResumePoint();
  assert.equal((await f.run({ traktId: 3 })).status, "completed");
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Bravo S1E3", "Charlie S1E2"], "the single-show check started from the saved report");
  const kept = await storedResumePoint();
  assert.equal(kept?.savedAt, stored?.savedAt, "the full-run Resume point is not replaced by a one-show snapshot");
  assert.deepEqual(Object.keys(kept?.scanCache || {}).sort(), ["1", "2"], "only the checked show is pruned from it");
  assert.deepEqual(kept?.shows.map((item) => item.show.title), ["Alpha", "Bravo"]);
  assert.deepEqual(missing(kept!), ["Bravo S1E2"]);

  assert.equal((await f.run()).status, "completed");
  assert.deepEqual(perShow(f.requests), ["/shows/3/progress/collection"], "the next full run resumes and rechecks only the pruned show");
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Charlie S1E2"]);
});

test("a failed single-show check creates no Resume point", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).status, "completed");
  f.trakt.failures.set("/shows/3/seasons", [new Response("{}", { status: 403 })]);
  f.trakt.failures.set("/shows/3/progress/collection", [new Response("{}", { status: 403 })]);
  assert.equal((await f.run({ traktId: 3 })).status, "error");
  assert.equal(await storedResumePoint(), null);
});

test("a failed full scan run saves a Resume point of its completed shows, and the next full run resumes from it", async (t) => {
  const f = await fixture(t);
  f.trakt.failures.set("/shows/3/progress/collection", [new Response("{}", { status: 403 })]);
  assert.equal((await f.run()).status, "error");
  const saved = await storedResumePoint();
  assert.equal(saved?.resumePointVersion, 1);
  assert.equal(saved?.airingGraceDays, 0);
  assert.ok(Date.parse(saved?.savedAt || "") >= Date.parse(NOW), "it records when it was saved");
  assert.deepEqual(Object.keys(saved?.scanCache || {}).sort(), ["1", "2"], "only completed shows are saved");
  assert.deepEqual(missing(saved!), ["Bravo S1E2", "Bravo S1E3"]);

  assert.equal((await f.run()).status, "completed");
  assert.deepEqual(perShow(f.requests), ["/shows/3/progress/collection"], "the completed shows are resumed, not rechecked");
  assert.deepEqual(missing(await f.report()), ["Bravo S1E2", "Bravo S1E3", "Charlie S1E2"]);
  assert.equal(await storedResumePoint(), null);
});

test("a Trakt rate-limit pause saves a Resume point of the shows completed so far", async (t) => {
  const f = await fixture(t);
  let release!: (response: Response) => void;
  let charlieRequested!: () => void;
  const charlieInFlight = new Promise<void>((resolve) => { charlieRequested = resolve; });
  f.trakt.failures.set("/shows/2/progress/collection", [charlieInFlight.then(() => new Response("{}", { status: 429, headers: { "Retry-After": "60" } }))]);
  f.trakt.failures.set("/shows/3/progress/collection", [() => { charlieRequested(); return new Promise<Response>((resolve) => { release = resolve; }); }]);
  await f.start();
  for (let step = 0; step < 100 && !(await status()).rateLimitPaused; step += 1) { t.mock.timers.tick(50); await flush(); }
  assert.equal((await status()).rateLimitPaused, true);
  const saved = await storedResumePoint();
  assert.equal(saved?.resumePointVersion, 1);
  assert.ok(saved?.savedAt);
  assert.deepEqual(Object.keys(saved?.scanCache || {}), ["1"], "the paused and in-flight shows are not in it");
  assert.deepEqual(missing(saved!), []);
  release(Response.json(progress[3]));
  assert.equal((await f.settle()).status, "completed");
  assert.equal(await storedResumePoint(), null);
});
