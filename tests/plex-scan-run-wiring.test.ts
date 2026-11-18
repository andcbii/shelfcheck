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
