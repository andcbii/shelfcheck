import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { catalogues, fixture } from "./catalogue-override-harness";
import { harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const scanRoute = await import("../app/api/plex/scan/route");
hook.deregister();

// The lookup key cutover (SHELFCHECK-40) end to end, through the routes Andrew uses: the first
// start after the upgrade clears saved Plex scan data once; until a full scan rebuilds it, the
// existing messages say what to do and decisions still save; afterwards cached rechecks and
// restarts keep the rebuilt evidence.

type Issue = { id: string; operation: string; cause: string; action?: string };
type Show = { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[]; autoMatches?: { method: string; tmdb: { id?: number }; tvdb: { id?: number } }[] };
type Result = { report: { shows: Show[]; lastScan?: string }; coverage: { issues: Issue[]; pending?: unknown } };
const target = (result: unknown) => (result as Result).report.shows.find(show => show.ratingKey === "ratingKey:target")!;
const missingKeys = (result: unknown) => target(result).missing.flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
const autoMatches = (result: unknown) => (target(result).autoMatches || []).map(match => `${match.method}: TVDB ${match.tvdb.id} = TMDB ${match.tmdb.id}`).sort();
const issuesOf = (result: unknown) => (result as Result).coverage.issues;
const lookupIssues = (result: unknown) => issuesOf(result).filter(issue => issue.id.startsWith("episode-identity:"));
const settled = async (status: () => Promise<unknown>) => {
  let result = await status();
  for (let i = 0; i < 100 && (result as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await status(); }
  return result;
};

const DISCARDED_LOG = "Shelfcheck cleared its saved Plex scan data for the new provider lookup keys. Run a full Plex scan to download provider catalogues again; Manual Matches, Report Missing flags, Ignores, catalogue choices and settings were kept.";

/**
 * Turn the closed database into one written by the release before the cutover: that release had
 * the same schema at version 5. Its saved scan data is cleared whatever its key format, so the data
 * this build saved stands in for it.
 */
function asReleaseBeforeCutover() {
  const db = new DatabaseSync(path.join(process.env.SHELFCHECK_DATA_DIR!, "shelfcheck.db"));
  try { db.exec("PRAGMA user_version = 5"); } finally { db.close(); }
}

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so every TVDB episode needs
// crosswalk evidence to be matched to an owned Plex file.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const catalogue = [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3];
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });

