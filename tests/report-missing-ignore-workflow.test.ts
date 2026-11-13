import assert from "node:assert/strict";
import test from "node:test";
import { flag, harness as workflow, key, type Episode, type Identity } from "./report-missing-harness";

// Two Plex shows: "Target" (TMDB 10 / TVDB 20) and "Other" (TMDB 11 / TVDB 21).
// A cross-show one-to-many Manual Match: Target's combined TMDB episode is the
// same content as three TVDB split episodes catalogued under Other. Plex owns the
// combined episode, so normal matching collects every part.
const whole: Episode = { provider: "TMDB", id: 100, season: 1, episode: 1, name: "Whole" };
const a: Episode = { provider: "TVDB", id: 200, season: 2, episode: 1, name: "Part A", show: "other" };
const b: Episode = { provider: "TVDB", id: 201, season: 2, episode: 2, name: "Part B", show: "other" };
const c: Episode = { provider: "TVDB", id: 202, season: 2, episode: 3, name: "Part C", show: "other" };
// A one-to-one Manual Match inside Target: season 1 on TMDB, season 2 on TVDB.
const kept: Episode = { provider: "TMDB", id: 101, season: 1, episode: 2, name: "Kept" };
const keptTvdb: Episode = { provider: "TVDB", id: 203, season: 2, episode: 4, name: "Kept (TVDB)" };
// Ownership evidence inside Other satisfying a Target episode elsewhere.
const evidence: Episode = { provider: "TMDB", id: 150, season: 1, episode: 1, name: "Owned in Other", show: "other" };
const satisfied: Episode = { provider: "TVDB", id: 250, season: 3, episode: 1, name: "Satisfied in Target" };

const catalogue = [whole, a, b, c, kept, keptTvdb, evidence, satisfied];
const owned = [whole, kept, evidence];
const harness = (t: test.TestContext) => workflow(t, catalogue, owned);
type Harness = Awaited<ReturnType<typeof harness>>;

