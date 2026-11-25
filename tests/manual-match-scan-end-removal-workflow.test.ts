import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { harness, key, type Episode } from "./report-missing-harness";

// End-of-scan removal (ADR-0008): a Manual Match member whose episode is gone from its own
// provider show's catalogue, downloaded fresh and complete in this scan run, is removed after the
// scan saves its report, and the cached recheck corrects every show the change affects.

// "Target" is Pinky and the Brain (TMDB 10 / TVDB 20); "Other" is Animaniacs (TMDB 11 / TVDB 21).
const pinky: Episode = { provider: "TMDB", id: 4009, season: 4, episode: 9, name: "Pinky and the Brain S04E09" };
const animaniacs: Episode = { provider: "TVDB", id: 5524, season: 5, episode: 24, name: "Animaniacs S05E24", show: "other" };
const pinkyTvdb: Episode = { provider: "TVDB", id: 2001, season: 1, episode: 1, name: "Pinky TVDB" };
const animaniacsTmdb: Episode = { provider: "TMDB", id: 1101, season: 1, episode: 1, name: "Animaniacs TMDB", show: "other" };
// TVDB still lists another Animaniacs episode: a download with no episodes at all proves nothing.
const animaniacsTvdb: Episode = { provider: "TVDB", id: 2101, season: 1, episode: 1, name: "Animaniacs TVDB", show: "other" };
const library = [pinky, pinkyTvdb, animaniacs, animaniacsTmdb, animaniacsTvdb];
const owned = [pinky, pinkyTvdb, animaniacsTmdb, animaniacsTvdb];

type Harness = Awaited<ReturnType<typeof harness>>;
type Coverage = { revision: number; pending: number; issues: { id: string }[] };

const coverage = async (h: Harness) => ((await h.status()) as unknown as { coverage: Coverage }).coverage;
/** Waits for the cached recheck a Manual Match save starts. */
async function settled(h: Harness) {
  for (let i = 0; i < 200 && (await coverage(h)).pending; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await coverage(h)).pending, 0, "the save's cached recheck settled");
}
async function saved(h: Harness, members: Episode[]) {
  const response = await h.save(members);
  assert.equal(response.status, 201, await response.clone().text());
  await settled(h);
  return (await response.json()).mapping as { id: string; revision: number };
}
/** The Plex scan log's lines for one event. */
const logged = (event: string) => {
  const file = path.join(process.env.SHELFCHECK_DATA_DIR!, "logs", "shelfcheck-plex.log");
  return existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.includes(` ${event} |`)) : [];
};
const removals = () => logged("plex.manual-match.member-removed");

test("a member gone from its show's fresh complete download deletes the whole Manual Match after the report is saved", async t => {
  const h = await harness(t, library, owned);
  await h.rerun();
  const match = await saved(h, [pinky, animaniacs]);
  assert.deepEqual(h.missing(await h.rerun(), "other"), {}, "Owning Pinky and the Brain S04E09 covers Animaniacs S05E24");
  assert.deepEqual(removals(), [], "a member still listed is kept");

  // TVDB deletes Animaniacs S05E24; the update feed makes the next scan download TVDB 21 again.
  h.state.gone.add(animaniacs.id);
  h.state.tvdbChanged = [21];
  const result = await h.rerun();
  assert.deepEqual(await h.mappings(), [], "removing the only TVDB member deletes the whole Manual Match");
  const lines = removals();
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`mappingId="${match.id}"`));
  assert.match(lines[0], /provider="TVDB"/);
  assert.match(lines[0], /showId=21\b/);
  assert.match(lines[0], /show="Other"/);
  assert.match(lines[0], /episodeId=5524\b/);
  assert.match(lines[0], /season=5 episode=24\b/);
  assert.match(lines[0], /matchDeleted=true/);
  const state = await coverage(h);
  assert.equal(state.pending, 0, "the cached recheck compared every affected show");
  assert.equal((result.report as { coverageRevision?: number }).coverageRevision, state.revision, "the published report is the rechecked one");
  assert.deepEqual(h.missing(result, "other"), {}, "the deleted episode is not reported missing");
  assert.deepEqual(h.missing(result), {});
});

