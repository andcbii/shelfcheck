import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import test from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const route = await import("../app/api/scan-runs/route");
const sqlite = await import("../lib/sqlite");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

test("the scan-runs route reports no active Scan run while idle, privately and uncached", async () => {
  assert.equal(route.dynamic, "force-dynamic");
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), { activeScanRun: null });
});

test("the scan-runs route reports the owner's kind and start time only, for as long as it owns the lock", async () => {
  let finish!: () => void;
  const { owner, settled } = scanRuns.start("plex", () => new Promise<void>((resolve) => { finish = resolve; }));
  try {
    const body = await (await route.GET()).json();
    assert.deepEqual(body, { activeScanRun: { kind: "plex", startedAt: owner.startedAt } }, "no run identity, status or progress is exposed");
  } finally {
    finish();
    await settled;
  }
  assert.deepEqual(await (await route.GET()).json(), { activeScanRun: null });
});

test("the scan-runs route never reconciles a stale running status into an Interrupted scan", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-runs-activity-route-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const stale = { status: "running", processed: 1, total: 4, startedAt: "2026-01-01T00:00:00.000Z", heartbeatAt: "2026-01-01T00:00:00.000Z" };
  sqlite.savedScanState("plex").status.write(stale);
  sqlite.savedScanState("trakt").status.write(stale);
  assert.deepEqual(await (await route.GET()).json(), { activeScanRun: null });
  assert.deepEqual(sqlite.savedScanState("plex").status.read(), stale);
  assert.deepEqual(sqlite.savedScanState("trakt").status.read(), stale);
});
