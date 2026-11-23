import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SCAN_FAILURE_ISSUE } from "../lib/coverage-issue-ids";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const plex = await import("../lib/plex-scan");
const sqlite = await import("../lib/sqlite");
const ignoreResults = await import("../lib/ignore-results");
const issues = await import("../lib/coverage-issues");
const config = await import("../lib/server-config");
const { scanRuns } = await import("../lib/scan-run");
const { PLEX_CACHE_VERSION } = await import("../lib/plex-scan-cache");
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
  ignoreResults.savedScanState("plex").status.write({ status: "running", processed: 1, total: 4, startedAt: new Date(Date.now() - 200_000).toISOString(), heartbeatAt: new Date(Date.now() - 95_000).toISOString(), currentPhase: "tvdb-series-and-episodes", currentShow: "Show A" });
  const first = plex.getPlexScanStatus();
  assert.equal(first.status, "error");
  assert.equal(first.error, "The previous Plex scan was interrupted during tvdb-series-and-episodes (Show A). Start a new scan to resume from its checkpoint.");
  assert.equal(issues.getCoverageIssue(SCAN_FAILURE_ISSUE)?.cause, first.error);
  issues.resolveCoverageIssue(SCAN_FAILURE_ISSUE);
  assert.deepEqual(plex.getPlexScanStatus(), first, "a later poll rewrites nothing");
  assert.equal(issues.getCoverageIssue(SCAN_FAILURE_ISSUE), undefined, "a later poll does not raise the issue again");
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
  assert.ok(issues.getCoverageIssue(SCAN_FAILURE_ISSUE));
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
      while ((ignoreResults.savedScanState("plex").status.read() as { processed: number }).processed < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      limited = true;
      return new Response("{}", { status: 429, headers: { "Retry-After": "1" } });
    }
    pauseCheckpoint = ignoreResults.savedScanState("plex").resumePoint.read() as Checkpoint | null;
    return undefined;
  });
  const status = await fullScan();
  assert.equal(status.status, "completed", status.error || "");
  const saved = pauseCheckpoint as Checkpoint | null;
  assert.ok(saved, "the pause saved a Resume point");
  assert.deepEqual(saved.shows.map((show) => show.ratingKey).sort(), ["ratingKey:10", "ratingKey:11"], "the in-flight show is not saved");
  assert.deepEqual(Object.keys(saved.scanCache).sort(), ["ratingKey:10", "ratingKey:11"]);
  assert.equal(ignoreResults.savedScanState("plex").resumePoint.read(), null, "the completed run clears its Resume point");
});

test("a full Plex scan run that fails saves a Resume point at once, and the next full run resumes from it", async (t) => {
  const database = () => cache.__shelfcheckDatabase!;
  let ignoredAndRestored = false;
  const dir = await library(t, async (u) => {
    if (u.pathname === "/3/tv/11" && !ignoredAndRestored) {
      // Ignore then Restore during the run: the forced save must not resurrect show 11.
      ignoredAndRestored = true;
      ignoreResults.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "ratingKey:11", title: "Show 11" }] });
      ignoreResults.savedScanState("plex").options.patch({ ignoredShows: [] });
    }
    return undefined;
  });
  ignoreResults.savedScanState("plex").status.read();
  // The report store fails at the final commit, after every show has completed.
  database().exec("CREATE TRIGGER fail_report BEFORE UPDATE OF report ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;");
  const failed = await fullScan();
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "report store unavailable");
  const saved = ignoreResults.savedScanState("plex").resumePoint.read() as Checkpoint | null;
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

test("a Plex scan run vetoed by a coverage-revision change ends at once with a clean error, writing no report, Resume point or scan-failure Coverage Issue", async (t) => {
  let changed = false;
  await library(t, async (u) => {
    if (u.pathname === "/3/tv/12" && !changed) {
      // A Manual Match saved while the scan runs moves the coverage revision this run snapshotted.
      changed = true;
      sqlite.database().exec("UPDATE shelfcheck_coverage_state SET revision=revision+1 WHERE id=1");
    }
    return undefined;
  });
  const status = await fullScan();
  assert.ok(changed);
  assert.equal(status.status, "error");
  assert.equal(status.error, "Manual Matches changed while this scan was running. Start a new Plex scan to include them.");
  assert.equal(status.rateLimitPaused, false);
  assert.equal(status.activeShows, undefined);
  assert.equal(status.currentShow, undefined);
  assert.ok(status.finishedAt);
  assert.equal(ignoreResults.savedScanState("plex").report.read(), null, "nothing is committed");
  assert.equal(ignoreResults.savedScanState("plex").resumePoint.read(), null, "no Resume point is forced for a vetoed report");
  assert.equal(issues.getCoverageIssue(SCAN_FAILURE_ISSUE), undefined);
});

