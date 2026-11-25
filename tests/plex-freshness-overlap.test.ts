import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const plex = await import("../lib/plex-scan");
const config = await import("../lib/server-config");
const ignoreResults = await import("../lib/ignore-results");
const { readPlexInputs } = await import("../lib/plex-catalogues");
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

type Watched = "allLeaves" | "tmdb-changes" | "tvdb-updates";
/** A hold decides when a request is answered; it returns false when its condition did not hold in time. */
type Hold = () => Promise<boolean>;

/**
 * A configured library of two shows, Show 1 (TMDB 10, TVDB 20) and Show 2 (TMDB 11, TVDB 21), behind
 * a mocked fetch. A first full scan saves both providers' catalogues and verification positions, so
 * every later full scan needs the TMDB change list and the TVDB updates. Each request's entry and
 * answer are recorded in order; an armed hold delays a request's answer.
 */
async function library(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "plex-freshness-overlap-"));
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
  ignoreResults.savedScanState("plex").options.patch({ diagnosticsEnabled: false });
  const events: string[] = [];
  /** Every request's path, in the order it entered. */
  const paths: string[] = [];
  const holds: Partial<Record<Watched, Hold>> = {};
  const late: Watched[] = [];
  let tvdbChanged: number[] = [];
  const shows = [1, 2].map((key) => ({ ratingKey: String(key), title: `Show ${key}`, Guid: [{ id: `tmdb://${key + 9}` }, { id: `tvdb://${key + 19}` }] }));
  const respond = (u: URL) => {
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections") return { MediaContainer: { Directory: [{ key: "1", type: "show" }] } };
      if (u.pathname.includes("/sections/")) return { MediaContainer: { Metadata: shows } };
      const key = Number(u.pathname.split("/")[3]);
      if (u.pathname.endsWith("allLeaves")) return { MediaContainer: { Metadata: [{ ratingKey: `${key}01`, parentIndex: 1, index: 1, Guid: [{ id: `tmdb://${key + 99}` }, { id: `tvdb://${key + 199}` }] }] } };
      return { MediaContainer: { Metadata: [shows[key - 1]] } };
    }
    if (u.pathname === "/v4/login") return { data: { token: "test" } };
    if (u.pathname === "/3/tv/changes") return { results: [], total_pages: 1 };
    if (u.pathname === "/v4/updates") return { data: tvdbChanged.map((id) => ({ entityType: "series", recordId: id })) };
    let match = u.pathname.match(/^\/3\/tv\/(\d+)$/);
    if (match) return { id: Number(match[1]), name: `Show ${Number(match[1]) - 9}`, seasons: [{ season_number: 1 }], external_ids: { tvdb_id: Number(match[1]) + 10 } };
    match = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1$/);
    if (match) return { episodes: [{ id: Number(match[1]) + 90, season_number: 1, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }] };
    match = u.pathname.match(/^\/v4\/series\/(\d+)$/);
    if (match) return { data: { id: Number(match[1]), name: `Show ${Number(match[1]) - 19}`, slug: `show-${match[1]}` } };
    match = u.pathname.match(/^\/v4\/series\/(\d+)\/episodes\/default$/);
    if (match) return { data: { episodes: [{ id: Number(match[1]) + 180, seasonNumber: 1, number: 1, name: "Pilot", aired: "2020-01-01" }] } };
    if (u.pathname.includes("/find/")) return { tv_results: [], tv_episode_results: [] };
    throw new Error("Unexpected HTTP: " + u);
  };
  const kind = (u: URL): Watched | undefined => u.pathname.endsWith("/allLeaves") ? "allLeaves" : u.pathname === "/3/tv/changes" ? "tmdb-changes" : u.pathname === "/v4/updates" ? "tvdb-updates" : undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const request = kind(u);
    paths.push(u.pathname);
    if (request) events.push(`enter ${request}`);
    const hold = request && holds[request];
    if (hold && !(await hold())) late.push(request);
    const body = respond(u);
    if (request) events.push(`answer ${request}`);
    return Response.json(body);
  });
  const fullScan = async () => {
    plex.startPlexScan();
    assert.ok(await within(20_000, () => !scanRuns.activeScanRun()), "the scan run ends within 20 seconds");
    return plex.getPlexScanStatus();
  };
  assert.equal((await fullScan()).status, "completed", "the first full scan saves catalogues and positions");
  events.length = 0;
  paths.length = 0;
  return {
    events, late, fullScan,
    entered: (pathname: string) => paths.includes(pathname),
    count: (event: string) => events.filter((entry) => entry === event).length,
    /** Arm holds for the next scan. Each hold waits at most 3 seconds for its condition. */
    arm(next: Partial<Record<Watched, () => boolean>>) {
      for (const [request, condition] of Object.entries(next) as [Watched, () => boolean][]) holds[request] = () => within(3_000, condition);
    },
    changeTvdb(ids: number[]) { tvdbChanged = ids; },
    database: () => cache.__shelfcheckDatabase!,
  };
}

