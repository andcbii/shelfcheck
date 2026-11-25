import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
