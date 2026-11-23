import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { api, harness as workflow, key, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { plexSavedState, requestCoverageRecheck } = await import("../lib/plex-scan");
const { deleteCoverageMapping } = await import("../lib/manual-coverage");
hook.deregister();

// The Manual Match change sequence through the routes: save, edit, flag-only
// edit, delete and Ignore, one of them with a failed cached recheck, ending with
// Plex results that match the saved Manual Matches.
//
// Two Plex shows: "Target" (TMDB 10 / TVDB 20) and "Other" (TMDB 11 / TVDB 21).
// Target owns a combined TMDB episode that is the same content as three TVDB
// split episodes catalogued under Other, and a TMDB episode that TVDB numbers
// differently inside Target. Other owns nothing.
const whole: Episode = { provider: "TMDB", id: 100, season: 1, episode: 1, name: "Whole" };
const a: Episode = { provider: "TVDB", id: 200, season: 2, episode: 1, name: "Part A", show: "other" };
const b: Episode = { provider: "TVDB", id: 201, season: 2, episode: 2, name: "Part B", show: "other" };
const c: Episode = { provider: "TVDB", id: 202, season: 2, episode: 3, name: "Part C", show: "other" };
const kept: Episode = { provider: "TMDB", id: 101, season: 1, episode: 2, name: "Kept" };
const keptTvdb: Episode = { provider: "TVDB", id: 203, season: 2, episode: 4, name: "Kept (TVDB)" };
const harness = (t: test.TestContext) => workflow(t, [whole, a, b, c, kept, keptTvdb], [whole, kept]);
type Harness = Awaited<ReturnType<typeof harness>>;

type Coverage = { revision: number; pending: number; issues: { id: string }[] };
type Status = Awaited<ReturnType<Harness["status"]>> & { coverage: Coverage };
const pendingIn = (coverage: Coverage) => coverage.pending === 1 && coverage.issues.some(issue => issue.id === "comparison-pending");
const manualMatchReport = async () => (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json() as Promise<Coverage>;
/** Both shows' Plex missing results, as the Plex page shows them. */
const results = (h: Harness, state: Status) => ({ target: h.missing(state), other: h.missing(state, "other") });
const remove = (id: string) => api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${encodeURIComponent(id)}`, { method: "DELETE" }));

/** Makes the next cached recheck reject as it starts, before it writes any refresh obligation, once. */
function failNextRecheck(t: test.TestContext) {
  const read = plexSavedState.report.read.bind(plexSavedState.report);
  const fault = { armed: true };
  t.mock.method(plexSavedState.report, "read", () => {
    if (!fault.armed) return read();
    fault.armed = false;
    throw new Error("Injected cached recheck failure.");
  });
  return fault;
}

test("save, edit, flag-only edit, delete and Ignore through the routes, with one failed cached recheck, end with Plex results that match the saved Manual Matches", async t => {
  const h = await harness(t);
  let state = await h.rerun() as Status;
  assert.deepEqual(results(h, state), {
    target: { [key(keptTvdb)]: "missing" },
    other: { [key(a)]: "missing", [key(b)]: "missing", [key(c)]: "missing" },
  }, "Without Manual Matches, TVDB's numbering leaves episodes missing in both shows");

  // Save: a cross-show Manual Match covers Other's parts with Target's owned combined episode.
  const created = await h.save([whole, a, b, c]);
  assert.equal(created.status, 201);
  const crossShow = (await created.json()).mapping;
  state = await h.status() as Status;
  assert.deepEqual(results(h, state), { target: { [key(keptTvdb)]: "missing" }, other: {} }, "The new Manual Match's effect reaches the other show at once");
  assert.equal(state.coverage.pending, 0);

  const inTarget = await h.save([kept, keptTvdb]);
  assert.equal(inTarget.status, 201);
  const oneToOne = (await inTarget.json()).mapping;
  state = await h.status() as Status;
  assert.deepEqual(results(h, state), { target: {}, other: {} });

  // Edit, with its cached recheck failing: the edit is saved and reported as saved,
  // the comparison is pending and the last results stay.
  const last = results(h, state);
  const fault = failNextRecheck(t);
  const resolved = await h.post({ action: "resolve", id: crossShow.id, urls: [`tmdb:${whole.id} show:10 season:${whole.season} episode:${whole.episode}`, `tvdb:${a.id}`, `tvdb:${b.id}`] });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const edited = await h.post({ action: "save", id: crossShow.id, revision: crossShow.revision, preview: (await resolved.json()).preview });
  assert.equal(fault.armed, false, "The cached recheck failed");
  assert.equal(edited.status, 200, await edited.clone().text());
  const editBody = await edited.json();
  assert.deepEqual(editBody.mapping.members.map(key), [whole, a, b].map(key), "The edit is saved");
  assert.ok(pendingIn(editBody), "The response shows the comparison pending");
  state = await h.status() as Status;
  assert.ok(pendingIn(state.coverage), "The Plex state shows the comparison pending notice");
  assert.ok(pendingIn(await manualMatchReport()), "The Manual Match report shows it too");
  assert.deepEqual(results(h, state), last, "The last results stay: Part C is not yet shown missing again");

  // Flag-only edit of the same Manual Match: its later successful cached recheck
  // rechecks both shows, withdrawing the old member's effect and applying the new flag.
  await h.setFlags(crossShow.id, [a]);
  state = await h.status() as Status;
  assert.deepEqual(results(h, state), {
    target: { [key(whole)]: `incomplete because ${key(a)}` },
    other: { [key(a)]: "reported-missing", [key(c)]: "missing" },
  }, "The removed member is missing again in Other, and the flag reaches Target's combined episode");
  assert.equal(state.coverage.pending, 0, "The successful recheck completes the comparison");
  assert.ok(!(await manualMatchReport()).issues.some(issue => issue.id === "comparison-pending"));

  // Delete: Target's TVDB episode is missing again.
  const deleted = await remove(oneToOne.id);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual((await deleted.json()).deleted, [oneToOne.id]);
  state = await h.status() as Status;
  assert.deepEqual(results(h, state).target, { [key(whole)]: `incomplete because ${key(a)}`, [key(keptTvdb)]: "missing" });
  assert.equal(state.coverage.pending, 0);

  // Ignore Other: its member's flag is cleared and the derived effect in Target is withdrawn.
  const ignored = await h.patchSettings({ ignoredShows: [{ ratingKey: "ratingKey:other", title: "Other", duration: "forever" }] });
  assert.equal(ignored.status, 200, await ignored.clone().text());
  const ignoreBody = await ignored.json();
  assert.deepEqual(await h.flags(crossShow.id), []);
  state = await h.status() as Status;
  assert.deepEqual(ignoreBody, { saved: true, coverageRevision: state.coverage.revision });
  assert.deepEqual(results(h, state).target, { [key(keptTvdb)]: "missing" });
  assert.equal(state.report.shows.some(show => show.ratingKey === "ratingKey:other"), false, "The ignored show's results are hidden");
  assert.equal(state.coverage.pending, 0);
  const cached = results(h, state);

  // A later Plex scan agrees with the cached rechecks.
  state = await h.rerun() as Status;
  assert.deepEqual(results(h, state), cached, "The scan's results match the saved Manual Matches as the cached rechecks left them");
  assert.equal(state.coverage.pending, 0);
  assert.deepEqual((await h.mappings()).map(mapping => ({ id: mapping.id, members: mapping.members.map(key), flagged: mapping.members.filter(member => member.reportMissing).map(key) })), [
    { id: crossShow.id, members: [whole, a, b].map(key), flagged: [] },
  ]);
});

/** Makes the next cached recheck reject part-way, at its report write after its refresh obligations and comparisons, once. */
function failNextRecheckWrite(t: test.TestContext) {
  const write = plexSavedState.report.write.bind(plexSavedState.report);
  const fault = { armed: true };
  t.mock.method(plexSavedState.report, "write", (...args: Parameters<typeof write>) => {
    if (!fault.armed) return write(...args);
    fault.armed = false;
    throw new Error("Injected cached recheck failure.");
  });
  return fault;
}

/** Edits the cross-show Manual Match to drop Part C (an Other episode), with its cached recheck failing as it starts. */
async function failedEditDroppingPartC(t: test.TestContext, h: Harness, crossShow: { id: string; revision: number }) {
  const fault = failNextRecheck(t);
  const resolved = await h.post({ action: "resolve", id: crossShow.id, urls: [`tmdb:${whole.id} show:10 season:${whole.season} episode:${whole.episode}`, `tvdb:${a.id}`, `tvdb:${b.id}`] });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const edited = await h.post({ action: "save", id: crossShow.id, revision: crossShow.revision, preview: (await resolved.json()).preview });
  assert.equal(edited.status, 200, await edited.clone().text());
  assert.equal(fault.armed, false, "The cached recheck failed");
}

test("a failed edit's shows stay pending across restarts and a second failure, and the next successful unrelated change rechecks them", async t => {
  const h = await harness(t);
  await h.rerun();
  const crossShow = (await (await h.save([whole, a, b, c])).json()).mapping;
  const oneToOne = (await (await h.save([kept, keptTvdb])).json()).mapping;
  let state = await h.status() as Status;
  assert.deepEqual(results(h, state), { target: {}, other: {} });

  await failedEditDroppingPartC(t, h, crossShow);
  h.restart();

  // An unrelated change in Target only, whose cached recheck fails part-way.
  const partWay = failNextRecheckWrite(t);
  const flagged = await h.setFlags(oneToOne.id, [keptTvdb]);
  assert.deepEqual(flagged.members.filter(member => member.reportMissing).map(key), [key(keptTvdb)]);
  assert.equal(partWay.armed, false, "The second cached recheck failed too");
  state = await h.status() as Status;
  assert.ok(pendingIn(state.coverage), "Both changes' shows stay pending");
  assert.deepEqual(results(h, state), { target: {}, other: {} }, "The last results stay");
  h.restart();

  // A later, unrelated successful change in Target also rechecks Other for the failed edit.
  const deleted = await remove(oneToOne.id);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  state = await h.status() as Status;
  assert.deepEqual(results(h, state), {
    target: { [key(keptTvdb)]: "missing" },
    other: { [key(c)]: "missing" },
  }, "The failed edit's removed member is missing again in Other");
  assert.equal(state.coverage.pending, 0, "The comparison completes only once every carried show is rechecked");
  assert.ok(!(await manualMatchReport()).issues.some(issue => issue.id === "comparison-pending"));
});

test("only a completed full Plex scan completes a failed edit's pending comparison; a single-show or failed scan keeps it", async t => {
  const h = await harness(t);
  await h.rerun();
  const crossShow = (await (await h.save([whole, a, b, c])).json()).mapping;
  await failedEditDroppingPartC(t, h, crossShow);

  // The saved report is older than the edit, so a single-show scan is refused and completes nothing.
  await assert.rejects(h.rerun("ratingKey:target"), /Run a full Plex search/);
  let state = await h.status() as Status;
  assert.ok(pendingIn(state.coverage), "The refused single-show scan leaves the failed edit's shows pending");
  assert.deepEqual(results(h, state).other, {}, "Other keeps its last results");

  h.state.statuses.set("/library/sections", 500);
  await assert.rejects(h.rerun(), "The full scan fails");
  h.state.statuses.delete("/library/sections");
  state = await h.status() as Status;
  assert.ok(pendingIn(state.coverage), "A failed full scan leaves them pending");

  h.restart();
  state = await h.rerun() as Status;
  assert.deepEqual(results(h, state), { target: { [key(keptTvdb)]: "missing" }, other: { [key(c)]: "missing" } });
  assert.equal(state.coverage.pending, 0, "A completed full scan completes the comparison");

  // A recheck that saves its report but stops before completing (as a crash would)
  // leaves its members carried; a single-show scan does not compare them all.
  const write = plexSavedState.report.write.bind(plexSavedState.report);
  let stop = true;
  t.mock.method(plexSavedState.report, "write", (...args: Parameters<typeof write>) => {
    write(...args);
    if (stop) { stop = false; throw new Error("Injected stop after the report write."); }
  });
  await h.setFlags(crossShow.id, [a]);
  assert.equal(stop, false, "The recheck stopped after its report write");
  state = await h.rerun("ratingKey:target") as Status;
  assert.ok(pendingIn(state.coverage), "A completed single-show scan keeps the other carried members pending");
  state = await h.rerun() as Status;
  assert.equal(state.coverage.pending, 0);
});

test("a change committed while a cached recheck runs stays pending and carried until a later recheck covers it, even across a restart", async t => {
  const h = await harness(t);
  await h.rerun();
  const crossShow = (await (await h.save([whole, a, b, c])).json()).mapping;
  const oneToOne = (await (await h.save([kept, keptTvdb])).json()).mapping;

  // While the flag edit's recheck runs, a delete commits; the process stops before the delete's own recheck.
  const write = plexSavedState.report.write.bind(plexSavedState.report);
  let commitDuring = true;
  t.mock.method(plexSavedState.report, "write", (...args: Parameters<typeof write>) => {
    if (commitDuring) { commitDuring = false; deleteCoverageMapping(oneToOne.id); }
    return write(...args);
  });
  await h.setFlags(crossShow.id, [a]);
  assert.equal(commitDuring, false);
  let state = await h.status() as Status;
  assert.ok(pendingIn(state.coverage), "The earlier recheck's success does not complete the newer change");
  assert.deepEqual(results(h, state).target, { [key(whole)]: `incomplete because ${key(a)}` }, "The delete is not yet compared");
  h.restart();

  // The next cached recheck, whatever its own change, also rechecks the delete's show.
  await requestCoverageRecheck({ members: [] });
  state = await h.status() as Status;
  assert.deepEqual(results(h, state).target, { [key(whole)]: `incomplete because ${key(a)}`, [key(keptTvdb)]: "missing" });
  assert.equal(state.coverage.pending, 0);
});
