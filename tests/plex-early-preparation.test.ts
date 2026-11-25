import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const plex = await import("../lib/plex-scan");
const config = await import("../lib/server-config");
const ignoreResults = await import("../lib/ignore-results");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

/** Polls `condition` every 5 ms for at most `milliseconds`; true once it holds. */
async function within(milliseconds: number, condition: () => boolean) {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

/**
 * A configured Plex library behind a mocked fetch, TMDB only:
 * - Show A (rating key 1, TMDB 10) lists S1E1 (TMDB 1001) and S1E2 (TMDB 1002); Plex has only S1E1 in Show A.
 * - Show B is one show of two Plex records (2 and 3, the same Plex GUID) listing S1E1 (TMDB 1101).
 *   Record 2 holds B's S1E1; record 3 holds an item Plex identifies as TMDB 1002, Show A's S1E2.
 * So Show A owns S1E2 only once record 3, the library's last record, is in.
 * Every request is recorded as it enters; `hold(url)` may delay its answer.
 */
async function library(t: TestContext, hold: (url: URL) => Promise<void> = async () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "plex-early-preparation-"));
  const previous = { data: process.env.SHELFCHECK_DATA_DIR, config: process.env.SHELFCHECK_CONFIG_DIR };
  process.env.SHELFCHECK_DATA_DIR = dir;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    process.env.SHELFCHECK_DATA_DIR = previous.data;
    process.env.SHELFCHECK_CONFIG_DIR = previous.config;
    if (previous.data === undefined) delete process.env.SHELFCHECK_DATA_DIR;
    if (previous.config === undefined) delete process.env.SHELFCHECK_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "test", tvdbApiKey: "test" });
  const requests: string[] = [];
  const records = [
    { ratingKey: "1", title: "Show A", Guid: [{ id: "tmdb://10" }] },
    { ratingKey: "2", guid: "plex://show/b", title: "Show B", Guid: [{ id: "tmdb://11" }] },
    { ratingKey: "3", guid: "plex://show/b", title: "Show B", Guid: [{ id: "tmdb://11" }] },
  ];
  const leaves: Record<string, unknown[]> = {
    1: [{ ratingKey: "101", parentIndex: 1, index: 1, Guid: [{ id: "tmdb://1001" }] }],
    2: [{ ratingKey: "201", parentIndex: 1, index: 1, Guid: [{ id: "tmdb://1101" }] }],
    3: [{ ratingKey: "301", parentIndex: 1, index: 2, Guid: [{ id: "tmdb://1002" }] }],
  };
  const seasons: Record<string, unknown[]> = {
    10: [{ id: 1001, season_number: 1, episode_number: 1, name: "A One", air_date: "2020-01-01" }, { id: 1002, season_number: 1, episode_number: 2, name: "A Two", air_date: "2020-01-08" }],
    11: [{ id: 1101, season_number: 1, episode_number: 1, name: "B One", air_date: "2020-01-01" }],
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    requests.push(u.pathname);
    await hold(u);
    let body: unknown;
    if (u.hostname === "plex") {
      const key = u.pathname.split("/")[3];
      if (u.pathname === "/library/sections") body = { MediaContainer: { Directory: [{ key: "1", type: "show" }] } };
      else if (u.pathname.includes("/sections/")) body = { MediaContainer: { Metadata: records } };
      else if (u.pathname.endsWith("/allLeaves")) body = { MediaContainer: { Metadata: leaves[key] } };
      else body = { MediaContainer: { Metadata: [records.find((record) => record.ratingKey === key)] } };
    } else if (u.pathname === "/v4/login") body = { data: { token: "test" } };
    else if (u.pathname === "/3/tv/changes") body = { results: [], total_pages: 1 };
    else if (u.pathname === "/v4/updates") body = { data: [] };
    else {
      const season = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1$/);
      const show = u.pathname.match(/^\/3\/tv\/(\d+)$/);
      if (season) body = { episodes: seasons[season[1]] };
      else if (show) body = { id: Number(show[1]), name: Number(show[1]) === 10 ? "Show A" : "Show B", seasons: [{ season_number: 1 }] };
      else throw new Error("Unexpected HTTP: " + u);
    }
    return Response.json(body);
  });
  const log = () => { try { return readFileSync(path.join(dir, "logs", "shelfcheck-plex.log"), "utf8").split(/\r?\n/); } catch { return []; } };
  return {
    requests,
    entered: (pathname: string) => requests.includes(pathname),
    logEvents: (event: string) => log().filter((line) => line.includes(` ${event} |`)),
    database: () => cache.__shelfcheckDatabase!,
  };
}

async function fullScan() {
  plex.startPlexScan();
  assert.ok(await within(20_000, () => !scanRuns.activeScanRun()), "the scan run ends within 20 seconds");
  return plex.getPlexScanStatus();
}

