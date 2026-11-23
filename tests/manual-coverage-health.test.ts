import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { memberVerificationIssueId } from "../lib/coverage-issue-ids";
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

test("a TVDB member blocked by the scan's failed TVDB sign-in links its member-verification issue to the sign-in issue, without a TVDB request", async (t) => {
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
  const requested: string[] = [];
  const client = new ProviderClient({ fetch: async input => {
    const url = new URL(String(input));
    requested.push(url.pathname);
    if (url.pathname === "/3/tv/10/season/1/episode/101") return Response.json({ id: 101 });
    return Response.json({}, { status: 500 });
  } });

  // A sign-in that returned no token fails with a plain error, not an HTTP one.
  await recheckCoverageHealth(client, { tmdbToken: "tmdb", tvdbSignIn: { outcome: "failed", error: new Error("TVDB login did not return a token.") } });

  const blocked = issues.getCoverageIssue(memberVerificationIssueId(mapping.id, { provider: "TVDB", id: 201 }));
  assert.deepEqual(blocked?.causedBy, ["provider-authentication:TVDB"]);
  assert.equal(issues.getCoverageIssue(memberVerificationIssueId(mapping.id, { provider: "TMDB", id: 101 })), undefined, "the TMDB member was verified");
  assert.deepEqual(requested, ["/3/tv/10/season/1/episode/101"], "no sign-in and no TVDB member request");
  assert.equal(store.listCoverageMappings()[0].health, "pending");
});
