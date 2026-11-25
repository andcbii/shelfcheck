import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

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
