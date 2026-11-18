import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const traktRoute = await import("../app/api/scan/route");
const plexRoute = await import("../app/api/plex/scan/route");
const config = await import("../lib/server-config");
const sqlite = await import("../lib/sqlite");
const coverage = await import("../lib/manual-coverage");
const catalogue = await import("../lib/catalogue-selection-store");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

/** A disposable data and config directory with Trakt and Plex configured, and providers that wait until released. */
async function harness(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-start-conflict-routes-"));
  const previousData = process.env.SHELFCHECK_DATA_DIR;
  const previousConfig = process.env.SHELFCHECK_CONFIG_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  let release!: () => void;
  const providers = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    await providers;
    return url.hostname === "plex" ? Response.json({ MediaContainer: {} }) : Response.json([]);
  });
  t.after(async () => {
    release();
    while (scanRuns.activeScanRun()) await new Promise((resolve) => setTimeout(resolve, 5));
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previousData === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previousData;
    if (previousConfig === undefined) delete process.env.SHELFCHECK_CONFIG_DIR; else process.env.SHELFCHECK_CONFIG_DIR = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  });
  await config.writeTraktCredentials({ clientId: "id", clientSecret: "secret", accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 86_400_000, redirectUri: "http://localhost/callback" });
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "test", tvdbApiKey: "test" });
  const logs = () => existsSync(path.join(dir, "logs")) ? readdirSync(path.join(dir, "logs")).sort() : [];
  const providerCalled = async (hostname: string) => { while (!calls.includes(hostname)) await new Promise((resolve) => setTimeout(resolve, 5)); };
  const settled = async () => { release(); while (scanRuns.activeScanRun()) await new Promise((resolve) => setTimeout(resolve, 5)); };
  return { logs, providerCalled, settled };
}

const post = (url: string, body: unknown) => new Request(url, { method: "POST", body: JSON.stringify(body) });
const startTrakt = (body: unknown = {}) => traktRoute.POST(post("http://localhost/api/scan", body));
const startPlex = (body: unknown = {}) => plexRoute.POST(post("http://localhost/api/plex/scan", body));

test("a Plex start, full or single-show, is refused with 409 while a Trakt scan run is active, with no side effects", async (t) => {
  const scans = await harness(t);
  const accepted = await startTrakt();
  assert.equal(accepted.status, 202);
  await scans.providerCalled("api.trakt.tv");
  const traktStatus = sqlite.readSingleUserScanStatus();
  const plexStatus = sqlite.readPlexScanStatus();
  const logs = scans.logs();

  for (const body of [{}, { ratingKey: "42" }]) {
    const refused = await startPlex(body);
    assert.equal(refused.status, 409);
    const json = await refused.json();
    assert.equal(json.error, "A Trakt scan is running. You can start a Plex scan when it finishes.");
    assert.equal(json.activeScanRun.kind, "trakt");
    assert.equal(json.activeScanRun.status.status, "running");
    assert.equal(json.scan, undefined, "the Trakt status is never presented as the requested Plex scan");
  }
  assert.deepEqual(sqlite.readSingleUserScanStatus(), traktStatus);
  assert.deepEqual(sqlite.readPlexScanStatus(), plexStatus);
  assert.deepEqual(scans.logs(), logs, "a refused start rotates no log");
  assert.equal(scanRuns.activeScanRun()?.kind, "trakt");

  const sameKind = await startTrakt({ force: true });
  assert.equal(sameKind.status, 409);
  assert.equal((await sameKind.json()).error, "A Trakt scan is running. You can start another Trakt scan when it finishes.");

  // Manual Match and comparison catalogue changes stay refused only while a Plex scan run is active.
  assert.doesNotThrow(() => coverage.assertCoverageMutationAllowed());
  catalogue.observeCatalogueCandidates("plex://show/one", { tmdb: [1, 2], tvdb: [] }, true);
  assert.doesNotThrow(() => catalogue.saveCatalogueOverride("plex://show/one", "tmdb", 2));

  await scans.settled();
  const afterwards = await startPlex();
  assert.equal(afterwards.status, 202, "the lock is released once the Trakt scan run settles");
});

test("a Trakt start, full or single-show, is refused with 409 while a Plex scan run is active, with no side effects", async (t) => {
  const scans = await harness(t);
  const accepted = await startPlex();
  assert.equal(accepted.status, 202);
  await scans.providerCalled("plex");
  const traktStatus = sqlite.readSingleUserScanStatus();
  const plexStatus = sqlite.readPlexScanStatus();
  const logs = scans.logs();

  for (const body of [{}, { force: true }, { traktId: 7 }]) {
    const refused = await startTrakt(body);
    assert.equal(refused.status, 409);
    const json = await refused.json();
    assert.equal(json.error, "A Plex scan is running. You can start a Trakt scan when it finishes.");
    assert.equal(json.activeScanRun.kind, "plex");
    assert.equal(json.activeScanRun.status.status, "running");
    assert.equal(json.scan, undefined, "the Plex status is never presented as the requested Trakt scan");
  }
  assert.deepEqual(sqlite.readSingleUserScanStatus(), traktStatus);
  assert.deepEqual(sqlite.readPlexScanStatus(), plexStatus);
  assert.deepEqual(scans.logs(), logs, "a refused start rotates no log");

  const sameKind = await startPlex({ ratingKey: "42" });
  assert.equal(sameKind.status, 409);
  assert.equal((await sameKind.json()).error, "A Plex scan is running. You can start another Plex scan when it finishes.");

  assert.throws(() => coverage.assertCoverageMutationAllowed(), (error: unknown) => (error as { code?: string }).code === "scan-active");

  await scans.settled();
  assert.equal((await startTrakt()).status, 202, "the lock is released once the Plex scan run settles");
});

test("a single-show Plex check that cannot start releases the lock it claimed", async (t) => {
  await harness(t);
  const refused = await startPlex({ ratingKey: "42" });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Run a full Plex search/);
  assert.equal(scanRuns.activeScanRun(), null);
});
