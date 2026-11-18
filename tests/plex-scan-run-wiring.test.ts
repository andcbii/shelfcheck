import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const plex = await import("../lib/plex-scan");
const sqlite = await import("../lib/sqlite");
const issues = await import("../lib/coverage-issues");
const config = await import("../lib/server-config");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

/** A disposable, unconfigured data and config directory. */
function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "plex-scan-run-"));
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

test("an Interrupted Plex scan is written once and raises the scan-failure Coverage Issue once", (t) => {
  directory(t);
  sqlite.writePlexScanStatus({ status: "running", processed: 1, total: 4, startedAt: new Date(Date.now() - 200_000).toISOString(), heartbeatAt: new Date(Date.now() - 95_000).toISOString(), currentPhase: "tvdb-series-and-episodes", currentShow: "Show A" });
  const first = plex.getPlexScanStatus();
  assert.equal(first.status, "error");
  assert.equal(first.error, "The previous Plex scan was interrupted during tvdb-series-and-episodes (Show A). Start a new scan to resume from its checkpoint.");
  assert.equal(issues.getCoverageIssue("scan-failure")?.cause, first.error);
  issues.resolveCoverageIssue("scan-failure");
  assert.deepEqual(plex.getPlexScanStatus(), first, "a later poll rewrites nothing");
  assert.equal(issues.getCoverageIssue("scan-failure"), undefined, "a later poll does not raise the issue again");
});

test("a failed Plex scan run records its error through the lifecycle, logs to the Plex log and releases the lock", async (t) => {
  const dir = directory(t);
  plex.startPlexScan();
  while (scanRuns.activeScanRun()) await new Promise((resolve) => setTimeout(resolve, 5));
  const status = plex.getPlexScanStatus();
  assert.equal(status.status, "error");
  assert.equal(status.error, "Configure Plex, TMDB, and TVDB credentials before scanning.");
  assert.equal(status.rateLimitPaused, false);
  assert.equal(status.activeShows, undefined);
  assert.ok(issues.getCoverageIssue("scan-failure"));
  const log = readFileSync(path.join(dir, "logs", "shelfcheck-plex.log"), "utf8");
  assert.match(log, /plex\.scan\.start \| startedAt=.* version=.* mode="full"/);
  assert.match(log, /\[ERROR\] plex\.scan\.error \| error="Configure Plex, TMDB, and TVDB credentials before scanning\."/);
});

type Checkpoint = { shows: { ratingKey: string }[]; scanCache: Record<string, unknown>; savedAt: string };

/**
 * A configured Plex library of three TMDB-matched shows (10, 11 and 12) behind
 * a mocked fetch. `hold` may delay or replace any response.
 */
async function library(t: TestContext, hold: (url: URL) => Promise<Response | undefined> = async () => undefined) {
  const dir = directory(t);
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "test", tvdbApiKey: "test" });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const held = await hold(u);
    if (held) return held;
    const id = Number(u.pathname.match(/\/tv\/(\d+)/)?.[1]);
    let body: unknown;
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections") body = { MediaContainer: { Directory: [{ key: "1", type: "show" }] } };
      else if (u.pathname.includes("/sections/")) body = { MediaContainer: { Metadata: [10, 11, 12].map((key) => ({ ratingKey: String(key), title: `Show ${key}`, Guid: [{ id: `tmdb://${key}` }] })) } };
      else if (u.pathname.includes("allLeaves")) body = { MediaContainer: { Metadata: [] } };
      else { const key = u.pathname.split("/").pop(); body = { MediaContainer: { Metadata: [{ ratingKey: key, title: `Show ${key}`, Guid: [{ id: `tmdb://${key}` }] }] } }; }
    } else if (u.pathname === "/v4/login") body = { data: { token: "test" } };
    else if (u.pathname.match(/\/3\/tv\/\d+\/season\/1$/)) body = { episodes: [{ id: id + 90, season_number: 1, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }] };
    else if (u.pathname.match(/\/3\/tv\/\d+$/)) body = { id, name: `Show ${id}`, seasons: [{ season_number: 1 }] };
    else if (u.pathname === "/3/tv/changes") body = { results: [], total_pages: 1 };
    else if (u.pathname === "/v4/updates") body = { data: [] };
    else throw new Error("Unexpected HTTP: " + u);
    return Response.json(body);
  });
  return dir;
}