const forever = (ratingKey: string, title: string) => ({ ratingKey, title, duration: "forever" });
const thirtyDays = (ratingKey: string, title: string) => ({ ratingKey, title, duration: "30d", expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
const expired = (ratingKey: string, title: string) => ({ ratingKey, title, duration: "30d", expiresAt: new Date(Date.now() - 1000).toISOString() });

async function ignore(h: Harness, patch: Record<string, unknown>) {
  const response = await h.patchSettings(patch);
  assert.equal(response.status, 200, await response.clone().text());
}

async function setup(h: Harness) {
  const crossShow = (await (await h.save([whole, a, b, c])).json()).mapping;
  const oneToOne = (await (await h.save([kept, keptTvdb])).json()).mapping;
  const ownership = (await (await h.save([evidence, satisfied])).json()).mapping;
  await h.rerun();
  await h.setFlags(crossShow.id, [c]);
  await h.setFlags(oneToOne.id, [kept]);
  return { crossShow, oneToOne, ownership };
}

test("whole-show Ignore deletes flags only for that show's members and immediately withdraws derived effects elsewhere", async t => {
  const h = await harness(t);
  const { crossShow, oneToOne, ownership } = await setup(h);
  let result = await h.status();
  assert.deepEqual(h.missing(result), { [key(whole)]: `incomplete because ${key(c)}`, [key(kept)]: "reported-missing" });
  assert.deepEqual(h.missing(result, "other"), { [key(c)]: "reported-missing" });

  const before = h.requests.length;
  await ignore(h, { ignoredShows: [forever("ratingKey:other", "Other")] });
  assert.equal(h.requests.length, before, "Cleanup and rechecks download nothing and enumerate nothing from Plex");
  assert.deepEqual(await h.flags(crossShow.id), [], "The flag on Other's member is deleted");
  assert.deepEqual(await h.flags(oneToOne.id), [key(kept)], "Flags outside the ignored show are preserved");
  result = await h.status();
  assert.deepEqual(h.missing(result), { [key(kept)]: "reported-missing" },
    "Target's combined episode is no longer incomplete: the derived effect was withdrawn immediately");
  assert.equal(result.report.shows.some(show => show.ratingKey === "ratingKey:other"), false, "The ignored show's results are hidden");
  assert.equal(h.missing(result)[key(satisfied)], undefined, "Ignored content's ownership evidence still satisfies mapped content elsewhere");
  assert.deepEqual((await h.mappings()).find(mapping => mapping.id === ownership.id)!.members.map(key), [evidence, satisfied].map(key), "Unrelated mappings are untouched");

  // Restore never recreates the deleted flag.
  await ignore(h, { ignoredShows: [] });
  assert.deepEqual(await h.flags(crossShow.id), []);
  assert.deepEqual(h.missing(await h.rerun(), "other"), {}, "Restored content is matched normally");
});

test("whole-show Ignore of the show holding the combined episode clears its flags and hides its explicit missing results", async t => {
  const h = await harness(t);
  const { crossShow, oneToOne } = await setup(h);
  await h.setFlags(crossShow.id, [whole]);
  await ignore(h, { ignoredShows: [forever("ratingKey:target", "Target")] });
  assert.deepEqual(await h.flags(oneToOne.id), [], "Target's own flag is deleted");
  assert.deepEqual(await h.flags(crossShow.id), [], "The cross-show mapping's Target member flag is deleted");
  const result = await h.status();
  assert.equal(result.report.shows.some(show => show.ratingKey === "ratingKey:target"), false, "Explicitly missing results of an ignored show are hidden");
  assert.deepEqual(h.missing(result, "other"), {}, "Other's parts are collected again");
});

test("season Ignore deletes flags only for members in the selected seasons, and temporary expiry never recreates them", async t => {
  const h = await harness(t);
  const { crossShow, oneToOne } = await setup(h);
  // Flag Target's TVDB season-2 episode as well as its TMDB season-1 episode.
  await h.setFlags(oneToOne.id, [kept, keptTvdb]);
  assert.deepEqual(h.missing(await h.status()), { [key(whole)]: `incomplete because ${key(c)}`, [key(kept)]: "reported-missing", [key(keptTvdb)]: "reported-missing" });

  await ignore(h, { ignoredSeasons: [{ ...thirtyDays("ratingKey:target", "Target"), seasons: [2] }] });
  assert.deepEqual(await h.flags(oneToOne.id), [key(kept)], "Only the season-2 flag is deleted; season 1 is preserved");
  assert.deepEqual(await h.flags(crossShow.id), [key(c)], "A season Ignore of Target leaves members catalogued under Other alone");

  // The rule expires, then is restored: neither recreates the deleted flag.
  await ignore(h, { ignoredSeasons: [{ ...expired("ratingKey:target", "Target"), seasons: [2] }] });
  assert.deepEqual(await h.flags(oneToOne.id), [key(kept)]);
  await ignore(h, { ignoredSeasons: [] });
  assert.deepEqual(await h.flags(oneToOne.id), [key(kept)]);
  assert.deepEqual(h.missing(await h.status()), { [key(whole)]: `incomplete because ${key(c)}`, [key(kept)]: "reported-missing" });

  // Temporary and permanent Ignore clean up the same way.
  await ignore(h, { ignoredSeasons: [{ ...forever("ratingKey:other", "Other"), seasons: [2] }] });
  assert.deepEqual(await h.flags(crossShow.id), [], "A permanent season Ignore deletes flags in that season");
  assert.deepEqual(h.missing(await h.status()), { [key(kept)]: "reported-missing" }, "The derived incomplete status is withdrawn");
});

test("changing an existing Ignore's duration applies nothing new", async t => {
  const h = await harness(t);
  const { oneToOne } = await setup(h);
  await ignore(h, { ignoredSeasons: [{ ...forever("ratingKey:target", "Target"), seasons: [2] }] });
  await h.setFlags(oneToOne.id, [kept, keptTvdb]);
  await ignore(h, { ignoredSeasons: [{ ...thirtyDays("ratingKey:target", "Target"), seasons: [2] }] });
  assert.deepEqual(await h.flags(oneToOne.id), [key(kept), key(keptTvdb)], "Only a newly applied scope deletes flags");
});

// Many-to-many across shows: Target's two TMDB episodes are Other's three TVDB episodes.
const first: Episode = { provider: "TMDB", id: 300, season: 4, episode: 1, name: "First half" };
const second: Episode = { provider: "TMDB", id: 301, season: 4, episode: 2, name: "Second half" };
const x: Episode = { provider: "TVDB", id: 400, season: 5, episode: 1, name: "Part X", show: "other" };
const y: Episode = { provider: "TVDB", id: 401, season: 5, episode: 2, name: "Part Y", show: "other" };
const z: Episode = { provider: "TVDB", id: 402, season: 5, episode: 3, name: "Part Z", show: "other" };

test("cleanup may leave a many-to-many mapping one-sided; the remaining flag stays active until the next manual save", async t => {
  const h = await workflow(t, [first, second, x, y, z], [first, second]);
  const mapping = (await (await h.save([first, second, x, y, z], { reportMissing: [flag(second), flag(z)] })).json()).mapping;
  await h.rerun();
  await ignore(h, { ignoredShows: [forever("ratingKey:other", "Other")] });
  assert.deepEqual(await h.flags(mapping.id), [key(second)], "Cleanup succeeds and keeps the remaining TMDB flag");
  assert.deepEqual(h.missing(await h.status()), { [key(second)]: "reported-missing" }, "The remaining flag stays active");

  const flagOnly = async (members: Identity[]) => {
    const current = (await h.mappings()).find(item => item.id === mapping.id)!;
    return h.post({ action: "save", id: mapping.id, revision: current.revision, reportMissing: members.map(flag) });
  };
  const rejected = await flagOnly([second]);
  assert.equal(rejected.status, 400);
  const body = await rejected.json();
  assert.equal(body.code, "report-missing-one-sided");
  assert.match(body.error, /at least one TVDB episode.*or clear Report Missing on every episode/);
  assert.deepEqual(await h.flags(mapping.id), [key(second)], "A rejected save writes nothing");
  assert.equal((await flagOnly([])).status, 200, "Clearing every flag is a valid manual save");
});

test("Ignore rejects an editor's stale draft, and respects the scan lock only when it would delete flags", async t => {
  const h = await harness(t);
  const { crossShow, oneToOne } = await setup(h);
  const opened = (await h.mappings()).find(mapping => mapping.id === crossShow.id)!;
  const untouched = (await h.mappings()).find(mapping => mapping.id === oneToOne.id)!;

  // Applying Ignore while a scan is running is rejected when it would delete flags.
  const lock = globalThis as typeof globalThis & { __shelfcheckPlexScan?: Promise<void> };
  lock.__shelfcheckPlexScan = Promise.resolve();
  try {
    const blocked = await h.patchSettings({ ignoredShows: [forever("ratingKey:other", "Other")] });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "scan-active");
    assert.deepEqual(await h.flags(crossShow.id), [key(c)], "No flag is deleted");
    assert.deepEqual((await (await import("./report-missing-harness")).preferences.GET().then(response => response.json())).settings.ignoredShows, [], "The Ignore rule is not saved either");
    const harmless = await h.patchSettings({ hideUnairedEpisodes: true });
    assert.equal(harmless.status, 200, "Saves that delete no flags are not blocked");
  } finally {
    delete lock.__shelfcheckPlexScan;
  }

  await ignore(h, { ignoredShows: [forever("ratingKey:other", "Other")] });
  const refreshed = (await h.mappings()).find(mapping => mapping.id === crossShow.id)!;
  assert.notEqual(refreshed.revision, opened.revision, "The cleaned mapping has a new revision");
  assert.equal(refreshed.members.some(member => member.reportMissing), false, "Reloaded editor state reflects cleanup");
  assert.equal((await h.mappings()).find(mapping => mapping.id === oneToOne.id)!.revision, untouched.revision, "Unaffected mappings keep their revision");

  // A draft opened before the Ignore cannot silently restore the deleted flag.
  const stale = await h.post({ action: "save", id: crossShow.id, revision: opened.revision, reportMissing: [flag(c)] });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "stale-revision");
  assert.deepEqual(await h.flags(crossShow.id), []);
});