test("with the Plex inventory held, the TMDB change list and the TVDB updates both enter", async (t) => {
  const f = await library(t);
  // Each side is answered only once the other has entered: a scan that runs them one after the other cannot finish its holds.
  f.arm({
    allLeaves: () => f.count("enter tmdb-changes") > 0 && f.count("enter tvdb-updates") > 0,
    "tmdb-changes": () => f.count("enter allLeaves") > 0,
    "tvdb-updates": () => f.count("enter allLeaves") > 0,
  });
  const status = await f.fullScan();
  assert.equal(status.status, "completed", status.error || "");
  assert.deepEqual(f.late, [], "every held request saw the other side enter");
  assert.equal(f.count("answer allLeaves"), 2);
  assert.equal(f.count("answer tmdb-changes"), 1);
  assert.equal(f.count("answer tvdb-updates"), 1);
});

for (const feed of ["tmdb-changes", "tvdb-updates"] as const) {
  test(`with the ${feed === "tmdb-changes" ? "TMDB change list" : "TVDB updates"} held, the Plex inventory downloads every record`, async (t) => {
    const f = await library(t);
    f.arm({ [feed]: () => f.count("answer allLeaves") === 2 });
    const status = await f.fullScan();
    assert.equal(status.status, "completed", status.error || "");
    assert.deepEqual(f.late, []);
    assert.ok(f.events.indexOf(`answer ${feed}`) > f.events.lastIndexOf("answer allLeaves"), "the held feed is answered after the inventory");
  });
}

test("with both change lists held, each show's Plex metadata is requested", async (t) => {
  const f = await library(t);
  // A show's Plex metadata needs no freshness decision, so it is requested while both change lists are held.
  const metadataIn = () => f.entered("/library/metadata/1") && f.entered("/library/metadata/2");
  f.arm({ "tmdb-changes": metadataIn, "tvdb-updates": metadataIn });
  const status = await f.fullScan();
  assert.equal(status.status, "completed", status.error || "");
  assert.deepEqual(f.late, [], "both shows' metadata was requested while the change lists were held");
});

test("with the TVDB updates held, a show without a saved TMDB catalogue downloads it", async (t) => {
  const f = await library(t);
  // TMDB's catalogue choice waits for TMDB's freshness alone.
  f.database().exec("DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key = 'tmdb:10'");
  f.arm({ "tvdb-updates": () => f.entered("/3/tv/10/season/1") });
  const status = await f.fullScan();
  assert.equal(status.status, "completed", status.error || "");
  assert.deepEqual(f.late, [], "Show 1's TMDB catalogue was requested while the TVDB updates were held");
});

test("a fatal inventory failure waits for the held TVDB updates and their retention before the run ends", async (t) => {
  const f = await library(t);
  const writes: { event: string; running: boolean }[] = [];
  const database = f.database();
  database.function("scan_write", (event) => { writes.push({ event: String(event), running: Boolean(scanRuns.activeScanRun()) }); return 0; });
  // The inventory save fails the run; the TVDB updates are held until it has failed.
  database.exec(`
    CREATE TRIGGER fail_inventory BEFORE UPDATE ON shelfcheck_plex_generated_inputs WHEN NEW.cache_key = 'inventory'
      BEGIN SELECT scan_write('inventory failed'); SELECT RAISE(ABORT, 'inventory store unavailable'); END;
    CREATE TRIGGER pending_tvdb_saved AFTER INSERT ON shelfcheck_plex_generated_inputs WHEN NEW.cache_key = 'pending-tvdb'
      BEGIN SELECT scan_write('pending TVDB changes saved'); END;
    CREATE TRIGGER pending_tvdb_updated AFTER UPDATE ON shelfcheck_plex_generated_inputs WHEN NEW.cache_key = 'pending-tvdb'
      BEGIN SELECT scan_write('pending TVDB changes saved'); END;
  `);
  f.changeTvdb([20]);
  f.arm({ "tvdb-updates": () => writes.some((write) => write.event === "inventory failed") });
  const status = await f.fullScan();
  assert.equal(status.status, "error");
  assert.match(status.error || "", /inventory store unavailable/);
  assert.deepEqual(f.late, [], "the TVDB updates were held until the inventory failed");
  assert.deepEqual(writes, [
    { event: "inventory failed", running: true },
    { event: "pending TVDB changes saved", running: true },
  ], "the held task's retention is written before the run ends");
  assert.deepEqual(readPlexInputs().pendingTvdbChanges, { 20: true });
});
