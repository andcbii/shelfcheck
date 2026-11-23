import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { flag, harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const changes = await import("../lib/manual-match-changes");
const store = await import("../lib/manual-coverage");
const { plexSavedState } = await import("../lib/plex-scan");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

// The Manual Match change module's save and delete commands, against the real
// SQLite store and the real offline (cached) recheck queue, with mocked Plex and
// provider HTTP. Target is TMDB 10 / TVDB 20; Other is TMDB 11 / TVDB 21, whose
// episodes Plex owns.
const tmdbA: Episode = { provider: "TMDB", id: 101, season: 1, episode: 1, name: "A" };
const tvdbA: Episode = { provider: "TVDB", id: 201, season: 1, episode: 1, name: "A" };
const tmdbB: Episode = { provider: "TMDB", id: 102, season: 1, episode: 2, name: "B" };
const tvdbB: Episode = { provider: "TVDB", id: 202, season: 1, episode: 2, name: "B" };
const otherTmdb: Episode = { provider: "TMDB", id: 111, season: 3, episode: 5, name: "Other", show: "other" };
const otherTvdb: Episode = { provider: "TVDB", id: 211, season: 3, episode: 5, name: "Other", show: "other" };
const catalogue = [tmdbA, tvdbA, tmdbB, tvdbB, otherTmdb, otherTvdb];
const ALL_MISSING_IN_TARGET = { "TMDB:101": "missing", "TVDB:201": "missing", "TMDB:102": "missing", "TVDB:202": "missing" };

const url = (member: Episode) => member.provider === "TMDB" ? `tmdb:${member.id} show:${member.show ? 11 : 10} season:${member.season} episode:${member.episode}` : `tvdb:${member.id}`;
const database = () => (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!;

/** A harness after one full Plex scan, so cached rechecks have saved inputs and a report. */
async function setup(t: test.TestContext) {
  const h = await harness(t, catalogue, [otherTmdb, otherTvdb]);
  await h.rerun();
  /** A preview token for these members, resolved as the Manual Match page does. */
  const preview = async (members: Episode[]) => {
    const resolved = await h.post({ action: "resolve", urls: members.map(url) });
    assert.equal(resolved.status, 200, await resolved.clone().text());
    return (await resolved.json()).preview as string;
  };
  /** A reviewed save of these members: new, or an edit of `edit`. */
  const reviewedSave = async (members: Episode[], extra: { edit?: { id: string; revision: number }; reportMissing?: unknown } = {}) =>
    changes.saveManualMatch({ preview: await preview(members), ...(extra.edit ? { id: extra.edit.id, revision: extra.edit.revision } : {}), ...(extra.reportMissing ? { reportMissing: extra.reportMissing } : {}) });
  const results = async () => { const status = await h.status(); return { target: h.missing(status), other: h.missing(status, "other") }; };
  /** Provider and Plex requests made while `run` runs. */
  const requestsDuring = async (run: () => Promise<unknown>) => {
    const before = h.requests.length;
    await run();
    return h.requests.slice(before);
  };
  /**
   * Marks the current coverage revision pending without a change, as a commit
   * does. Any cached recheck started afterwards clears it, so a pending state
   * still set later proves no recheck ran.
   */
  const markPending = () => {
    store.beginCoverageRecheck(store.coverageState().revision);
    return { mappings: store.listCoverageMappings(), state: store.coverageState(), report: JSON.stringify(plexSavedState.report.read()) };
  };
  const unchangedSince = (before: ReturnType<typeof markPending>, label: string) => {
    assert.deepEqual(store.listCoverageMappings(), before.mappings, label);
    assert.deepEqual(store.coverageState(), before.state, label);
    assert.equal(before.state.pending, 1, label);
    assert.equal(JSON.stringify(plexSavedState.report.read()), before.report, label);
  };
  return { ...h, preview, reviewedSave, results, requestsDuring, markPending, unchangedSince };
}

/** Holds the Plex Scan run lock until the returned release is called. */
function holdScan() {
  let release!: () => void;
  const run = scanRuns.start("plex", () => new Promise<void>(resolve => { release = resolve; }));
  return async () => { release(); await run.settled; };
}

const rejection = async (promise: Promise<unknown>) => promise.then(() => assert.fail("expected the change to be refused"), (error: unknown) => {
  assert.ok(error instanceof store.CoverageError, String(error));
  return error.code;
});

test("a reviewed save revalidates only the reviewed episodes and rechecks its show from saved inputs", async (t) => {
  const h = await setup(t);
  assert.deepEqual((await h.results()).target, ALL_MISSING_IN_TARGET);
  const previewToken = await h.preview([tmdbA, otherTvdb]);
  let saved!: Awaited<ReturnType<typeof changes.saveManualMatch>>;
  const requests = await h.requestsDuring(async () => { saved = await changes.saveManualMatch({ preview: previewToken }); });
  assert.equal(saved.created, true);
  assert.deepEqual(saved.mapping.members.map(m => `${m.provider}:${m.id}`), ["TMDB:101", "TVDB:211"]);
  // Only the reviewed TMDB and TVDB episodes (and their shows) are looked up again; the recheck asks nothing.
  assert.deepEqual([...new Set(requests)].sort(), ["/3/tv/10", "/3/tv/10/season/1/episode/1", "/v4/episodes/211/extended", "/v4/login", "/v4/series/21"]);
  assert.deepEqual((await h.results()).target, { "TVDB:201": "missing", "TMDB:102": "missing", "TVDB:202": "missing" });
  assert.equal(store.coverageState().pending, 0);
});

test("replacing members rechecks the shows of both the former and the new members", async (t) => {
  const h = await setup(t);
  const first = (await h.reviewedSave([tmdbA, otherTvdb])).mapping;
  const edited = await h.reviewedSave([otherTmdb, otherTvdb], { edit: { id: first.id, revision: first.revision }, reportMissing: [flag(otherTmdb), flag(otherTvdb)] });
  assert.equal(edited.created, false);
  const results = await h.results();
  // Target's former member is missing again; Other's new members are reported missing.
  assert.deepEqual(results.target, ALL_MISSING_IN_TARGET);
  assert.deepEqual(results.other, { "TMDB:111": "reported-missing", "TVDB:211": "reported-missing" });
});

test("a flag-only edit makes no provider request, keeps saved health and rechecks every member's show", async (t) => {
  const h = await setup(t);
  const first = (await h.reviewedSave([tmdbA, otherTvdb])).mapping;
  store.updateCoverageHealth(first, "needs-review", store.MISSING_MEMBER_MESSAGE);
  const current = store.listCoverageMappings()[0];
  let saved!: Awaited<ReturnType<typeof changes.saveManualMatch>>;
  const requests = await h.requestsDuring(async () => { saved = await changes.saveManualMatch({ id: current.id, revision: current.revision, reportMissing: [flag(tmdbA), flag(otherTvdb)] }); });
  assert.deepEqual(requests, []);
  assert.equal(saved.created, false);
  assert.equal(saved.mapping.health, "needs-review");
  assert.equal(store.listCoverageMappings()[0].health, "needs-review");
  const results = await h.results();
  assert.equal(results.target["TMDB:101"], "reported-missing");
  assert.deepEqual(results.other, { "TVDB:211": "reported-missing" });
  assert.equal(store.coverageState().pending, 0);
});

test("during a Plex Scan run, preview resolution works and a reviewed save is refused before any provider request", async (t) => {
  const h = await setup(t);
  const first = (await h.reviewedSave([tmdbA, otherTvdb])).mapping;
  const release = holdScan();
  t.after(release);
  const previewToken = await h.preview([tmdbB, tvdbB]);
  const before = h.markPending();
  let code: unknown;
  const requests = await h.requestsDuring(async () => { code = await rejection(changes.saveManualMatch({ preview: previewToken })); });
  assert.equal(code, "scan-active");
  assert.deepEqual(requests, []);
  h.unchangedSince(before, "reviewed save");
  assert.equal(await rejection(changes.saveManualMatch({ id: first.id, revision: first.revision, reportMissing: [] })), "scan-active");
  h.unchangedSince(before, "flag-only edit");
  assert.equal(await rejection(changes.deleteManualMatches({ ids: [first.id] })), "scan-active");
  h.unchangedSince(before, "delete");
});

test("a Plex Scan run that starts during provider revalidation makes the save refuse with no change", async (t) => {
  const h = await setup(t);
  const previewToken = await h.preview([tmdbA, otherTvdb]);
  let reached!: () => void, answer!: () => void;
  const requested = new Promise<void>(resolve => { reached = resolve; });
  h.state.hold.set("/v4/episodes/211/extended", new Promise<void>(resolve => { answer = resolve; }));
  h.state.onRequest = pathname => { if (pathname === "/v4/episodes/211/extended") reached(); };
  const before = h.markPending();
  const saving = rejection(changes.saveManualMatch({ preview: previewToken }));
  await requested;
  const release = holdScan();
  t.after(release);
  answer();
  assert.equal(await saving, "scan-active");
  h.unchangedSince(before, "scan started during revalidation");
});

test("stale, conflicting, one-sided and provider-rejected saves change nothing and start no cached recheck", async (t) => {
  const h = await setup(t);
  const first = (await h.reviewedSave([tmdbA, tmdbB, tvdbA, tvdbB])).mapping;
  const stalePreview = await h.preview([tmdbA, tvdbA]);
  const conflictPreview = await h.preview([tmdbA, otherTvdb]);
  const oneSidedPreview = await h.preview([otherTmdb, tmdbB, otherTvdb, tvdbB]);
  const failedPreview = await h.preview([otherTmdb, otherTvdb]);
  const before = h.markPending();
  const cases: [string, () => Promise<unknown>][] = [
    ["stale-revision", () => changes.saveManualMatch({ preview: stalePreview, id: first.id, revision: first.revision - 1 })],
    ["stale-revision", () => changes.saveManualMatch({ id: first.id, revision: first.revision - 1, reportMissing: [] })],
    ["membership-conflict", () => changes.saveManualMatch({ preview: conflictPreview })],
    ["report-missing-one-sided", () => changes.saveManualMatch({ id: first.id, revision: first.revision, reportMissing: [flag(tmdbA)] })],
    ["report-missing-one-sided", () => changes.saveManualMatch({ preview: oneSidedPreview, reportMissing: [flag(otherTmdb)] })],
    ["provider-unavailable", () => { h.state.statuses.set("/3/tv/11/season/3/episode/5", 404); return changes.saveManualMatch({ preview: failedPreview }); }],
    ["validation", () => changes.saveManualMatch({ preview: "expired" })],
    ["not-found", () => changes.saveManualMatch({ id: "gone", revision: 1, reportMissing: [] })],
  ];
  for (const [code, run] of cases) {
    assert.equal(await rejection(run()), code);
    h.unchangedSince(before, code);
  }
});

test("deletes recheck the shows of the Manual Matches actually deleted; a delete that removes nothing starts no recheck", async (t) => {
  const h = await setup(t);
  const first = (await h.reviewedSave([tmdbA, otherTvdb])).mapping;
  const second = (await h.reviewedSave([otherTmdb, tvdbB])).mapping;
  assert.deepEqual((await h.results()).target, { "TVDB:201": "missing", "TMDB:102": "missing" });

  let before = h.markPending();
  assert.equal(await rejection(changes.deleteManualMatches({ id: "gone" })), "not-found");
  h.unchangedSince(before, "single delete of a missing ID");
  assert.deepEqual(await changes.deleteManualMatches({ ids: ["gone", "also-gone", "gone"] }), { deleted: [], missing: ["gone", "also-gone"] });
  h.unchangedSince(before, "batch delete with nothing deleted");

  assert.deepEqual(await changes.deleteManualMatches({ ids: [first.id, "gone", first.id] }), { deleted: [first.id], missing: ["gone"] });
  assert.deepEqual((await h.results()).target, { "TMDB:101": "missing", "TVDB:201": "missing", "TMDB:102": "missing" });
  assert.equal(store.coverageState().pending, 0);

  before = h.markPending();
  assert.deepEqual(await changes.deleteManualMatches({ id: second.id }), { deleted: [second.id], missing: [] });
  assert.deepEqual((await h.results()).target, ALL_MISSING_IN_TARGET);
  assert.equal(store.coverageState().pending, 0);
  assert.ok(store.coverageState().revision > before.state.revision);
});

test("overlapping changes recheck both sets of affected shows and never clear a newer pending revision", async (t) => {
  const h = await setup(t);
  const inTarget = (await h.reviewedSave([tmdbA, tvdbA])).mapping;
  const inOther = (await h.reviewedSave([otherTmdb, otherTvdb])).mapping;
  const write = plexSavedState.report.write.bind(plexSavedState.report);
  const pendingAtWrite: { revision: number; pending: number }[] = [];
  let second: Promise<unknown> | undefined;
  t.mock.method(plexSavedState.report, "write", (report: Parameters<typeof write>[0]) => {
    const { revision, pending } = store.coverageState();
    pendingAtWrite.push({ revision, pending });
    write(report);
    // The second change commits while the first change's recheck is publishing.
    second ??= changes.saveManualMatch({ id: inOther.id, revision: inOther.revision, reportMissing: [flag(otherTmdb), flag(otherTvdb)] });
  });
  await changes.saveManualMatch({ id: inTarget.id, revision: inTarget.revision, reportMissing: [flag(tmdbA), flag(tvdbA)] });
  // The first recheck completed, but the newer revision stays pending until its own recheck.
  assert.equal(store.coverageState().pending, 1);
  await second;
  assert.equal(pendingAtWrite.length, 2);
  assert.deepEqual(pendingAtWrite[1], { revision: pendingAtWrite[0].revision + 1, pending: 1 });
  const results = await h.results();
  assert.equal(results.target["TMDB:101"], "reported-missing");
  assert.equal(results.target["TVDB:201"], "reported-missing");
  assert.deepEqual(results.other, { "TMDB:111": "reported-missing", "TVDB:211": "reported-missing" });
  assert.equal(store.coverageState().pending, 0);
});

test("missing saved inventory or comparison inputs keep last results with a pending Coverage Issue and no provider request", async (t) => {
  const h = await setup(t);
  const inTarget = (await h.reviewedSave([tmdbA, tvdbA])).mapping;
  const last = await h.results();
  const comparison = database().prepare("SELECT payload FROM shelfcheck_plex_generated_inputs WHERE cache_key='comparison:ratingKey:target'").get() as { payload: string };
  database().prepare("UPDATE shelfcheck_plex_generated_inputs SET payload=? WHERE cache_key='comparison:ratingKey:target'").run(JSON.stringify({ ...JSON.parse(comparison.payload), complete: false }));
  let requests = await h.requestsDuring(() => changes.saveManualMatch({ id: inTarget.id, revision: inTarget.revision, reportMissing: [flag(tmdbA), flag(tvdbA)] }));
  assert.deepEqual(requests, []);
  assert.deepEqual(await h.results(), last);
  assert.deepEqual(store.coverageState().issues.map(issue => issue.id), ["comparison-inputs:ratingKey:target"]);

  database().prepare("DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key='inventory'").run();
  const current = store.listCoverageMappings()[0];
  requests = await h.requestsDuring(() => changes.saveManualMatch({ id: current.id, revision: current.revision, reportMissing: [] }));
  assert.deepEqual(requests, []);
  assert.deepEqual(await h.results(), last);
  assert.equal(store.coverageState().pending, 1);
  assert.ok(store.coverageState().issues.some(issue => issue.id === "comparison-inputs:ratingKey:target" && /inventory/.test(issue.cause)));
});
