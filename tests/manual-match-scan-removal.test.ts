import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { CoverageMember } from "../lib/manual-coverage-model";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const store = await import("../lib/manual-coverage");
const { database } = await import("../lib/sqlite");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

// The scan-owned Manual Match member removal, against a real temporary SQLite
// database: one atomic change that a Plex Scan run applies after its report.
const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };
function temporaryStore(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "manual-match-scan-removal-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

/** A Plex Scan run that owns the scan run lock until the test ends. */
function plexScan(t: TestContext) {
  let release!: () => void;
  const run = scanRuns.start("plex", () => new Promise<void>(resolve => { release = resolve; }));
  t.after(async () => { release(); await run.settled; });
  return scanRuns.activeScanRun()!;
}

/** A provider episode; `showId` places it in a provider show (TMDB 10 / TVDB 20 unless given). */
function member(provider: "TMDB" | "TVDB", id: number, showId = provider === "TMDB" ? 10 : 20): CoverageMember {
  return { provider, id, showId, show: `Show ${showId}`, title: `Episode ${id}`, season: 1, episode: id % 100, url: `https://example.test/${provider}/${id}` };
}
const keys = (members: { provider: string; id: number }[]) => members.map(m => `${m.provider}:${m.id}`).sort();
const flag = (m: CoverageMember) => ({ provider: m.provider, id: m.id });
const flagsOf = (id: string) => Object.fromEntries(store.listCoverageMappings().find(m => m.id === id)!.members.map(m => [`${m.provider}:${m.id}`, !!m.reportMissing]));

test("removing one member keeps the rest of the Manual Match with its Report Missing flags and a new revision", (t) => {
  temporaryStore(t);
  const tmdb1 = member("TMDB", 101), tmdb2 = member("TMDB", 102), tvdb = member("TVDB", 201);
  const saved = store.saveCoverageMapping([tmdb1, tmdb2, tvdb]).mapping;
  const flagged = store.saveCoverageMapping(undefined, { id: saved.id, revision: saved.revision }, [flag(tmdb1)]).mapping;
  const revision = store.coverageState().revision;
  const owner = plexScan(t);

  const result = store.removeManualMatchMembers([{ mappingId: saved.id, member: flag(tmdb2), expectedRevision: flagged.revision }], owner);

  assert.deepEqual(result.removed.map(r => ({ mappingId: r.mappingId, key: `${r.member.provider}:${r.member.id}`, matchDeleted: r.matchDeleted })), [{ mappingId: saved.id, key: "TMDB:102", matchDeleted: false }]);
  assert.equal(result.removed[0].member.showId, 10);
  assert.deepEqual(result.deletedMappings, []);
  assert.equal(result.revision, revision + 1);
  assert.equal(store.coverageState().revision, revision + 1);
  assert.equal(store.coverageState().pending, 1);
  const [after] = store.listCoverageMappings();
  assert.equal(after.revision, revision + 1);
  assert.deepEqual(flagsOf(saved.id), { "TMDB:101": true, "TVDB:201": false });
  assert.deepEqual(keys(result.affectedMembers), ["TMDB:101", "TMDB:102", "TVDB:201"]);
});

/** Everything a refused or failed removal must leave untouched. */
function snapshot() {
  const db = database();
  return {
    mappings: store.listCoverageMappings(), state: store.coverageState(), carried: store.carriedMembers(),
    rows: db.prepare("SELECT provider,episode_id,mapping_id,report_missing FROM shelfcheck_coverage_members ORDER BY provider,episode_id").all(),
  };
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("removing the last member of a side deletes the whole Manual Match and carries both of its sides", (t) => {
  temporaryStore(t);
  const tmdb = member("TMDB", 101), tvdb = member("TVDB", 201, 21);
  const doomed = store.saveCoverageMapping([tmdb, tvdb]).mapping;
  const kept = store.saveCoverageMapping([member("TMDB", 111), member("TVDB", 211)]).mapping;
  store.completeCoverageComparison(store.coverageState().revision, store.carriedMembers());
  const revision = store.coverageState().revision;
  const owner = plexScan(t);

  const result = store.removeManualMatchMembers([{ mappingId: doomed.id, member: flag(tvdb), expectedRevision: doomed.revision }], owner);

  assert.deepEqual(result.deletedMappings, [doomed.id]);
  assert.deepEqual(result.removed.map(r => [r.member.provider, r.member.id, r.member.showId, r.matchDeleted]), [["TVDB", 201, 21, true]]);
  assert.deepEqual(store.listCoverageMappings().map(m => m.id), [kept.id]);
  assert.equal(store.listCoverageMappings()[0].revision, kept.revision, "an unchanged Manual Match keeps its revision");
  assert.deepEqual(keys(result.affectedMembers), ["TMDB:101", "TVDB:201"]);
  assert.deepEqual(store.carriedMembers().map(c => [`${c.member.provider}:${c.member.id}:${c.member.showId}`, c.revision]).sort(), [["TMDB:101:10", revision + 1], ["TVDB:201:21", revision + 1]]);
  assert.deepEqual(database().prepare("SELECT provider,episode_id FROM shelfcheck_coverage_members WHERE mapping_id=?").all(doomed.id), []);
});

test("a many-to-many Manual Match becomes one-to-many, and a one-sided flag selection is kept, not refused", (t) => {
  temporaryStore(t);
  const t1 = member("TMDB", 101), t2 = member("TMDB", 102), v1 = member("TVDB", 201), v2 = member("TVDB", 202), v3 = member("TVDB", 203);
  const first = store.saveCoverageMapping([t1, t2, v1, v2]).mapping;
  const flagged = store.saveCoverageMapping(undefined, { id: first.id, revision: first.revision }, [flag(t1), flag(v1)]).mapping;
  const second = store.saveCoverageMapping([member("TMDB", 111), member("TMDB", 112), v3, member("TVDB", 204), member("TVDB", 205)]).mapping;
  const withFlags = store.saveCoverageMapping(undefined, { id: second.id, revision: second.revision }, [flag(member("TMDB", 111)), flag(v3)]).mapping;
  const owner = plexScan(t);

  const result = store.removeManualMatchMembers([
    { mappingId: first.id, member: flag(v1), expectedRevision: flagged.revision },
    { mappingId: withFlags.id, member: flag(v3), expectedRevision: withFlags.revision },
  ], owner);

  assert.deepEqual(result.deletedMappings, []);
  assert.deepEqual(flagsOf(first.id), { "TMDB:101": true, "TMDB:102": false, "TVDB:202": false });
  assert.deepEqual(flagsOf(second.id), { "TMDB:111": true, "TMDB:112": false, "TVDB:204": false, "TVDB:205": false }, "the both-sides rule is not applied");
  assert.deepEqual([...new Set(store.listCoverageMappings().map(m => m.revision))], [store.coverageState().revision], "every changed Manual Match takes the one new revision");
  assert.equal(result.revision, store.coverageState().revision);
});

test("duplicate proposals remove each member once", (t) => {
  temporaryStore(t);
  const tvdb1 = member("TVDB", 201);
  const saved = store.saveCoverageMapping([member("TMDB", 101), tvdb1, member("TVDB", 202)]).mapping;
  const revision = store.coverageState().revision;
  const owner = plexScan(t);
  const proposal = { mappingId: saved.id, member: flag(tvdb1), expectedRevision: saved.revision };
  const result = store.removeManualMatchMembers([proposal, { ...proposal }], owner);
  assert.deepEqual(result.removed.map(r => `${r.member.provider}:${r.member.id}`), ["TVDB:201"]);
  assert.equal(store.coverageState().revision, revision + 1);
});

test("no proposals, or members already gone, change nothing", (t) => {
  temporaryStore(t);
  const saved = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201)]).mapping;
  store.completeCoverageComparison(store.coverageState().revision, store.carriedMembers());
  const owner = plexScan(t);
  const before = snapshot();
  const none = { removed: [], deletedMappings: [], affectedMembers: [] };
  assert.deepEqual(store.removeManualMatchMembers([], owner), none);
  assert.deepEqual(store.removeManualMatchMembers([{ mappingId: saved.id, member: { provider: "TVDB", id: 999 }, expectedRevision: saved.revision }], owner), none);
  assert.deepEqual(snapshot(), before);
});

