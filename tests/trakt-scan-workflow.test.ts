import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const scan = await import("../app/api/scan/route");
const scanRuns = await import("../app/api/scan-runs/route");
const state = await import("../app/api/state/route");
const config = await import("../lib/server-config");
hook.deregister();

// Characterizes today's Trakt scan through its public start and status routes,
// with a controlled Trakt API, before it moves onto the scan run lifecycle.
// Resume point (checkpoint) contents are deliberately not asserted: SHELFCHECK-53
// and 54 change when they are saved and reused.

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
type ScanStatus = { status: string; processed: number; total: number; error?: string };

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
    failures: new Map<string, Response[]>(),
  };
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.trakt.tv", `no request leaves the controlled Trakt API: ${url}`);
    requests.push(url.pathname);
    const failure = trakt.failures.get(url.pathname)?.shift();
    if (failure) return failure;
    if (url.pathname === "/sync/collection/shows") return Response.json(trakt.library, { headers: { "X-Pagination-Page-Count": "1" } });
    const show = url.pathname.match(/^\/shows\/(\d+)\/(progress\/collection|seasons)$/);
    if (show?.[2] === "progress/collection") return Response.json(trakt.progress[Number(show[1])]);
    if (show?.[2] === "seasons") return Response.json([{ number: 1, episodes: airDates[Number(show[1])].map((first_aired, index) => ({ season: 1, number: index + 1, first_aired })) }]);
    throw new Error(`Unexpected Trakt request: ${url}`);
  });

  /** Starts a scan through the route and advances the mocked clock until its Scan run settles. */
  const run = async (body: { force?: boolean; traktId?: number } = {}) => {
    requests.length = 0;
    const started = await scan.POST(new Request("http://localhost/api/scan", { method: "POST", body: JSON.stringify(body) }));
    assert.equal(started.status, 202);
    for (let step = 0; step < 2_000; step += 1) {
      const { activeScanRun } = await (await scanRuns.GET()).json() as { activeScanRun: unknown };
      if (!activeScanRun) return (await (await scan.GET()).json() as { scan: ScanStatus }).scan;
      t.mock.timers.tick(250);
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("The Trakt scan did not settle.");
  };
  const report = async () => ((await (await state.GET()).json()) as { state: { report?: Report } }).state.report;
  const settings = (patch: Record<string, unknown>) => state.PATCH(new Request("http://localhost/api/state", { method: "PATCH", body: JSON.stringify(patch) }));
  return { trakt, requests, run, report, settings };
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