test("after the upgrade, the existing messages ask for a full scan and a Manual Match still saves; a full scan rebuilds evidence that cached rechecks and a restart keep", async t => {
  const h = await harness(t, catalogue, [tmdb1, tmdb2]);
  h.state.bodies.set("/3/find/301", found(tmdb1));
  h.state.bodies.set("/3/find/302", found(tmdb2));
  h.state.statuses.set("/3/find/303", 404);
  const before = await h.rerun();
  const matches = ["Matched via TMDB External ID: TVDB 301 = TMDB 9001", "Matched via TMDB External ID: TVDB 302 = TMDB 9002"];
  assert.deepEqual(autoMatches(before), matches);
  assert.equal(lookupIssues(before).length, 1, "the release before the cutover had an open lookup issue for TVDB 303");
  h.restart();
  asReleaseBeforeCutover();

  // First start after the upgrade.
  const info = t.mock.method(console, "info", () => {});
  h.requests.length = 0;
  const upgraded = await h.status();
  assert.deepEqual(info.mock.calls.map(call => call.arguments), [[DISCARDED_LOG]], "one log line says the saved scan data was cleared");
  assert.deepEqual(h.requests, [], "the upgrade starts no scan and sends no request");
  assert.notEqual((upgraded as { scan: { status: string } }).scan.status, "running", "no scan runs");
  assert.deepEqual(missingKeys(upgraded), missingKeys(before), "the last report's results are still shown");
  assert.deepEqual(lookupIssues(upgraded), [], "lookup issues saved under the old keys are gone");
  assert.deepEqual(catalogues.readPlexInputs().comparisons, {}, "no saved comparison survives");

  // A single-show scan asks for a full scan.
  const single = await scanRoute.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: JSON.stringify({ ratingKey: "ratingKey:target" }) }));
  assert.equal(single.status, 409);
  assert.deepEqual(await single.json(), { error: "Run a full Plex search before force-checking one show because the scan settings or cache format changed." });
  assert.notEqual((await h.status()).scan.status, "running", "no scan started");

  // A Manual Match still saves the decision; its cached recheck reports the incomplete inputs.
  const saved = await h.save([tmdb3, tvdb3]);
  assert.equal(saved.status, 201, await saved.clone().text());
  const mapping = (await saved.json()).mapping as { id: string };
  h.requests.length = 0;
  const rechecked = await settled(h.status);
  assert.deepEqual(h.requests, [], "the cached recheck sends no request");
  assert.deepEqual((await h.mappings()).map(saved => saved.id), [mapping.id], "the Manual Match is saved");
  assert.deepEqual(missingKeys(rechecked), missingKeys(before), "last-good results are kept, not presented as verified");
  const inputs = issuesOf(rechecked).find(issue => issue.id === "comparison-inputs:initial");
  assert.equal(inputs?.cause, "Saved Plex library inventory is missing or incomplete.");
  assert.equal(inputs?.action, "Run an explicit full Plex scan to capture complete library and provider inputs.");

  // The full scan downloads catalogues again and rebuilds usable evidence under lookup keys.
  h.state.statuses.delete("/3/find/303");
  const rebuilt = await h.rerun();
  for (const download of ["/3/tv/10/season/1", "/v4/series/20/episodes/default"]) assert.ok(h.requests.includes(download), `${download} is downloaded again`);
  assert.deepEqual(issuesOf(rebuilt).filter(issue => issue.id.startsWith("comparison-inputs:")), [], "the full scan clears the incomplete-input message");
  assert.deepEqual(lookupIssues(rebuilt), [], "TVDB 303's crosswalk now answers");
  assert.deepEqual(autoMatches(rebuilt), matches);
  assert.deepEqual(missingKeys(rebuilt), ["TMDB:9003", "TVDB:303"], "the unowned episode is still missing");
  const relationships = structuredClone(catalogues.readPlexInputs().comparisons["ratingKey:target"]!.relationships);
  for (const id of [301, 302, 303]) {
    assert.ok(relationships[`tmdb-episode-by-tvdb:${id}`], `TVDB ${id}'s crosswalk is saved under its lookup key`);
    assert.ok(catalogues.readSharedTmdbCrosswalk(id)?.receivedAt, `TVDB ${id}'s shared crosswalk evidence is saved`);
  }

  // Cached rechecks, before and after a restart, compare from the rebuilt evidence without a request.
  for (const restarting of [false, true]) {
    if (restarting) h.restart();
    info.mock.resetCalls();
    for (const flagged of [[tvdb3], []]) {
      h.requests.length = 0;
      await h.setFlags(mapping.id, flagged);
      const result = await settled(h.status);
      assert.deepEqual(h.requests, [], "the flag save and its cached recheck send no request");
      assert.equal(h.missing(result as Parameters<typeof h.missing>[0])["TVDB:303"], flagged.length ? "reported-missing" : "missing", "the recheck compared the show again");
      assert.deepEqual(issuesOf(result).filter(issue => issue.id.startsWith("comparison-inputs:")), [], "the saved evidence is complete");
      assert.deepEqual(autoMatches(result), autoMatches(rebuilt), "the saved crosswalks still match");
    }
    assert.deepEqual(info.mock.calls, [], "no second reset");
    assert.deepEqual(catalogues.readPlexInputs().comparisons["ratingKey:target"]!.relationships, relationships, "the rebuilt evidence is kept");
  }
});

test("after the upgrade, a catalogue override still saves and is compared by the next full scan", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10, 11];
  assert.equal((await f.run()).tmdbId, 10);
  f.restart();
  asReleaseBeforeCutover();
  t.mock.method(console, "info", () => {});

  f.requests.length = 0;
  const saved = await f.select({ identity: f.identity, provider: "tmdb", seriesId: 11 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(f.requests, [], "the save downloads nothing");
  assert.equal(f.selection().tmdb.override, 11, "the override is saved");
  assert.equal((await f.show()).tmdbId, 10, "last-good results are kept");
  const pending = (await f.issues()).find(issue => issue.id === `comparison-inputs:${f.identity}`);
  assert.equal(pending?.cause, "Saved comparison inputs for this show are missing or incomplete, so the new catalogue selection could not be compared. Last-good results were kept.");

  const show = await f.run();
  assert.equal(show.tmdbId, 11, "the full scan compares the chosen catalogue");
  assert.equal(f.tmdbDownloads(11), 1);
  assert.ok(!(await f.issues()).some(issue => issue.id === `comparison-inputs:${f.identity}`));
});
