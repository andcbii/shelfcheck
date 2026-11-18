import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const trakt = await import("../lib/scan");
const sqlite = await import("../lib/sqlite");
const config = await import("../lib/server-config");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

// The Trakt bridge's rate-limit pause, request logger and Resume point save
// belong to the Trakt Scan run that installed them, and act only while that
// run still owns the scan run lock.

type ScanRunRecord = { owner?: { kind: string; runId: string; startedAt: string } };
const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanRun?: ScanRunRecord };

async function traktScanRateLimited(t: TestContext, ownsLock: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), "trakt-scan-run-bridge-"));
  const previous = { data: process.env.SHELFCHECK_DATA_DIR, config: process.env.SHELFCHECK_CONFIG_DIR };
  process.env.SHELFCHECK_DATA_DIR = dir;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previous.data === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous.data;
    if (previous.config === undefined) delete process.env.SHELFCHECK_CONFIG_DIR; else process.env.SHELFCHECK_CONFIG_DIR = previous.config;
    rmSync(dir, { recursive: true, force: true });
  });
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 86_400_000, redirectUri: "https://shelfcheck.example/callback" });
  let releaseProgress!: (response: Response) => void;
  let progressRequested!: () => void;
  const requested = new Promise<void>((resolve) => { progressRequested = resolve; });
  let progressCalls = 0;
  const show = { title: "Example", year: 2020, ids: { trakt: 7, slug: "example" }, aired_episodes: 1, updated_at: "2026-01-01T00:00:00.000Z" };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === "/sync/collection/shows") return Response.json([{ show, seasons: [{ number: 1, episodes: [{ number: 1, collected_at: "2026-01-01T00:00:00.000Z" }] }] }], { headers: { "X-Pagination-Page-Count": "1" } });
    if (u.pathname === "/shows/7/progress/collection") {
      progressCalls += 1;
      if (progressCalls === 1) { progressRequested(); return new Promise<Response>((resolve) => { releaseProgress = resolve; }); }
      return Response.json({ aired: 1, completed: 1, seasons: [{ number: 1, episodes: [{ number: 1, completed: true }] }] });
    }
    throw new Error("Unexpected HTTP: " + u);
  });

  trakt.startScan(true);
  await requested;
  const record = cache.__shelfcheckScanRun!;
  const owner = record.owner;
  assert.equal(owner?.kind, "trakt");
  // Unless it still owns the lock, the run that issued this request has lost it when Trakt answers.
  if (!ownsLock) record.owner = { kind: "trakt", runId: "another-run", startedAt: new Date().toISOString() };
  releaseProgress(new Response("{}", { status: 429, headers: { "Retry-After": "1" } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const status = sqlite.readSingleUserScanStatus() as { status: string; rateLimitPaused?: boolean };
  const checkpoint = sqlite.readSingleUserState().state?.checkpoint;
  const logFile = path.join(dir, "logs", "shelfcheck.log");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  record.owner = owner;
  while (scanRuns.activeScanRun()) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(trakt.getScanStatus().status, "completed");
  return { status, checkpoint, log };
}

test("a Trakt rate-limit pause from the run that owns the lock is recorded with its Resume point", async (t) => {
  const { status, checkpoint, log } = await traktScanRateLimited(t, true);
  assert.equal(status.rateLimitPaused, true);
  assert.ok(checkpoint, "the pause saved a Resume point");
  assert.ok(log.includes("request.retry"));
});

test("a Trakt rate-limit callback from a run that no longer owns the scan run lock writes nothing", async (t) => {
  const { status, checkpoint, log } = await traktScanRateLimited(t, false);
  assert.equal(status.status, "running");
  assert.notEqual(status.rateLimitPaused, true, "no rate-limit pause is written for a run that does not own the lock");
  assert.equal(checkpoint, undefined, "no Resume point is saved");
  assert.ok(!log.includes("request.retry"), "the bridge logger is silent");
  assert.ok(!log.includes("checkpoint.saved"));
});
