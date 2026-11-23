import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { CoverageMember } from "../lib/manual-coverage-model";
import type { SavedPlexComparison } from "../lib/plex-catalogues";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const store = await import("../lib/manual-coverage");
const issues = await import("../lib/coverage-issues");
const { scanRuns } = await import("../lib/scan-run");
const scan = await import("../lib/plex-scan");
const plexInputs = await import("../lib/plex-catalogues");
hook.deregister();

// The Manual Match store's save and delete, against a real temporary SQLite
// database: what each returns as the members a change affects, and what a
// rejected change leaves behind.
const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };
function temporaryStore(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "manual-match-store-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

/** A provider episode; `showId` places it in a provider show (TMDB 10 / TVDB 20 unless given). */
function member(provider: "TMDB" | "TVDB", id: number, showId = provider === "TMDB" ? 10 : 20): CoverageMember {
  return { provider, id, showId, show: `Show ${showId}`, title: `Episode ${id}`, season: 1, episode: id % 100, url: `https://example.test/${provider}/${id}` };
}
const keys = (members: { provider: string; id: number }[]) => members.map(m => `${m.provider}:${m.id}`).sort();
const flag = (m: CoverageMember) => ({ provider: m.provider, id: m.id });

/** Everything a rejected change must leave untouched. */
function snapshot() {
  return { mappings: store.listCoverageMappings(), state: store.coverageState(), issues: issues.listCoverageIssues() };
}

test("saving a new Manual Match returns it with its members as the affected members", (t) => {
  temporaryStore(t);
  const saved = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201)]);
  assert.deepEqual(keys(saved.mapping.members), ["TMDB:101", "TVDB:201"]);
  assert.deepEqual(keys(saved.affectedMembers), ["TMDB:101", "TVDB:201"]);
  assert.deepEqual(store.listCoverageMappings().map(m => m.id), [saved.mapping.id]);
});

test("replacing members returns old and new members, keeping a former show the members moved away from", (t) => {
  temporaryStore(t);
  const first = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201)]).mapping;
  const replaced = store.saveCoverageMapping([member("TMDB", 111, 11), member("TVDB", 211, 21)], { id: first.id, revision: first.revision });
  assert.deepEqual(keys(replaced.mapping.members), ["TMDB:111", "TVDB:211"]);
  assert.deepEqual(keys(replaced.affectedMembers), ["TMDB:101", "TMDB:111", "TVDB:201", "TVDB:211"]);
  assert.deepEqual([...new Set(replaced.affectedMembers.map(m => `${m.provider}:${m.showId}`))].sort(), ["TMDB:10", "TMDB:11", "TVDB:20", "TVDB:21"]);
});

/** A saved Plex comparison for one TMDB/TVDB show, with no refresh obligation yet. */
function savedComparison(tmdbId: number, tvdbId: number) {
  return { tmdbId, tvdbId, tmdbAliases: [], tvdbAliases: [], relationships: {}, complete: false, group: { records: [] }, details: [], localMetadata: [] } as unknown as SavedPlexComparison;
}

test("an edit that keeps episode IDs but moves them to another show rechecks both the former and the new show", async (t) => {
  temporaryStore(t);
  const first = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201)]).mapping;
  const moved = store.saveCoverageMapping([member("TMDB", 101, 11), member("TVDB", 201, 21)], { id: first.id, revision: first.revision });
  assert.deepEqual(moved.affectedMembers.map(m => `${m.provider}:${m.id}:${m.showId}`).sort(), ["TMDB:101:10", "TMDB:101:11", "TVDB:201:20", "TVDB:201:21"]);

  // No saved catalogue holds these IDs, so only the members' showIds tie them to a comparison.
  plexInputs.savePlexComparison("former", savedComparison(10, 20));
  plexInputs.savePlexComparison("new", savedComparison(11, 21));
  await scan.requestCoverageRecheck({ members: moved.affectedMembers });
  const { comparisons } = plexInputs.readPlexInputs();
  assert.deepEqual(comparisons.former.refresh, { tmdb: true, tvdb: true });
  assert.deepEqual(comparisons.new.refresh, { tmdb: true, tvdb: true });
});

