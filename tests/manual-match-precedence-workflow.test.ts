import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { api, harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { plexSavedState } = await import("../lib/plex-scan");
hook.deregister();

// ADR-0007 through the Plex scan workflow: a covering Manual Match decides an episode
// right after Report Missing, so the episode is credited to the Manual Match, not to an
// Auto Match, even when the last scan saved automatic evidence for it. A cached recheck
// after saving, editing or deleting a Manual Match applies that order from saved inputs,
// without any provider request.

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so each TVDB episode is
// matched to its owned Plex file only by the TMDB external-ID crosswalk.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });

type Outcome = { provider: string; id: number; status: string };
type Show = { ratingKey: string; missing: unknown[]; autoMatches?: { tvdb: { id?: number } }[]; manualCoverage?: { mappingId: string }[]; coverageOutcomes?: Outcome[] };
type Result = { report: { shows: Show[] }; coverage: { pending?: number } };
const target = (result: unknown) => (result as Result).report.shows.find(show => show.ratingKey === "ratingKey:target")!;
/** How Target credits each TVDB episode: Auto Match rows, Manual Match coverage, missing results. */
const credit = (result: unknown) => {
  const show = target(result);
  return {
    autoMatches: (show.autoMatches || []).map(match => match.tvdb.id).sort(),
    manualMatches: (show.manualCoverage || []).map(item => item.mappingId),
    manual: (show.coverageOutcomes || []).filter(outcome => outcome.status === "manual").map(outcome => `${outcome.provider}:${outcome.id}`),
    missing: show.missing.length,
  };
};

test("a cached recheck after saving, editing and deleting a Manual Match credits each covered episode to it, ahead of saved automatic evidence, with zero provider requests", async t => {
  const h = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2], [tmdb1, tmdb2]);
  h.state.bodies.set("/3/find/301", found(tmdb1));
  h.state.bodies.set("/3/find/302", found(tmdb2));
  const scanned = await h.rerun();
  assert.deepEqual(credit(scanned), { autoMatches: [301, 302], manualMatches: [], manual: [], missing: 0 }, "the crosswalk collects both TVDB episodes");

  // Saving or editing a Manual Match verifies its members with providers before it commits;
  // the cached recheck that follows starts by reading the saved report and must make no request.
  const read = plexSavedState.report.read.bind(plexSavedState.report);
  let recheckStartedAt: number | undefined;
  t.mock.method(plexSavedState.report, "read", () => { recheckStartedAt ??= h.requests.length; return read(); });
  const recheckRequests = () => { assert.notEqual(recheckStartedAt, undefined, "a cached recheck ran"); return h.requests.slice(recheckStartedAt); };
  const resolve = async (members: Episode[], id?: string) => {
    const response = await h.post({ action: "resolve", ...(id ? { id } : {}), urls: members.map(member => member.provider === "TMDB" ? `tmdb:${member.id} show:10 season:${member.season} episode:${member.episode}` : `tvdb:${member.id}`) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).preview;
  };
  const settled = async () => {
    let result = await h.status();
    for (let i = 0; i < 100 && (result as unknown as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await h.status(); }
    return result;
  };

  // Save: TVDB 301's other side (TMDB 9001) is directly owned, so the Manual Match decides it.
  let preview = await resolve([tmdb1, tvdb1]);
  recheckStartedAt = undefined;
  const saved = await h.post({ action: "save", preview });
  assert.equal(saved.status, 201, await saved.clone().text());
  const mapping = (await saved.json()).mapping;
  let state = await settled();
  assert.deepEqual(recheckRequests(), [], "the save's cached recheck makes no provider request");
  assert.deepEqual(credit(state), { autoMatches: [302], manualMatches: [mapping.id], manual: ["TVDB:301"], missing: 0 }, "TVDB 301 is credited to the Manual Match, not to its saved crosswalk evidence");

  // Edit: the Manual Match now covers TVDB 302 instead; TVDB 301 returns to its saved evidence.
  preview = await resolve([tmdb2, tvdb2], mapping.id);
  recheckStartedAt = undefined;
  const edited = await h.post({ action: "save", id: mapping.id, revision: mapping.revision, preview });
  assert.equal(edited.status, 200, await edited.clone().text());
  state = await settled();
  assert.deepEqual(recheckRequests(), [], "the edit's cached recheck makes no provider request");
  assert.deepEqual(credit(state), { autoMatches: [301], manualMatches: [mapping.id], manual: ["TVDB:302"], missing: 0 });

  // Delete: both episodes return to their saved automatic evidence.
  recheckStartedAt = undefined;
  const deleted = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${encodeURIComponent(mapping.id)}`, { method: "DELETE" }));
  assert.equal(deleted.status, 200, await deleted.clone().text());
  state = await settled();
  assert.deepEqual(recheckRequests(), [], "the delete's cached recheck makes no provider request");
  assert.deepEqual(credit(state), { autoMatches: [301, 302], manualMatches: [], manual: [], missing: 0 });
});