async function fullScan() {
  plex.startPlexScan();
  while (scanRuns.activeScanRun()) await new Promise((resolve) => setTimeout(resolve, 5));
  return plex.getPlexScanStatus();
}

const logEvents = (dir: string, event: string) => readFileSync(path.join(dir, "logs", "shelfcheck-plex.log"), "utf8").split(/\r?\n/).filter((line) => line.includes(` ${event} |`));

test("a rate-limit pause saves a Resume point of the completed shows when it starts", async (t) => {
  let pauseCheckpoint: Checkpoint | null = null;
  let limited = false;
  await library(t, async (u) => {
    if (u.pathname !== "/3/tv/12") return undefined;
    if (!limited) {
      // Show 12 is rate limited once the other two shows have completed.
      while ((sqlite.readPlexScanStatus() as { processed: number }).processed < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      limited = true;
      return new Response("{}", { status: 429, headers: { "Retry-After": "1" } });
    }
    pauseCheckpoint = sqlite.readPlexCheckpoint() as Checkpoint | null;
    return undefined;
  });
  const status = await fullScan();
  assert.equal(status.status, "completed", status.error || "");
  const saved = pauseCheckpoint as Checkpoint | null;
  assert.ok(saved, "the pause saved a Resume point");
  assert.deepEqual(saved.shows.map((show) => show.ratingKey).sort(), ["ratingKey:10", "ratingKey:11"], "the in-flight show is not saved");
  assert.deepEqual(Object.keys(saved.scanCache).sort(), ["ratingKey:10", "ratingKey:11"]);
  assert.equal(sqlite.readPlexCheckpoint(), null, "the completed run clears its Resume point");
});

test("a full Plex scan run that fails saves a Resume point at once, and the next full run resumes from it", async (t) => {
  const database = () => cache.__shelfcheckDatabase!;
  let ignoredAndRestored = false;
  const dir = await library(t, async (u) => {
    if (u.pathname === "/3/tv/11" && !ignoredAndRestored) {
      // Ignore then Restore during the run: the forced save must not resurrect show 11.
      ignoredAndRestored = true;
      sqlite.writePlexSettings({ ignoredShows: [{ ratingKey: "ratingKey:11", title: "Show 11" }] });
      sqlite.writePlexSettings({ ignoredShows: [] });
    }
    return undefined;
  });
  sqlite.readPlexScanStatus();
  // The report store fails at the final commit, after every show has completed.
  database().exec("CREATE TRIGGER fail_report BEFORE UPDATE OF report ON shelfcheck_plex_state BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;");
  const failed = await fullScan();
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "report store unavailable");
  const saved = sqlite.readPlexCheckpoint() as Checkpoint | null;
  assert.ok(saved, "the failure saved a Resume point");
  assert.deepEqual(saved.shows.map((show) => show.ratingKey).sort(), ["ratingKey:10", "ratingKey:12"]);
  assert.deepEqual(Object.keys(saved.scanCache).sort(), ["ratingKey:10", "ratingKey:12"]);
  assert.equal(logEvents(dir, "plex.checkpoint.saved").filter((line) => line.includes('reason="failure"')).length, 1);

  database().exec("DROP TRIGGER fail_report;");
  const resumed = await fullScan();
  assert.equal(resumed.status, "completed", resumed.error || "");
  const resume = logEvents(dir, "plex.checkpoint.resume");
  assert.equal(resume.length, 1);
  assert.match(resume[0], new RegExp(`savedAt="${saved.savedAt}" shows=2`));
});
