import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { episode } from "./manual-match-members";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const store = await import("../lib/manual-coverage");
const issues = await import("../lib/coverage-issues");
const { recheckCoverageHealth } = await import("../lib/manual-coverage-health");
const { ProviderClient } = await import("../lib/provider-client");
hook.deregister();

// Manual Match health rechecks against a real temporary SQLite database, with
// provider responses answered in memory.
const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

test("a TVDB member blocked by a refused TVDB sign-in links its member-verification issue to the sign-in issue", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "manual-coverage-health-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const { mapping } = store.saveCoverageMapping([episode("TMDB", 101), episode("TVDB", 201)]);
  const client = new ProviderClient({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === "/v4/login") return Response.json({ status: "failure" }, { status: 401 });
    if (url.pathname === "/3/tv/10/season/1/episode/101") return Response.json({ id: 101 });
    return Response.json({}, { status: 500 });
  } });

  await recheckCoverageHealth(client, { tmdbToken: "tmdb", tvdbApiKey: "tvdb" });

  const blocked = issues.getCoverageIssue(`member-verification:${mapping.id}:TVDB:201`);
  assert.deepEqual(blocked?.causedBy, ["provider-authentication:TVDB"]);
  assert.equal(issues.getCoverageIssue(`member-verification:${mapping.id}:TMDB:101`), undefined, "the TMDB member was verified");
});
