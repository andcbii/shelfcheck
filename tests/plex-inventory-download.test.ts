import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const plex = await import("../lib/plex-scan");
const ignoreResults = await import("../lib/ignore-results");
const config = await import("../lib/server-config");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

/** A disposable data and config directory. */
function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "plex-inventory-"));
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
  return dir;
}

/** Polls `condition` every 5 ms for at most `milliseconds`; true once it holds. */
async function within(milliseconds: number, condition: () => boolean) {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

// Twelve shows, 10-21; 20 and 21 are two physical records of one merged show.
const KEYS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const showRecord = (key: number) => ({ ratingKey: String(key), title: key >= 20 ? "Merged" : `Show ${key}`, Guid: [{ id: `tmdb://${key >= 20 ? 20 : key}` }], ...(key >= 20 ? { guid: "plex://show/merged" } : {}) });

test("the Plex inventory downloads one record per job with at most 8 in flight, retries included, and covers merged and ignored shows", async (t) => {
  directory(t);
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "test", tvdbApiKey: "test" });
  // Show 12 is ignored: its record is still downloaded for Manual Match evidence.
  ignoreResults.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "ratingKey:12", title: "Show 12" }] });

  // Each record's episode list is held until released; a record is in flight from its first request until it is answered.
  const releases = new Map<string, () => void>();
  const released = new Set<string>();
  const entered: string[] = [];
  const inFlight = new Set<string>();
  let peak = 0;
  let retried = false;
  const release = (key: string) => { released.add(key); releases.get(key)?.(); };

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const id = Number(u.pathname.match(/\/tv\/(\d+)/)?.[1]);
    let body: unknown;
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections") body = { MediaContainer: { Directory: [{ key: "1", type: "show" }] } };
      else if (u.pathname.includes("/sections/")) body = { MediaContainer: { Metadata: KEYS.map(showRecord) } };
      else if (u.pathname.endsWith("/allLeaves")) {
        const key = u.pathname.split("/")[3];
        if (!inFlight.has(key)) { entered.push(key); inFlight.add(key); peak = Math.max(peak, inFlight.size); }
        if (!released.has(key)) await new Promise<void>((resolve) => releases.set(key, resolve));
        // The first record released fails once with a short Retry-After, and keeps its slot while it waits.
        if (!retried) { retried = true; return new Response("{}", { status: 503, headers: { "Retry-After": "1" } }); }
        inFlight.delete(key);
        body = { MediaContainer: { Metadata: [{ ratingKey: `${key}01`, parentIndex: 1, index: key === "21" ? 2 : 1, Guid: [{ id: `tmdb://${Number(key) + 90}` }] }] } };
      } else { const key = Number(u.pathname.split("/").pop()); body = { MediaContainer: { Metadata: [showRecord(key)] } }; }
    } else if (u.pathname === "/v4/login") body = { data: { token: "test" } };
    else if (u.pathname.match(/\/3\/tv\/\d+\/season\/1$/)) body = { episodes: [{ id: id + 90, season_number: 1, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }] };
    else if (u.pathname.match(/\/3\/tv\/\d+$/)) body = { id, name: `Show ${id}`, seasons: [{ season_number: 1 }] };
    else if (u.pathname === "/3/tv/changes") body = { results: [], total_pages: 1 };
    else if (u.pathname === "/v4/updates") body = { data: [] };
    else throw new Error("Unexpected HTTP: " + u);
    return Response.json(body);
  });

  plex.startPlexScan();
  try {
    assert.ok(await within(5_000, () => entered.length >= 8), `8 records enter together; entered ${entered.length}`);
    assert.equal(await within(150, () => entered.length > 8), false, "no 9th record enters while 8 are held");
    release(entered[0]);
    // The released record is retried after a 1-second Retry-After; were its slot freed meanwhile, the peak would pass 8.
    assert.ok(await within(5_000, () => entered.length === 9), "the 9th record enters once one is answered");
  } finally {
    // Release every held record and let the run end, so nothing writes after the directory is removed.
    for (const key of KEYS) release(String(key));
    assert.ok(await within(10_000, () => !scanRuns.activeScanRun()), "the scan run ends");
  }

  const status = plex.getPlexScanStatus();
  assert.equal(status.status, "completed", status.error || "");
  assert.ok(retried);
  assert.ok(peak <= 8, `at most 8 records in flight, retries included; peak ${peak}`);
  assert.deepEqual(entered.map(Number).sort((a, b) => a - b), KEYS, "every physical record is downloaded once, merged and ignored ones included");
  const report = ignoreResults.savedScanState("plex").report.read() as { shows: { ratingKey: string; plexEpisodes: number; missing: unknown[] }[] };
  const merged = report.shows.find((show) => show.ratingKey === "plex://show/merged");
  assert.equal(merged?.plexEpisodes, 2, "the merged show's two records aggregate back to it");
  assert.equal(report.shows.some((show) => show.ratingKey === "ratingKey:12"), false, "the ignored show is not compared");
  assert.equal(report.shows.length, 10);
});