test("a stale revision or a deleted Manual Match refuses the whole removal", (t) => {
  temporaryStore(t);
  const a = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201), member("TVDB", 202)]).mapping;
  const b = store.saveCoverageMapping([member("TMDB", 111), member("TVDB", 211), member("TVDB", 212)]).mapping;
  const owner = plexScan(t);
  const before = snapshot();
  const fresh = { mappingId: a.id, member: flag(member("TVDB", 201)), expectedRevision: a.revision };
  for (const stale of [
    { mappingId: b.id, member: flag(member("TVDB", 211)), expectedRevision: b.revision - 1 },
    { mappingId: "gone", member: flag(member("TVDB", 299)), expectedRevision: 1 },
  ]) {
    assert.throws(() => store.removeManualMatchMembers([fresh, stale], owner), code("stale-revision"));
    assert.deepEqual(snapshot(), before);
  }
});

test("a failure inside the removal rolls back every Manual Match it changed", (t) => {
  temporaryStore(t);
  const a = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201), member("TVDB", 202)]).mapping;
  const b = store.saveCoverageMapping([member("TMDB", 111), member("TVDB", 211)]).mapping;
  const owner = plexScan(t);
  database().exec("CREATE TRIGGER fail_delete BEFORE DELETE ON shelfcheck_coverage_mappings BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const before = snapshot();
  assert.throws(() => store.removeManualMatchMembers([
    { mappingId: a.id, member: flag(member("TVDB", 201)), expectedRevision: a.revision },
    { mappingId: b.id, member: flag(member("TVDB", 211)), expectedRevision: b.revision },
  ], owner), /injected/);
  assert.deepEqual(snapshot(), before);
});