test("a reused list removes nothing; a fresh one removes only the gone member and keeps the others' Report Missing flags", async t => {
  const animaniacs2: Episode = { provider: "TVDB", id: 5525, season: 5, episode: 25, name: "Animaniacs S05E25", show: "other" };
  const h = await harness(t, [...library, animaniacs2], owned);
  await h.rerun();
  const match = await saved(h, [pinky, animaniacs, animaniacs2]);
  await h.setFlags(match.id, [pinky, animaniacs2]);
  // This scan downloads what the save asked for; the next one reuses it.
  await h.rerun();
  const revision = (await coverage(h)).revision;

  h.state.gone.add(animaniacs.id);
  await h.rerun();
  assert.equal((await h.mappings())[0].members.length, 3, "a reused TVDB list proves nothing gone");
  assert.equal((await coverage(h)).revision, revision, "no candidates: no change and no new revision");
  assert.deepEqual(removals(), []);

  h.state.tvdbChanged = [21];
  await h.rerun();
  const [after] = await h.mappings();
  assert.equal(after.id, match.id);
  assert.deepEqual(after.members.map(key), [key(pinky), key(animaniacs2)], "only the gone member is removed");
  assert.deepEqual(await h.flags(match.id), [key(pinky), key(animaniacs2)], "the remaining members keep their Report Missing flags");
  assert.equal(after.revision, (await coverage(h)).revision);
  const lines = removals();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /episodeId=5524\b.*matchDeleted=false/);
});

/** Holds `path` (a catalogue request of the show to compare second) until the scan has compared one show. */
function compareSecond(h: Harness, path: string) {
  h.state.hold.set(path, (async () => {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
      if (((await h.status()) as unknown as { scan: { processed: number } }).scan.processed >= 1) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })());
}

// Counterexample A (one direction only): Target's TVDB v1 is matched to TMDB t1 (Target, owned) and
// t2 (Other, not owned). Other's fresh TMDB list no longer has t2, so t1 alone covers v1.
for (const order of ["Target", "Other"] as const) test(`removing a member another show compared corrects that show, with ${order} compared first`, async t => {
  const t1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
  const v1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
  const t2: Episode = { provider: "TMDB", id: 9102, season: 1, episode: 2, name: "Two", show: "other" };
  const o1: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Other one", show: "other" };
  const ov: Episode = { provider: "TVDB", id: 401, season: 1, episode: 1, name: "Other one", show: "other" };
  const h = await harness(t, [t1, v1, t2, o1, ov], [t1, o1, ov]);
  await h.rerun();
  await saved(h, [t1, t2, v1]);
  assert.deepEqual(h.missing(await h.status()), { [key(v1)]: "missing" }, "v1 is not covered while t2 is not owned");

  h.state.gone.add(t2.id);
  compareSecond(h, order === "Target" ? "/3/tv/11" : "/3/tv/10");
  const result = await h.rerun();
  assert.equal(removals().length, 1);
  assert.deepEqual((await h.mappings())[0].members.map(key), [key(t1), key(v1)]);
  assert.deepEqual(h.missing(result), {}, "t1 alone now covers v1");
  assert.deepEqual(h.missing(result, "other"), {});
  assert.equal((await coverage(h)).pending, 0);
});

// Counterexample B: many-to-many {t1 (Report Missing), t2} <-> {v1 (Target), v2 (Other)}. Other's
// fresh TVDB list no longer has v2, so v1 becomes the singleton side and derives Incomplete from t1.
for (const order of ["Target", "Other"] as const) test(`a many-to-many match becoming one-to-many derives Incomplete in the other show, with ${order} compared first`, async t => {
  const t1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
  const t2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
  const v1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
  const v2: Episode = { provider: "TVDB", id: 402, season: 2, episode: 2, name: "Two", show: "other" };
  const o1: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Other one", show: "other" };
  const ov: Episode = { provider: "TVDB", id: 401, season: 1, episode: 1, name: "Other one", show: "other" };
  const catalogue = [t1, t2, v1, v2, o1, ov], owned = [t1, t2, o1, ov];

  // The expected result: a scan of the match that remains, in a library where v2 never existed.
  const expected = await harness(t, catalogue.filter(episode => episode !== v2), owned);
  await expected.rerun();
  const remaining = await saved(expected, [t1, t2, v1]);
  expected.writeFlags(remaining.id, [t1]);
  const want = await expected.rerun();
  expected.restart();

  const h = await harness(t, catalogue, owned);
  await h.rerun();
  const match = await saved(h, [t1, t2, v1, v2]);
  h.writeFlags(match.id, [t1]);
  const before = await h.rerun();
  assert.notDeepEqual(h.missing(before), expected.missing(want), "the removal changes Target's result");

  h.state.gone.add(v2.id);
  h.state.tvdbChanged = [21];
  compareSecond(h, order === "Target" ? "/v4/series/21/episodes/default" : "/v4/series/20/episodes/default");
  const result = await h.rerun();
  assert.equal(removals().length, 1);
  assert.deepEqual(await h.flags(match.id), [key(t1)], "t1 keeps its flag");
  assert.deepEqual(h.missing(result), expected.missing(want));
  assert.deepEqual(h.group(result, match.id), expected.group(want, remaining.id));
});