test("after the upgrade a Plex page is idle and its next full scan starts over, though a usable Resume point was saved before", async (t) => {
  const dir = await library(t);
  // A database an earlier release left: a usable Resume point and a running scan status in the old Plex table.
  const legacy = new DatabaseSync(path.join(dir, "shelfcheck.db"));
  legacy.exec("CREATE TABLE shelfcheck_plex_state (user_id TEXT PRIMARY KEY NOT NULL, report TEXT, checkpoint TEXT, scan_status TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const checkpoint = { shows: [{ ratingKey: "ratingKey:10", title: "Show 10", plexEpisodes: 0, missing: [] }], scanCache: { "ratingKey:10": {} }, cacheVersion: PLEX_CACHE_VERSION, autoCompoundEpisodes: true, savedAt: new Date().toISOString() };
  legacy.prepare("INSERT INTO shelfcheck_plex_state(user_id,checkpoint,scan_status,settings) VALUES('single-user',?,?,?)")
    .run(JSON.stringify(checkpoint), JSON.stringify({ status: "running", processed: 1, total: 3, startedAt: new Date().toISOString() }), JSON.stringify({ diagnosticsEnabled: true }));
  legacy.close();

  assert.deepEqual(plex.getPlexScanStatus(), { status: "idle", processed: 0, total: 0 }, "No stale progress or Interrupted scan appears");
  assert.equal(issues.getCoverageIssue(SCAN_FAILURE_ISSUE), undefined);
  const status = await fullScan();
  assert.equal(status.status, "completed", status.error || "");
  assert.equal(logEvents(dir, "plex.checkpoint.resume").length, 0, "Nothing resumes");
  assert.equal(logEvents(dir, "plex.checkpoint.discarded").length, 0, "No Resume point was left to discard");
  assert.equal(status.processed, 3, "Every show is scanned");
});

/** A usable Resume point that resumes show 10, saved by an earlier full run. */
const earlierResumePoint = () => ({ shows: [{ ratingKey: "ratingKey:10", title: "Show 10", plexEpisodes: 0, missing: [] }], scanCache: { "ratingKey:10": {} }, cacheVersion: PLEX_CACHE_VERSION, autoCompoundEpisodes: true, savedAt: new Date().toISOString() });
const earlierReport = { shows: [], scanCache: {}, lastScan: "earlier", finishedAt: "earlier" };

test("a full Plex scan whose completion the store rejects keeps the earlier report with the earlier Resume point", async (t) => {
  await library(t);
  const store = ignoreResults.savedScanState("plex");
  const point = earlierResumePoint();
  store.report.write(earlierReport);
  store.resumePoint.write(point);
  // The store rejects every Resume point change, so the clear that completes the run fails.
  cache.__shelfcheckDatabase!.exec("CREATE TRIGGER fail_resume_point BEFORE UPDATE OF resume_point ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'resume point store unavailable'); END;");
  const status = await fullScan();
  assert.equal(status.status, "error");
  assert.deepEqual(store.report.read(), earlierReport, "No new report is saved beside the earlier Resume point");
  assert.deepEqual(store.resumePoint.read(), point, "The earlier Resume point stays");
});

test("a completed full Plex scan saves its report with no Resume point left", async (t) => {
  await library(t);
  const store = ignoreResults.savedScanState("plex");
  store.report.write(earlierReport);
  store.resumePoint.write(earlierResumePoint());
  const status = await fullScan();
  assert.equal(status.status, "completed", status.error || "");
  const report = store.report.read() as { shows: { ratingKey: string }[] };
  assert.deepEqual(report.shows.map((show) => show.ratingKey).sort(), ["ratingKey:10", "ratingKey:11", "ratingKey:12"]);
  assert.equal(store.resumePoint.read(), null);
});