const missingOf = (ratingKey: string) => plex.getPlexReport()?.shows.find((show) => show.ratingKey === ratingKey)?.missing.map((episode) => `S${episode.season}E${episode.episode} ${episode.tmdbEpisodeId}`);

test("a show's catalogues download while a later record downloads, and its result waits for the whole library", async (t) => {
  const seen: { catalogueRequested: boolean; processed?: number; resumePoint?: unknown; report?: unknown; completed?: number } = { catalogueRequested: false };
  const f = await library(t, async (u) => {
    if (u.pathname !== "/library/metadata/3/allLeaves") return;
    // Show B's last record stays unanswered until Show A's TMDB episodes have been requested (or 5 seconds pass).
    seen.catalogueRequested = await within(5_000, () => f.entered("/3/tv/10/season/1"));
    seen.processed = plex.getPlexScanStatus().processed;
    seen.resumePoint = ignoreResults.savedScanState("plex").resumePoint.read();
    seen.report = plex.getPlexReport();
    seen.completed = f.logEvents("plex.show.complete").length;
  });
  const status = await fullScan();
  assert.equal(status.status, "completed", status.error || "");
  assert.equal(seen.catalogueRequested, true, "Show A's TMDB catalogue is requested while Show B's last record is held");
  assert.equal(seen.processed, 0, "no show is compared before the whole library is in");
  assert.equal(seen.resumePoint, null, "no Resume point is saved before the whole library is in");
  assert.equal(seen.report, null, "no report is saved before the whole library is in");
  assert.equal(seen.completed, 0, "no show completes before the whole library is in");
  // The expected report: Show B's record 3 holds TMDB 1002, so Show A misses nothing; Show B has its only episode.
  assert.deepEqual(missingOf("ratingKey:1"), []);
  assert.deepEqual(missingOf("plex://show/b"), []);
  assert.equal(f.requests.filter((pathname) => pathname === "/3/tv/10/season/1").length, 1, "Show A's prepared catalogue is used once, not downloaded again");
  assert.equal(f.requests.filter((pathname) => pathname === "/3/tv/11/season/1").length, 1);
});

test("a fatal failure waits for a show's held preparation and its catalogue save before the run ends", async (t) => {
  const writes: { event: string; running: boolean }[] = [];
  let held = false;
  let entered = false;
  const f = await library(t, async (u) => {
    // Show B's last record is answered once Show A's TMDB episodes have been requested, and those only once the inventory save has failed the run.
    if (u.pathname === "/library/metadata/3/allLeaves") entered = await within(5_000, () => f.entered("/3/tv/10/season/1"));
    if (u.pathname === "/3/tv/10/season/1") held = await within(5_000, () => writes.some((write) => write.event === "inventory failed"));
  });
  plex.getPlexReport();
  const database = f.database();
  database.function("scan_write", (event) => { writes.push({ event: String(event), running: Boolean(scanRuns.activeScanRun()) }); return 0; });
  // The inventory save fails the run once every record is in; Show A's preparation is still waiting for TMDB.
  database.exec(`
    CREATE TRIGGER fail_inventory BEFORE INSERT ON shelfcheck_plex_generated_inputs WHEN NEW.cache_key = 'inventory'
      BEGIN SELECT scan_write('inventory failed'); SELECT RAISE(ABORT, 'inventory store unavailable'); END;
    CREATE TRIGGER show_a_catalogue_saved AFTER INSERT ON shelfcheck_plex_generated_inputs WHEN NEW.cache_key = 'tmdb:10'
      BEGIN SELECT scan_write('Show A catalogue saved'); END;
  `);
  const status = await fullScan();
  assert.equal(status.status, "error");
  assert.match(status.error || "", /inventory store unavailable/);
  assert.equal(entered, true, "Show A's TMDB episodes were requested before the library was in");
  assert.equal(held, true, "Show A's TMDB episodes were held until the run failed");
  assert.deepEqual(writes, [
    { event: "inventory failed", running: true },
    { event: "Show A catalogue saved", running: true },
  ], "the held preparation's catalogue save is written before the run ends");
});

test("each show's preparation settles once per scan, downloaded and then reused", async (t) => {
  const f = await library(t);
  const prepared = () => f.logEvents("plex.show.prepared").map((line) => line.replace(/^.*plex\.show\.prepared \| /, ""));
  assert.equal((await fullScan()).status, "completed");
  assert.deepEqual(prepared().sort(), ['ratingKey="plex://show/b" outcome="downloaded"', 'ratingKey="ratingKey:1" outcome="downloaded"']);
  assert.equal((await fullScan()).status, "completed");
  // Each scan run starts its own log.
  assert.deepEqual(prepared().sort(), ['ratingKey="plex://show/b" outcome="reused"', 'ratingKey="ratingKey:1" outcome="reused"'], "the same day's second scan reuses both catalogues");
  assert.equal(f.logEvents("plex.show.complete").length, 2);
});