const db = () => (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!;
/** Pinky and the Brain S04E09 <-> Animaniacs S05E24, saved and scanned, with S05E24 then gone from TVDB 21. */
async function pinkyGone(t: test.TestContext) {
  const h = await harness(t, library, owned);
  await h.rerun();
  const match = await saved(h, [pinky, animaniacs]);
  await h.rerun();
  h.state.gone.add(animaniacs.id);
  h.state.tvdbChanged = [21];
  return { h, match, revision: (await coverage(h)).revision };
}
async function unchanged(h: Harness, match: { id: string }, revision: number) {
  assert.deepEqual((await h.mappings()).map(mapping => [mapping.id, mapping.members.map(key)]), [[match.id, [key(pinky), key(animaniacs)]]], "no member is removed");
  assert.equal((await coverage(h)).revision, revision, "no Manual Match change committed");
  assert.deepEqual(removals(), [], "no removal is logged");
}

test("a scan whose report cannot be saved applies no removal", async t => {
  const { h, match, revision } = await pinkyGone(t);
  db().exec("CREATE TRIGGER fail_report BEFORE UPDATE OF report ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;");
  const failed = await h.scanToEnd();
  assert.equal(failed.scan.status, "error");
  assert.equal(failed.scan.error, "report store unavailable");
  await unchanged(h, match, revision);
});

test("a scan vetoed by a Manual Match change applies no removal", async t => {
  const { h, match } = await pinkyGone(t);
  // The coverage revision moves while the scan runs, as a Manual Match save would move it.
  h.state.onRequest = pathname => { if (pathname === "/v4/series/21/episodes/default") db().exec("UPDATE shelfcheck_coverage_state SET revision=revision+1 WHERE id=1"); };
  const vetoed = await h.scanToEnd();
  assert.equal(vetoed.scan.status, "error");
  assert.match(vetoed.scan.error!, /Manual Matches changed while this scan was running/);
  h.state.onRequest = undefined;
  await unchanged(h, match, (await coverage(h)).revision);
});

test("a failed removal change rolls back and removes nothing; the scan's saved report stands", async t => {
  const { h, match, revision } = await pinkyGone(t);
  db().exec("CREATE TRIGGER fail_removal BEFORE DELETE ON shelfcheck_coverage_mappings BEGIN SELECT RAISE(ABORT, 'coverage store unavailable'); END;");
  const result = await h.rerun();
  await unchanged(h, match, revision);
  assert.match(logged("plex.manual-match.removal-failed")[0] || "", /coverage store unavailable/);
  assert.equal((await coverage(h)).pending, 0, "nothing is carried");
  assert.equal((result.report as { coverageRevision?: number }).coverageRevision, revision);
});

test("removals committed before a failed cached recheck stay, pending, until a later scan compares them", async t => {
  const { h, match, revision } = await pinkyGone(t);
  // Only the recheck writes a report at the new coverage revision.
  db().exec(`CREATE TRIGGER fail_recheck BEFORE UPDATE OF report ON shelfcheck_scan_state WHEN json_extract(NEW.report, '$.coverageRevision') > ${revision} BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;`);
  const result = await h.rerun();
  assert.deepEqual(await h.mappings(), [], "the committed removal stays");
  assert.equal(removals().length, 1);
  assert.match(logged("plex.manual-match.recheck-failed")[0] || "", /report store unavailable/);
  const state = await coverage(h);
  assert.equal(state.revision, revision + 1);
  assert.equal(state.pending, 1, "the affected members stay carried and pending");
  assert.ok(state.issues.some(issue => issue.id === "comparison-pending"), "the comparison-pending Coverage Issue reports them");
  assert.equal((result.report as { coverageRevision?: number }).coverageRevision, revision, "the scan's report keeps its own revision");
  assert.ok(!(await h.mappings()).some(mapping => mapping.id === match.id));

  db().exec("DROP TRIGGER fail_recheck;");
  const later = await h.rerun();
  const recovered = await coverage(h);
  assert.equal(recovered.pending, 0, "a later scan compares the carried members");
  assert.equal((later.report as { coverageRevision?: number }).coverageRevision, recovered.revision);
  assert.deepEqual(h.missing(later, "other"), {});
});

test("a show whose catalogue downloaded but whose comparison failed proposes nothing", async t => {
  const { h, match, revision } = await pinkyGone(t);
  // Animaniacs' comparison fails after its fresh TVDB download, when it records its catalogue names.
  db().exec("CREATE TRIGGER fail_comparison BEFORE UPDATE OF name ON shelfcheck_catalogue_candidates WHEN NEW.identity = 'ratingKey:other' BEGIN SELECT RAISE(ABORT, 'comparison store unavailable'); END;");
  const result = await h.rerun();
  assert.ok(h.requests.includes("/v4/series/21/episodes/default"), "TVDB 21 was downloaded");
  assert.ok((result as unknown as { coverage: Coverage }).coverage.issues.some(issue => issue.id === "comparison-failure:ratingKey:other"), "Animaniacs' comparison failed");
  await unchanged(h, match, revision);
});

const resumePoint = () => (db().prepare("SELECT resume_point FROM shelfcheck_scan_state WHERE mode='plex'").get() as { resume_point: string | null }).resume_point;

test("a single-show scan removes members its fresh download proves gone, and the full-run Resume point it prunes is still rejected", async t => {
  const { h, revision } = await pinkyGone(t);
  // A full scan that fails at its report save leaves a Resume point at this coverage revision.
  db().exec("CREATE TRIGGER fail_report BEFORE UPDATE OF report ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;");
  assert.equal((await h.scanToEnd()).scan.status, "error");
  db().exec("DROP TRIGGER fail_report;");
  assert.ok(resumePoint(), "the failed full scan saved a Resume point");
  assert.deepEqual(removals(), []);
  h.state.tvdbChanged = [];

  const result = await h.rerun("ratingKey:other");
  assert.deepEqual(await h.mappings(), [], "the single-show scan's fresh TVDB download removes the member");
  assert.equal(removals().length, 1);
  const state = await coverage(h);
  assert.equal(state.revision, revision + 1);
  assert.equal(state.pending, 0);
  assert.equal((result.report as { coverageRevision?: number }).coverageRevision, state.revision);
  assert.ok(resumePoint(), "the single-show scan pruned the Resume point and kept it");

  await h.rerun();
  assert.equal(logged("plex.checkpoint.resume").length, 0, "the full scan does not resume from a point of the old coverage revision");
  assert.equal(logged("plex.checkpoint.discarded").length, 1);
});

test("ID-bearing unnumbered and special records count as listed, and an unreadable record proves nothing gone", async t => {
  const v: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
  const h = await harness(t, [...library, v], owned);
  await h.rerun();
  await saved(h, [pinky, v]);
  await h.rerun();
  h.state.gone.add(v.id);
  h.state.tvdbChanged = [20];
  const kept = async (records: unknown[], why: string) => {
    h.state.tvdbRecords = records;
    h.requests.length = 0;
    await h.rerun();
    assert.ok(h.requests.includes("/v4/series/20/episodes/default"), "TVDB 20 was downloaded again");
    assert.equal((await h.mappings())[0]?.members.length, 2, why);
  };
  await kept([{ id: v.id, name: "One" }], "a record without numbering still lists its episode");
  await kept([{ id: v.id, seasonNumber: 0, number: 3, name: "One", aired: "2020-01-01" }], "a special still lists its episode");
  await kept([{ seasonNumber: 1, number: 9, name: "No ID" }], "a record without an ID could be the member's");
  assert.deepEqual(removals(), []);

  // Once nothing lists it, the same download removes it.
  h.state.tvdbRecords = [];
  await h.rerun();
  assert.deepEqual(await h.mappings(), []);
  assert.equal(removals().length, 1);
});

const kept = () => logged("plex.manual-match.removal-kept");

test("a TVDB member missing from the default order but still at TVDB is kept; once TVDB answers 404 it is removed", async t => {
  // TVDB 201 is an alternate cut (S2E1) of the aired TVDB 202 (S1E1): an episode need not exist in
  // every season order, so the default listing can leave it out while TVDB still has it.
  const tmdb101: Episode = { provider: "TMDB", id: 101, season: 1, episode: 1, name: "One" };
  const alternate: Episode = { provider: "TVDB", id: 201, season: 2, episode: 1, name: "One (alternate cut)" };
  const aired: Episode = { provider: "TVDB", id: 202, season: 1, episode: 1, name: "One" };
  const h = await harness(t, [tmdb101, alternate, aired], [tmdb101]);
  await h.rerun();
  const match = await saved(h, [tmdb101, alternate]);
  await h.rerun();
  const revision = (await coverage(h)).revision;

  h.state.unlisted.add(alternate.id);
  h.state.tvdbChanged = [20];
  h.requests.length = 0;
  await h.rerun();
  assert.ok(h.requests.includes("/v4/series/20/episodes/default"), "TVDB 20 was downloaded fresh");
  assert.ok(h.requests.includes("/v4/episodes/201/extended"), "the candidate was looked up at TVDB");
  assert.deepEqual((await h.mappings()).map(mapping => [mapping.id, mapping.members.map(key)]), [[match.id, [key(tmdb101), key(alternate)]]], "the match survives");
  assert.equal((await coverage(h)).revision, revision, "no Manual Match change committed");
  assert.deepEqual(removals(), []);
  assert.match(kept()[0] || "", /provider="TVDB".*episodeId=201\b/);

  h.state.gone.add(alternate.id);
  await h.rerun();
  assert.deepEqual(await h.mappings(), [], "TVDB's 404 confirms the member gone and deletes the match");
  assert.match(removals()[0] || "", /episodeId=201\b.*matchDeleted=true/);
});

test("a TVDB member whose episode now belongs to another series is removed", async t => {
  const { h, match } = await pinkyGone(t);
  // Animaniacs S05E24 left TVDB 21's list because TVDB moved it to series 99, not because it was deleted.
  h.state.gone.delete(animaniacs.id);
  h.state.unlisted.add(animaniacs.id);
  h.state.bodies.set("/v4/episodes/5524/extended", { data: { id: 5524, seriesId: 99, seasonNumber: 1, number: 1, name: "Moved" } });
  await h.rerun();
  assert.deepEqual(await h.mappings(), []);
  assert.match(removals()[0] || "", new RegExp(`mappingId="${match.id}".*episodeId=5524\\b.*matchDeleted=true`));
});

test("a candidate whose lookup fails or answers unreadably is kept, and the scan completes", async t => {
  const { h, match, revision } = await pinkyGone(t);
  h.state.gone.delete(animaniacs.id);
  h.state.unlisted.add(animaniacs.id);
  const answers: [() => Response, RegExp][] = [
    [() => new Response("{}", { status: 503, headers: { "Retry-After": "1" } }), /reason="lookup-failed".*503/],
    [() => Response.json({ data: {} }), /reason="unreadable-answer"/],
  ];
  for (const [answer, why] of answers) {
    h.state.respond = url => url.pathname === "/v4/episodes/5524/extended" ? answer() : undefined;
    h.requests.length = 0;
    await h.rerun();
    assert.ok(h.requests.includes("/v4/episodes/5524/extended"), "the candidate was looked up");
    await unchanged(h, match, revision);
    assert.equal(kept().length, 1, "the kept candidate is logged");
    assert.match(kept()[0], /episodeId=5524\b/);
    assert.match(kept()[0], why);
  }
});

test("a TMDB season shorter than its advertised episode count proves nothing gone", async t => {
  const tmdb101: Episode = { provider: "TMDB", id: 101, season: 1, episode: 1, name: "One" };
  const tmdb102: Episode = { provider: "TMDB", id: 102, season: 1, episode: 2, name: "Two" };
  const tvdb201: Episode = { provider: "TVDB", id: 201, season: 2, episode: 1, name: "Two" };
  const h = await harness(t, [tmdb101, tmdb102, tvdb201], [tmdb101, tmdb102]);
  await h.rerun();
  const match = await saved(h, [tmdb102, tvdb201]);
  await h.rerun();
  const revision = (await coverage(h)).revision;

  // TMDB still advertises two episodes in season 1 but returns only 101; 102 is gone at its lookup too.
  h.state.gone.add(tmdb102.id);
  h.state.bodies.set("/3/tv/10", { id: 10, name: "Target", number_of_episodes: 2, seasons: [{ season_number: 1, episode_count: 2 }] });
  h.requests.length = 0;
  // A single-show scan downloads every catalogue it compares.
  await h.rerun("ratingKey:target");
  assert.ok(h.requests.includes("/3/tv/10/season/1"), "TMDB 10 was downloaded fresh");
  assert.deepEqual((await h.mappings()).map(mapping => [mapping.id, mapping.members.map(key)]), [[match.id, [key(tmdb102), key(tvdb201)]]]);
  assert.equal((await coverage(h)).revision, revision);
  assert.deepEqual(removals(), []);

  // With counts that agree, the same download removes it.
  h.state.bodies.set("/3/tv/10", { id: 10, name: "Target", number_of_episodes: 1, seasons: [{ season_number: 1, episode_count: 1 }] });
  await h.rerun("ratingKey:target");
  assert.deepEqual(await h.mappings(), []);
});

test("a failed download removes nothing", async t => {
  const { h, match, revision } = await pinkyGone(t);
  h.state.statuses.set("/v4/series/21/episodes/default", 404);
  h.requests.length = 0;
  await h.rerun();
  assert.ok(h.requests.includes("/v4/series/21/episodes/default"), "TVDB 21's download was attempted");
  await unchanged(h, match, revision);
});

test("a show compared with a saved copy for one provider proposes nothing, even from the other provider's fresh download", async t => {
  const { h, match, revision } = await pinkyGone(t);
  // TMDB 11 cannot be downloaded, so Animaniacs is compared with its saved TMDB copy and keeps its
  // last-good saved comparison, while TVDB 21 downloads fresh and complete without S05E24.
  h.state.statuses.set("/3/tv/11/season/1", 404);
  h.requests.length = 0;
  // A single-show scan downloads every catalogue it compares.
  await h.rerun("ratingKey:other");
  assert.ok(h.requests.includes("/3/tv/11/season/1") && h.requests.includes("/v4/series/21/episodes/default"));
  await unchanged(h, match, revision);
});

test("an incomplete TMDB enumeration removes nothing", async t => {
  // TMDB still lists another Pinky and the Brain episode: a download with no episodes at all proves nothing.
  const pinkyNext: Episode = { provider: "TMDB", id: 4010, season: 4, episode: 10, name: "Pinky and the Brain S04E10" };
  const h = await harness(t, [...library, pinkyNext], owned);
  await h.rerun();
  const match = await saved(h, [pinky, animaniacs]);
  await h.rerun();
  const revision = (await coverage(h)).revision;
  h.state.gone.add(pinky.id);
  // TMDB 10's season 4 also returns a record whose ID cannot be read: it could be S04E09.
  h.state.tmdbRecords = { 4: [{ season_number: 4, episode_number: 11, name: "No ID" }] };
  h.requests.length = 0;
  // A single-show scan downloads every catalogue it compares.
  await h.rerun("ratingKey:target");
  assert.ok(h.requests.includes("/3/tv/10/season/4"), "TMDB 10 was downloaded fresh");
  assert.deepEqual((await h.mappings()).map(mapping => [mapping.id, mapping.members.map(key)]), [[match.id, [key(pinky), key(animaniacs)]]]);
  assert.equal((await coverage(h)).revision, revision);
  assert.deepEqual(removals(), []);

  h.state.tmdbRecords = {};
  await h.rerun("ratingKey:target");
  assert.deepEqual(await h.mappings(), [], "a readable enumeration without S04E09 removes it");
});

test("a fallback catalogue removes nothing, even one downloaded fresh and complete for the member's own series", async t => {
  // Animaniacs has TVDB IDs 21 (preferred) and 22. TVDB 21 cannot be loaded, so TVDB 22 is
  // compared in its place; the member is an episode of TVDB 22.
  const alternate: Episode = { provider: "TVDB", id: 7701, season: 1, episode: 1, name: "Alternate" };
  const h = await harness(t, [pinky, pinkyTvdb, animaniacsTmdb], [pinky, pinkyTvdb, animaniacsTmdb]);
  let listed = true;
  const target = { ratingKey: "target", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://20" }] };
  const other = { ratingKey: "other", title: "Other", Guid: [{ id: "tmdb://11" }, { id: "tvdb://21" }, { id: "tvdb://22" }] };
  const record = (episode: Episode) => ({ id: episode.id, seasonNumber: episode.season, number: episode.episode, name: episode.name, aired: "2020-01-01" });
  h.state.respond = url => {
    if (url.hostname === "plex" && url.pathname.startsWith("/library/sections/")) return Response.json({ MediaContainer: { Metadata: [target, other] } });
    if (url.pathname === "/library/metadata/other") return Response.json({ MediaContainer: { Metadata: [other] } });
    if (url.pathname.startsWith("/v4/series/21")) return Response.json({}, { status: 404 });
    if (url.pathname === "/v4/series/22") return Response.json({ data: { id: 22, name: "Other alternate", slug: "other-alternate", defaultSeasonType: 1 } });
    if (url.pathname === "/v4/series/22/episodes/default") return Response.json({ data: { episodes: [...(listed ? [record(alternate)] : []), { id: 7702, seasonNumber: 1, number: 2, name: "Still listed", aired: "2020-01-01" }] } });
    if (url.pathname === "/v4/episodes/7701/extended") return Response.json({ data: { id: 7701, seriesId: 22, seasonNumber: 1, number: 1, name: "Alternate" } });
    return undefined;
  };
  await h.rerun();
  // TVDB 21's standing Coverage Issue keeps coverage pending, so the save is not awaited as settled.
  const response = await h.save([pinky, alternate]);
  assert.equal(response.status, 201, await response.clone().text());
  const match = (await response.json()).mapping as { id: string };
  await h.rerun();
  const revision = (await coverage(h)).revision;

  listed = false;
  h.state.tvdbChanged = [22];
  h.requests.length = 0;
  const result = await h.rerun();
  assert.ok(h.requests.includes("/v4/series/22/episodes/default"), "TVDB 22 was downloaded fresh");
  assert.equal((result.report.shows.find(show => show.ratingKey === "ratingKey:other") as { tvdbId?: number }).tvdbId, 22, "Animaniacs was compared with the fallback");
  assert.deepEqual((await h.mappings()).map(mapping => [mapping.id, mapping.members.map(key)]), [[match.id, [key(pinky), key(alternate)]]]);
  assert.equal((await coverage(h)).revision, revision);
  assert.deepEqual(removals(), []);
});

test("a scan that fails after comparing a show, before its report is saved, applies no removal", async t => {
  const { h, match, revision } = await pinkyGone(t);
  // Target's inventory is held until Animaniacs has been compared, then fails, and so does recording why.
  compareSecond(h, "/library/metadata/target");
  h.state.statuses.set("/library/metadata/target", 404);
  db().exec("CREATE TRIGGER fail_target BEFORE INSERT ON shelfcheck_coverage_issues WHEN NEW.id LIKE '%ratingKey:target%' BEGIN SELECT RAISE(ABORT, 'issue store unavailable'); END;");
  const failed = await h.scanToEnd();
  assert.equal(failed.scan.status, "error");
  assert.equal(failed.scan.error, "issue store unavailable");
  assert.ok(h.requests.includes("/v4/series/21/episodes/default"), "TVDB 21 was downloaded");
  await unchanged(h, match, revision);
});

/** Simulates the process ending: the next process starts with an empty owner record, and the abandoned run settles later. */
function abandonRunningScan(): Promise<void> {
  const global = globalThis as typeof globalThis & { __shelfcheckScanRun?: { owner?: unknown } };
  const abandoned = global.__shelfcheckScanRun!;
  global.__shelfcheckScanRun = {};
  return (async () => { while (abandoned.owner) await new Promise(resolve => setTimeout(resolve, 10)); })();
}
const processed = async (h: Harness) => ((await h.status()) as unknown as { scan: { processed: number } }).scan.processed;

test("an interrupted scan applies no removal, and the next scan's reused list removes nothing", async t => {
  const { h, match, revision } = await pinkyGone(t);
  // The process ends while Target's inventory is outstanding, after Animaniacs was compared.
  let release!: () => void;
  h.state.hold.set("/library/metadata/target", new Promise<void>(resolve => { release = resolve; }));
  await h.start();
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && await processed(h) < 1;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await processed(h), 1, "Animaniacs was compared");
  assert.ok(h.requests.includes("/v4/series/21/episodes/default"), "TVDB 21 was downloaded fresh");
  const abandoned = abandonRunningScan();
  try {
    h.restart();
    await unchanged(h, match, revision);

    // The next process reuses the catalogue the interrupted scan downloaded: it proves nothing gone.
    h.state.tvdbChanged = [];
    h.state.hold.delete("/library/metadata/target");
    h.requests.length = 0;
    await h.rerun();
    assert.ok(!h.requests.includes("/v4/series/21/episodes/default"), "TVDB 21 was reused");
    await unchanged(h, match, revision);
  } finally {
    // The abandoned run must not commit after the test: a Manual Match change vetoes it.
    db().exec("UPDATE shelfcheck_coverage_state SET revision=revision+1 WHERE id=1");
    release();
    await abandoned;
  }
});

test("after a failed cached recheck, the affected shows keep their last-good rows until a later scan compares them", async t => {
  // Counterexample A: Target's v1 is matched to t1 (owned) and t2 (Other, not owned); t2 is then gone from TMDB 11.
  const t1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
  const v1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
  const t2: Episode = { provider: "TMDB", id: 9102, season: 1, episode: 2, name: "Two", show: "other" };
  const o1: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Other one", show: "other" };
  const ov: Episode = { provider: "TVDB", id: 401, season: 1, episode: 1, name: "Other one", show: "other" };
  const h = await harness(t, [t1, v1, t2, o1, ov], [t1, o1, ov]);
  await h.rerun();
  await saved(h, [t1, t2, v1]);
  const revision = (await coverage(h)).revision;
  h.state.gone.add(t2.id);
  db().exec(`CREATE TRIGGER fail_recheck BEFORE UPDATE OF report ON shelfcheck_scan_state WHEN json_extract(NEW.report, '$.coverageRevision') > ${revision} BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;`);
  const result = await h.rerun();
  assert.deepEqual((await h.mappings())[0].members.map(key), [key(t1), key(v1)], "the removal of t2 is committed");
  assert.deepEqual(h.missing(result), { [key(v1)]: "missing" }, "Target keeps the row the scan compared while t2 was a member");
  const state = await coverage(h);
  assert.equal(state.pending, 1);
  assert.ok(state.issues.some(issue => issue.id === "comparison-pending"));

  db().exec("DROP TRIGGER fail_recheck;");
  const later = await h.rerun();
  assert.deepEqual(h.missing(later), {}, "a later scan finds t1 alone now covers v1");
  assert.equal((await coverage(h)).pending, 0);
});

test("a scan whose process ends while applying its removals reads as interrupted there; committed removals stay pending until a later scan", async t => {
  const { h, revision } = await pinkyGone(t);
  // The removal commits; the process then ends before the cached recheck, still running in the removal phase.
  db().exec(`CREATE TRIGGER fail_recheck BEFORE UPDATE OF report ON shelfcheck_scan_state WHEN json_extract(NEW.report, '$.coverageRevision') > ${revision} BEGIN SELECT RAISE(ABORT, 'process ended'); END;`);
  await h.rerun();
  db().exec("DROP TRIGGER fail_recheck;");
  const heartbeatAt = new Date(Date.now() - 120_000).toISOString();
  db().prepare("UPDATE shelfcheck_scan_state SET status=? WHERE mode='plex'").run(JSON.stringify({ status: "running", processed: 2, total: 2, startedAt: heartbeatAt, heartbeatAt, currentPhase: "manual-match-removal" }));

  const interrupted = await h.status() as unknown as { scan: { status: string; error?: string }; coverage: { issues: { id: string; cause?: string; action?: string }[] }; report: { coverageRevision?: number } };
  assert.equal(interrupted.scan.status, "error", "never recorded as completed");
  assert.match(interrupted.scan.error!, /saved its report but was interrupted while applying its Manual Match removals/);
  const failure = interrupted.coverage.issues.find(issue => issue.id === "scan-failure");
  assert.equal(failure?.cause, interrupted.scan.error);
  assert.match(failure?.action || "", /compare the shows the removals affect/);
  assert.ok(interrupted.coverage.issues.some(issue => issue.id === "comparison-pending"), "the committed removal's shows stay pending");
  assert.deepEqual(await h.mappings(), [], "the committed removal stays");
  assert.equal(interrupted.report.coverageRevision, revision, "the saved report is the scan's own");

  const later = await h.rerun();
  const state = await coverage(h);
  assert.equal(state.pending, 0, "a later scan compares the affected shows");
  assert.deepEqual(state.issues, []);
  assert.equal((later.report as { coverageRevision?: number }).coverageRevision, state.revision);
});
