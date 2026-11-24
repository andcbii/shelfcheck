import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { tvdbLoginDiagnostics, traktLoginDiagnostics } = await import("../lib/provider-login-diagnostics");
const { listCoverageIssues } = await import("../lib/coverage-issues");
const { ProviderHttpError } = await import("../lib/provider-client");
hook.deregister();

const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"provider-login-diagnostics-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir,{recursive:true,force:true});
  });
}

/** The stored JSON of one Coverage Issue, so key order is compared as well as values. */
function storedIssue(id: string) {
  const row = global.__shelfcheckDatabase!.prepare("SELECT payload FROM shelfcheck_coverage_issues WHERE id=?").get(id) as {payload: string} | undefined;
  return row?.payload;
}

test("a failed TVDB login is one library issue that names Manual Match verification, resolved when TVDB login succeeds", t => {
  temporaryDatabase(t);
  tvdbLoginDiagnostics.raiseFailure(new ProviderHttpError("TVDB", 401));
  tvdbLoginDiagnostics.raiseFailure(new ProviderHttpError("TVDB", 401));
  assert.equal(listCoverageIssues().length, 1);
  assert.equal(storedIssue("provider-authentication:TVDB"), JSON.stringify({
    id: "provider-authentication:TVDB", operation: "provider-authentication", provider: "TVDB", scope: "library", category: "Provider Lookup",
    lookup: {source: [], requested: {provider: "TVDB", kind: "authentication"}, impact: "TVDB catalogue downloads, freshness and Manual Match episodes could not be verified. Available last-good data and saved Manual Matches were retained.", status: 401, failureKind: "http"},
    cause: "401 — TVDB request failed", action: "Check TVDB credentials or permissions, then retry the Plex scan.",
  }));
  tvdbLoginDiagnostics.resolve();
  assert.deepEqual(listCoverageIssues(), []);
});

test("an unrecoverable Trakt login is one library issue, resolved when Trakt answers again", t => {
  temporaryDatabase(t);
  traktLoginDiagnostics.raiseFailure(new ProviderHttpError("Trakt", 401));
  traktLoginDiagnostics.raiseFailure(new ProviderHttpError("Trakt", 401));
  assert.equal(listCoverageIssues().length, 1);
  assert.equal(storedIssue("provider-authentication:Trakt"), JSON.stringify({
    id: "provider-authentication:Trakt", operation: "provider-authentication", provider: "Trakt", scope: "library", category: "Provider Lookup",
    lookup: {source: [], requested: {provider: "Trakt", kind: "authentication"}, impact: "Trakt episode identity checks could not be verified. TMDB fallback checks remain available.", status: 401, failureKind: "http"},
    cause: "401 — Trakt request failed", action: "Check Trakt credentials or permissions, then retry the Plex scan.",
  }));
  traktLoginDiagnostics.resolve();
  assert.deepEqual(listCoverageIssues(), []);
});

test("one provider's login resolving leaves the other's open", t => {
  temporaryDatabase(t);
  tvdbLoginDiagnostics.raiseFailure(new ProviderHttpError("TVDB", 401));
  traktLoginDiagnostics.raiseFailure(new ProviderHttpError("Trakt", 401));
  traktLoginDiagnostics.resolve();
  assert.deepEqual(listCoverageIssues().map(issue => issue.id), ["provider-authentication:TVDB"]);
});