test("only the Plex Scan run holding the lock can remove members; the public guard is unchanged", (t) => {
  temporaryStore(t);
  const saved = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201), member("TVDB", 202)]).mapping;
  const proposal = [{ mappingId: saved.id, member: flag(member("TVDB", 201)), expectedRevision: saved.revision }];
  const before = snapshot();
  assert.throws(() => store.removeManualMatchMembers(proposal, { kind: "plex", runId: "none", startedAt: "" }), code("not-scan-owner"), "no scan run");
  const owner = plexScan(t);
  assert.throws(() => store.removeManualMatchMembers(proposal, { ...owner, runId: "another" }), code("not-scan-owner"), "another run");
  assert.throws(() => store.saveCoverageMapping(undefined, { id: saved.id, revision: saved.revision }, []), code("scan-active"));
  assert.deepEqual(snapshot(), before);
});

test("after a removal, a public edit opened at the old revision is refused as stale", async (t) => {
  temporaryStore(t);
  const saved = store.saveCoverageMapping([member("TMDB", 101), member("TVDB", 201), member("TVDB", 202)]).mapping;
  let release!: () => void;
  const run = scanRuns.start("plex", () => new Promise<void>(resolve => { release = resolve; }));
  store.removeManualMatchMembers([{ mappingId: saved.id, member: flag(member("TVDB", 201)), expectedRevision: saved.revision }], scanRuns.activeScanRun()!);
  release();
  await run.settled;
  assert.throws(() => store.saveCoverageMapping(undefined, { id: saved.id, revision: saved.revision }, []), code("stale-revision"));
  const [current] = store.listCoverageMappings();
  assert.doesNotThrow(() => store.saveCoverageMapping(undefined, { id: saved.id, revision: current.revision }, []));
});
