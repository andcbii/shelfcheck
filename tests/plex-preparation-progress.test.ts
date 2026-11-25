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
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

// A Plex scan's status reports its preparation while it runs: library records
// read (or failed) out of every record in the library, and shows whose TMDB and
// TVDB episode lists are prepared (downloaded, reused or failed) out of the shows
// it compares. Every status the scan writes is recorded, in order.

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

type Count = { settled: number; total: number };
type Written = { status: string; processed: number; total: number; preparation?: { inventory?: Count; catalogues?: Count } };

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
 * A configured Plex library behind a mocked fetch, TMDB only: Show A (rating key 1, TMDB 10) and Show B,
 * one show of two Plex records (2 and 3). `fillers` adds that many one-record shows (rating keys 4 on)
 * Plex reports no ID or episode for, so no episode list can be prepared for them. `empty` lists no show.
 * `hold(url)` may delay a request's answer, or replace it with its own response.
 */
async function library(t: TestContext, options: { hold?: (url: URL) => Promise<void | Response>; fillers?: number; empty?: boolean } = {}) {
  const { hold = async () => {}, fillers = 0, empty = false } = options;
  const dir = mkdtempSync(path.join(tmpdir(), "plex-preparation-progress-"));
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
  const records = empty ? [] : [
    { ratingKey: "1", title: "Show A", Guid: [{ id: "tmdb://10" }] },
    { ratingKey: "2", guid: "plex://show/b", title: "Show B", Guid: [{ id: "tmdb://11" }] },
    { ratingKey: "3", guid: "plex://show/b", title: "Show B", Guid: [{ id: "tmdb://11" }] },
    ...Array.from({ length: fillers }, (_, index) => ({ ratingKey: String(index + 4), title: `Filler ${index + 4}`, Guid: [] })),
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
    const replaced = await hold(u);
    if (replaced) return replaced;
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
  // Every status the scan writes, in order.
  const written: Written[] = [];
  const write = plex.plexSavedState.status.write;
  t.mock.method(plex.plexSavedState.status, "write", (status: Written) => {
    written.push(JSON.parse(JSON.stringify(status)));
    write(status as never);
  });
  return { written };
}

async function scan(targetRatingKey?: string) {
  plex.startPlexScan(targetRatingKey);
  assert.ok(await within(20_000, () => !scanRuns.activeScanRun()), "the scan run ends within 20 seconds");
  return plex.getPlexScanStatus();
}

/** The running statuses that carry preparation progress. */
const preparing = (written: Written[]) => written.filter((status) => status.status === "running" && status.preparation);
/** One count's settled values as they change, and every total it was reported with. */
function counts(written: Written[], count: "inventory" | "catalogues") {
  const values = preparing(written).map((status) => status.preparation![count]!);
  return {
    settled: values.map((value) => value.settled).filter((settled, index, all) => index === 0 || settled !== all[index - 1]),
    totals: [...new Set(values.map((value) => value.total))],
  };
}

test("a full scan counts each library record and each show's episode lists once, with the counter starting once comparisons begin", async (t) => {
  let atOverlap: Written | undefined;
  const f = await library(t, {
    hold: async (u) => {
      // Show B's TMDB episodes are answered once Show A has been compared (or 5 seconds pass).
      if (u.pathname !== "/3/tv/11/season/1") return;
      await within(5_000, () => plex.getPlexScanStatus().processed >= 1);
      atOverlap = plex.getPlexScanStatus() as Written;
    },
  });
  const status = await scan();
  assert.equal(status.status, "completed", status.error || "");

  assert.deepEqual(counts(f.written, "inventory"), { settled: [0, 1, 2, 3], totals: [3] }, "3 library records, each read once");
  assert.deepEqual(counts(f.written, "catalogues"), { settled: [0, 1, 2], totals: [2] }, "2 shows, each prepared once");
  for (const written of preparing(f.written)) {
    const { inventory, catalogues } = written.preparation!;
    assert.ok(inventory!.settled <= inventory!.total && catalogues!.settled <= catalogues!.total, "counts never pass their totals");
  }

  const counting = f.written.filter((written) => written.status === "running" && written.total > 0);
  assert.ok(counting.length > 0, "the comparison counter starts");
  assert.ok(f.written.indexOf(counting[0]) > f.written.findIndex((written) => written.preparation?.inventory?.settled === 3), "the counter starts only once the whole library is read");
  assert.equal(f.written.filter((written) => written.status === "running" && written.total === 0 && written.preparation).length > 0, true, "preparation is reported before the counter starts");

  assert.equal(atOverlap?.processed, 1, "Show A was compared while Show B's episode lists were still being prepared");
  assert.equal(atOverlap?.total, 2);
  assert.deepEqual(atOverlap?.preparation, { inventory: { settled: 3, total: 3 }, catalogues: { settled: 1, total: 2 } }, "the preparation line stays alongside the counter");

  assert.equal((status as Written).preparation, undefined, "a completed scan carries no preparation");
});

test("a failed library record and shows whose episode lists cannot be prepared still count as settled", async (t) => {
  const f = await library(t, {
    fillers: 2,
    hold: async (u) => u.pathname === "/library/metadata/5/allLeaves" ? Response.json({ errors: ["gone"] }, { status: 404 }) : undefined,
  });
  const status = await scan();
  assert.equal(status.status, "completed", status.error || "");
  assert.deepEqual(counts(f.written, "inventory"), { settled: [0, 1, 2, 3, 4, 5], totals: [5] });
  assert.deepEqual(counts(f.written, "catalogues"), { settled: [0, 1, 2, 3, 4], totals: [4] });
});

test("a library with no shows reports empty preparation and completes", async (t) => {
  const f = await library(t, { empty: true });
  const status = await scan();
  assert.equal(status.status, "completed", status.error || "");
  assert.deepEqual(preparing(f.written).at(-1)?.preparation, { inventory: { settled: 0, total: 0 }, catalogues: { settled: 0, total: 0 } });
});

test("a single-show scan reads the whole library but prepares only its show", async (t) => {
  const f = await library(t);
  assert.equal((await scan()).status, "completed");
  f.written.length = 0;
  const status = await scan("ratingKey:1");
  assert.equal(status.status, "completed", status.error || "");
  assert.deepEqual(counts(f.written, "inventory"), { settled: [0, 1, 2, 3], totals: [3] }, "library-wide");
  assert.deepEqual(counts(f.written, "catalogues"), { settled: [0, 1], totals: [1] });
});
