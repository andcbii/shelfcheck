import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { episodeCheckShowPrefix } from "../lib/coverage-issue-ids";
import { seedStoredCoverageIssues } from "./stored-coverage-issues";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { coverageIssueIdsWithPrefix, listCoverageIssues } = await import("../lib/coverage-issues");
const { reconcileEpisodeCheckIssues } = await import("../lib/episode-check-issues");
const { savedTitleRecovery, withTitleRecovery } = await import("../lib/tvdb-title-recovery");
const { database } = await import("../lib/sqlite");
hook.deregister();

// Coverage Issue IDs read back from storage are adopted as saved: an ID of a kind today's code no
// longer produces still loads, shows and folds, and is never dropped (SHELFCHECK-165).

const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"stored-coverage-issue-ids-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir,{recursive:true,force:true});
  });
}
const issue = (id: string, extra: Record<string, unknown> = {}) => ({id, operation: "legacy", scope: "library", cause: `Cause of ${id}.`, action: "Run a scan.", ...extra});

test("saved issues of unknown kinds still load, show and fold; missing and circular causes still show on their own", t => {
  temporaryDatabase(t);
  seedStoredCoverageIssues(database(),
    issue("legacy-root:1"),
    issue("legacy-dependent:1", {causedBy: ["legacy-root:1"]}),
    issue("legacy-orphan:1", {causedBy: ["legacy-gone:1"]}),
    issue("legacy-loop:a", {causedBy: ["legacy-loop:b"]}),
    issue("legacy-loop:b", {causedBy: ["legacy-loop:a"]}),
  );
  assert.deepEqual(listCoverageIssues().map(({id, impacts}) => ({id, impacts})), [
    {id: "legacy-loop:a", impacts: undefined},
    {id: "legacy-loop:b", impacts: undefined},
    {id: "legacy-orphan:1", impacts: undefined},
    {id: "legacy-root:1", impacts: ["Cause of legacy-dependent:1."]},
  ]);
});

test("a saved title-recovery cause of any kind still loads, and the title-recovery issue folds into it", t => {
  temporaryDatabase(t);
  seedStoredCoverageIssues(database(),
    issue("provider-authentication:TVDB", {provider: "TVDB", operation: "provider-authentication"}),
    issue("legacy-root:1"),
  );
  const state = savedTitleRecovery({"301": {outcome: "request-failed", reason: "401 — TVDB request failed", causedBy: ["provider-authentication:TVDB", "legacy-root:1", 7]}});
  assert.deepEqual(state, {"301": {outcome: "request-failed", reason: "401 — TVDB request failed", causedBy: ["provider-authentication:TVDB", "legacy-root:1"]}});

  const show = {ratingKey: "ratingKey:1", title: "Show"};
  reconcileEpisodeCheckIssues(show, withTitleRecovery(show.ratingKey, [], state, [{source: "TVDB", providerEpisodeId: 301, season: 1, episode: 1}]));
  assert.deepEqual(coverageIssueIdsWithPrefix(episodeCheckShowPrefix(show.ratingKey)), ["episode-check:ratingKey:1:title-recovery:TVDB:301"]);
  const shown = listCoverageIssues();
  assert.deepEqual(shown.map(({id}) => id), ["legacy-root:1", "provider-authentication:TVDB"], "the title-recovery issue folds into both saved causes");
  for (const root of shown) {
    assert.equal(root.impacts?.length, 1, root.id);
    assert.match(root.impacts[0], /^Show: English title recovery could not be checked: 401 — TVDB request failed\./, root.id);
  }
});

test("a saved payload without an ID reads back with exactly its saved keys", t => {
  temporaryDatabase(t);
  database().prepare("INSERT INTO shelfcheck_coverage_issues VALUES(?,?)").run("legacy-no-id:1", JSON.stringify({operation: "legacy", scope: "library", cause: "Cause without an ID.", action: "Run a scan."}));
  const [read] = listCoverageIssues();
  assert.deepEqual(Object.keys(read), ["operation", "scope", "cause", "action"]);
  assert.equal(Object.hasOwn(read, "id"), false);
});

test("a show's stored prefix query returns only that show's IDs, not those of neighbouring shows whose keys share its start", t => {
  temporaryDatabase(t);
  seedStoredCoverageIssues(database(),
    issue("episode-check:ratingKey:1:title-recovery:TVDB:301"),
    issue("episode-check:ratingKey:1:catalogue-record:TVDB:302"),
    issue("episode-check:ratingKey:10:title-recovery:TVDB:401"),
    issue("episode-check:ratingKey:1|tvdb:81189:title-recovery:TVDB:501"),
  );
  assert.deepEqual(coverageIssueIdsWithPrefix(episodeCheckShowPrefix("ratingKey:1")), [
    "episode-check:ratingKey:1:catalogue-record:TVDB:302",
    "episode-check:ratingKey:1:title-recovery:TVDB:301",
  ]);
  assert.deepEqual(coverageIssueIdsWithPrefix(episodeCheckShowPrefix("ratingKey:10")), ["episode-check:ratingKey:10:title-recovery:TVDB:401"]);
  assert.deepEqual(coverageIssueIdsWithPrefix(episodeCheckShowPrefix("ratingKey:1|tvdb:81189")), ["episode-check:ratingKey:1|tvdb:81189:title-recovery:TVDB:501"]);
});