test("a flag-only edit returns every member as affected and the saved flags in its Manual Match", (t) => {
  temporaryStore(t);
  const tmdb = member("TMDB", 101), tvdb = member("TVDB", 201);
  const first = store.saveCoverageMapping([tmdb, tvdb]).mapping;
  const flagged = store.saveCoverageMapping(undefined, { id: first.id, revision: first.revision }, [flag(tmdb), flag(tvdb)]);
  assert.deepEqual(keys(flagged.affectedMembers), ["TMDB:101", "TVDB:201"]);
  assert.deepEqual(flagged.mapping.members.map(m => m.reportMissing), [true, true]);
});

test("stale, conflicting, one-sided, invalid and scan-time saves roll back with no change", (t) => {
  temporaryStore(t);
  const tmdb = member("TMDB", 101), tmdb2 = member("TMDB", 102), tvdb = member("TVDB", 201), tvdb2 = member("TVDB", 202);
  const first = store.saveCoverageMapping([tmdb, tmdb2, tvdb, tvdb2]).mapping;
  issues.setCoverageIssue({ id: "mapping-health:x", operation: "comparison", scope: "library", cause: "c", action: "a", mappingId: first.id });
  const before = snapshot();
  const rejected: [string, () => unknown][] = [
    ["stale-revision", () => store.saveCoverageMapping([member("TMDB", 103), tvdb], { id: first.id, revision: first.revision - 1 })],
    ["membership-conflict", () => store.saveCoverageMapping([tmdb, member("TVDB", 299)])],
    ["report-missing-one-sided", () => store.saveCoverageMapping(undefined, { id: first.id, revision: first.revision }, [flag(tvdb)])],
    ["validation", () => store.saveCoverageMapping([member("TMDB", 150)])],
    ["not-found", () => store.saveCoverageMapping(undefined, { id: "gone", revision: 1 }, [])],
  ];
  for (const [code, save] of rejected) {
    assert.throws(save, (error: unknown) => (error as { code?: string }).code === code, code);
    assert.deepEqual(snapshot(), before, code);
  }
  let release!: () => void;
  const run = scanRuns.start("plex", () => new Promise<void>(resolve => { release = resolve; }));
  t.after(async () => { release(); await run.settled; });
  assert.throws(() => store.saveCoverageMapping([member("TMDB", 104), member("TVDB", 203)]), (error: unknown) => (error as { code?: string }).code === "scan-active");
  assert.throws(() => store.deleteCoverageMappings([first.id]), (error: unknown) => (error as { code?: string }).code === "scan-active");
  assert.deepEqual(snapshot(), before);
});

test("a batch delete returns deleted and missing IDs and the members of the Manual Matches actually deleted", (t) => {
  temporaryStore(t);
  const a = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201)]).mapping;
  const b = store.saveCoverageMapping([member("TMDB", 111, 11), member("TVDB", 211, 21)]).mapping;
  const kept = store.saveCoverageMapping([member("TMDB", 121), member("TVDB", 221)]).mapping;
  const revision = store.coverageState().revision;
  const result = store.deleteCoverageMappings([a.id, "missing", b.id, a.id, "missing"]);
  assert.deepEqual(result.deleted, [a.id, b.id]);
  assert.deepEqual(result.missing, ["missing"]);
  assert.deepEqual(keys(result.affectedMembers), ["TMDB:101", "TMDB:111", "TVDB:201", "TVDB:211"]);
  assert.equal(store.coverageState().revision, revision + 1);
  assert.deepEqual(store.listCoverageMappings().map(m => m.id), [kept.id]);
});

test("a batch delete of only missing IDs changes no revision and affects no members", (t) => {
  temporaryStore(t);
  store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201)]);
  const before = snapshot();
  const result = store.deleteCoverageMappings(["gone", "also-gone", "gone"]);
  assert.deepEqual(result, { deleted: [], missing: ["gone", "also-gone"], affectedMembers: [] });
  assert.deepEqual(snapshot(), before);
});

test("a single delete returns the deleted Manual Match's members and answers not found for a missing one", (t) => {
  temporaryStore(t);
  const a = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201)]).mapping;
  const result = store.deleteCoverageMapping(a.id);
  assert.deepEqual(result.deleted, [a.id]);
  assert.deepEqual(keys(result.affectedMembers), ["TMDB:101", "TVDB:201"]);
  const before = snapshot();
  assert.throws(() => store.deleteCoverageMapping(a.id), (error: unknown) => (error as { code?: string; status?: number }).code === "not-found" && (error as { status?: number }).status === 404);
  assert.deepEqual(snapshot(), before);
});
