import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, harness, type Episode } from "./report-missing-harness";

// ADR-0007 through the Scan Issues the app returns: an episode crosswalk check a Healthy
// Manual Match made unnecessary is not a failure, as for Report Missing. Its cause leaves
// Scan Issues, and so does the Provider Lookup root behind it once no uncovered episode
// still depends on that root. Unrelated causes, episodes and shows keep theirs.

type Issue = { id: string; operation: string; category?: string; cause: string; impacts?: string[]; causedBy?: string[] };
type Show = { ratingKey: string; missing: { tvdbEpisodeId?: number; tmdbEpisodeId?: number; sources: string[] }[]; coverageOutcomes?: { provider: string; id: number; status: string }[] };
type Result = { coverage: { issues: Issue[]; pending?: unknown }; report: { shows: Show[] } };
const issueIds = (result: unknown) => (result as Result).coverage.issues.map(issue => issue.id).sort();
const issue = (result: unknown, id: string) => (result as Result).coverage.issues.find(item => item.id === id);
const show = (result: unknown, name: "target" | "other" = "target") => (result as Result).report.shows.find(item => item.ratingKey === `ratingKey:${name}`)!;
const manual = (result: unknown) => (show(result).coverageOutcomes || []).filter(outcome => outcome.status === "manual" && outcome.provider === "TVDB").map(outcome => outcome.id).sort();
const missingTvdb = (result: unknown, name: "target" | "other" = "target") => show(result, name).missing.flatMap(episode => episode.tvdbEpisodeId ? [episode.tvdbEpisodeId] : []).sort();
const settled = async (status: () => Promise<unknown>) => {
  let result = await status();
  for (let i = 0; i < 100 && (result as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await status(); }
  return result;
};

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so each TVDB episode
// needs crosswalk evidence. Plex owns TMDB 9001 and 9002.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });

const root301 = "episode-identity:ratingKey:target:tmdb-episode-by-tvdb:301";
const root302 = "episode-identity:ratingKey:target:tmdb-episode-by-tvdb:302";
const check301 = "episode-check:ratingKey:target:episode-crosswalk:TMDB:TVDB:301";

/** Fault injection: remove one saved relationship from a show's saved comparison inputs. */
function dropSavedRelationship(ratingKey: string, relationship: string) {
  const db = (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!;
  const row = db.prepare("SELECT payload FROM shelfcheck_plex_generated_inputs WHERE cache_key=?").get(`comparison:${ratingKey}`) as { payload: string };
  const input = JSON.parse(row.payload) as { relationships: Record<string, unknown> };
  assert.ok(Object.hasOwn(input.relationships, relationship), "the saved relationship exists");
  delete input.relationships[relationship];
  db.prepare("UPDATE shelfcheck_plex_generated_inputs SET payload=? WHERE cache_key=?").run(JSON.stringify(input), `comparison:${ratingKey}`);
}

// Each failure class of TVDB 301's TMDB external-ID crosswalk, as Scan Issues show it, while
// TVDB 302's rejected request is an unrelated failure that must stay.
// `resumed`: TVDB 301's issues once the Manual Match is deleted and a live scan checks it again.
const failures: { kind: string; arrange: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>; shown: string[]; resumed: string[] }[] = [
  { kind: "a rejected request", shown: [root301], resumed: [root301], arrange: async h => { h.state.statuses.set("/3/find/301", 404); await h.rerun(); } },
  { kind: "an unreadable successful response", shown: [check301], resumed: [check301], arrange: async h => { h.state.bodies.set("/3/find/301", { tv_episode_results: "unreadable" }); await h.rerun(); } },
  // A live scan can request the dropped relationship again, and TMDB answers it.
  { kind: "an unavailable saved relationship", shown: [check301], resumed: [], arrange: async h => {
    h.state.bodies.set("/3/find/301", found(tmdb1));
    await h.rerun();
    dropSavedRelationship("ratingKey:target", "tmdb-episode-by-tvdb:301");
    // An unrelated Manual Match save rechecks the show offline.
    const unrelated = await h.save([tmdb3, tvdb3]);
    assert.ok(unrelated.ok, await unrelated.clone().text());
    await settled(h.status);
  } },
];

for (const { kind, arrange, shown, resumed } of failures) test(`a Manual Match covering TVDB 301 clears its crosswalk failure from ${kind} and its Provider Lookup root, keeping unrelated issues`, async t => {
  const h = await harness(t, [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3], [tmdb1, tmdb2]);
  h.state.statuses.set("/3/find/302", 404);
  await arrange(h);
  const before = await h.status();
  assert.deepEqual(issueIds(before), [...shown, root302].sort(), "before the Manual Match, both failures are Scan Issues");
  assert.deepEqual(missingTvdb(before), [301, 302, 303]);

  const saved = await h.save([tmdb1, tvdb1]);
  assert.ok(saved.ok, await saved.clone().text());
  h.requests.length = 0;
  const rechecked = await settled(h.status);
  assert.deepEqual([...h.requests], [], "the cached recheck makes no provider request");
  assert.deepEqual(manual(rechecked), [301]);
  assert.deepEqual(issueIds(rechecked), [root302], "the cached recheck clears TVDB 301's check and root; TVDB 302's stays");
  assert.match(issue(rechecked, root302)!.impacts!.join(" "), /No other method established coverage, so this episode remains in missing results/);

  const scanned = await h.rerun();
  assert.deepEqual(manual(scanned), [301]);
  assert.deepEqual(issueIds(scanned), [root302], "a live scan keeps them cleared");
  assert.deepEqual(missingTvdb(scanned), [302, 303]);

  // When manual coverage ends, the normal check runs again against current evidence.
  const deleted = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${encodeURIComponent((await saved.json()).mapping.id)}`, { method: "DELETE" }));
  assert.equal(deleted.status, 200, await deleted.clone().text());
  await settled(h.status);
  h.requests.length = 0;
  const uncovered = await h.rerun();
  assert.ok(h.requests.includes("/3/find/301"), "TVDB 301's crosswalk is requested again");
  assert.deepEqual(issueIds(uncovered), [...resumed, root302].sort());
  assert.deepEqual(missingTvdb(uncovered), resumed.length ? [301, 302, 303] : [302, 303]);
});

// Dependency accounting: Trakt names TMDB 9002 (S1E2) for both TVDB 301 and TVDB 302, so both
// Trakt crosswalks share one TMDB validation request, which TMDB rejects. Covering TVDB 301
// retires its Trakt check, but the shared request's root stays while uncovered TVDB 302 needs it.
const validationRoot = "episode-identity:ratingKey:target:tmdb-episode:10:1:2";
const traktNames9002 = (tvdbEpisodeId: number) => [{ type: "episode", episode: { season: 1, number: 2, ids: { tvdb: tvdbEpisodeId, tmdb: 9002 } }, show: { ids: { tmdb: 10, tvdb: 20 } } }];

test("a shared Trakt validation request's root stays while an uncovered episode still depends on it", async t => {
  const config = await import("../lib/server-config");
  const h = await harness(t, [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3], [tmdb1, tmdb3]);
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  h.state.bodies.set("/search/tvdb/301", traktNames9002(301));
  h.state.bodies.set("/search/tvdb/302", traktNames9002(302));
  h.state.statuses.set("/3/tv/10/season/1/episode/2", 404);
  const before = await h.rerun();
  assert.deepEqual(issueIds(before), [validationRoot], "both TVDB episodes' Trakt checks are grouped under the shared request");
  assert.deepEqual(missingTvdb(before), [301, 302, 303]);

  const saved = await h.save([tmdb1, tvdb1]);
  assert.ok(saved.ok, await saved.clone().text());
  for (const [when, result] of [["cached recheck", await settled(h.status)], ["live scan", await h.rerun()]] as const) {
    assert.deepEqual(manual(result), [301], when);
    assert.deepEqual(issueIds(result), [validationRoot], `${when}: TVDB 302 still needs the shared request`);
    const impacts = issue(result, validationRoot)!.impacts!.join(" ");
    assert.match(impacts, /Trakt episode crosswalk could not be checked.*remains in missing results/, `${when}: TVDB 302's Trakt check depends on it`);
    assert.doesNotMatch(impacts, /Manual Match/, `${when}: TVDB 301's check is not kept`);
    assert.deepEqual(missingTvdb(result), [302, 303]);
  }

  // A second Manual Match covers TVDB 302 (through owned TMDB 9003): no uncovered episode
  // depends on the shared request any more, so its root is retired.
  const second = await h.save([tmdb3, tvdb2]);
  assert.ok(second.ok, await second.clone().text());
  h.requests.length = 0;
  for (const [when, result] of [["cached recheck", await settled(h.status)], ["live scan", await h.rerun()]] as const) {
    assert.deepEqual(manual(result), [301, 302], when);
    assert.deepEqual(issueIds(result), [], `${when}: the shared request's root is retired with its last dependent`);
  }
  assert.ok(!h.requests.includes("/3/tv/10/season/1/episode/2"), "the retired request was skipped, not answered");
});

test("covering an episode clears only its own crosswalk issues: other episodes', shows', catalogue and Manual Match health issues stay", async t => {
  const tmdbOther: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Pilot", show: "other" };
  const tvdbOther: Episode = { provider: "TVDB", id: 401, season: 2, episode: 1, name: "Pilot", show: "other" };
  const h = await harness(t, [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3, tmdbOther, tvdbOther], [tmdb1, tmdb2, tmdbOther]);
  // A Manual Match whose TMDB member TMDB stops answering is Pending: a Manual Match health issue.
  const pendingMatch = await h.save([tmdb3, tvdb3]);
  assert.ok(pendingMatch.ok, await pendingMatch.clone().text());
  await settled(h.status);
  h.state.statuses.set("/3/tv/10/season/1/episode/3", 404);
  for (const id of [301, 302, 401]) h.state.statuses.set(`/3/find/${id}`, 404);
  // A malformed TVDB catalogue record: a Provider Catalogue issue.
  h.state.tvdbRecords = [{ id: 399, seasonNumber: 2, name: "Unnumbered" }];
  const pendingId = ((await pendingMatch.json()).mapping as { id: string }).id;
  const unrelated = [
    "episode-check:ratingKey:target:catalogue-record:TVDB:20:399",
    "episode-identity:ratingKey:other:tmdb-episode-by-tvdb:401",
    root302,
    `member-verification:${pendingId}:TMDB:9003`,
  ];
  assert.deepEqual(issueIds(await h.rerun()), [...unrelated, root301].sort());

  const saved = await h.save([tmdb1, tvdb1]);
  assert.ok(saved.ok, await saved.clone().text());
  assert.deepEqual(issueIds(await settled(h.status)), unrelated, "cached recheck: only TVDB 301's root is retired");
  assert.deepEqual(issueIds(await h.rerun()), unrelated, "live scan: only TVDB 301's root is retired");
  assert.deepEqual(issueIds(await h.rerun("ratingKey:target")), unrelated, "single-show scan: other shows' issues are kept");
});

test("with saved automatic evidence and an old failure seeded, cross-show Manual Matches from an ignored show take over attribution and clear the obsolete check, across restart and a single-show scan", async t => {
  // TMDB 9101 belongs to "Other", which is ignored; Plex owns it there.
  const tmdbOther: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Pilot", show: "other" };
  const h = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2, tmdbOther], [tmdb1, tmdb2, tmdbOther]);
  const ignored = await h.patchSettings({ ignoredShows: [{ ratingKey: "ratingKey:other", title: "Other", duration: "forever" }] });
  assert.equal(ignored.status, 200, await ignored.clone().text());
  h.state.statuses.set("/3/find/301", 404);
  h.state.bodies.set("/3/find/302", found(tmdb2));
  const autoMatched = (result: unknown) => (((show(result) as Show & { autoMatches?: { tvdb: { id: number } }[] }).autoMatches) || []).map(match => match.tvdb.id);
  const seeded = await h.rerun();
  assert.deepEqual(autoMatched(seeded), [302], "saved automatic evidence collects TVDB 302");
  assert.deepEqual(issueIds(seeded), [root301], "TVDB 301's rejected request is an old failure");

  for (const members of [[tmdbOther, tvdb1], [tmdb2, tvdb2]]) {
    const saved = await h.save(members);
    assert.ok(saved.ok, await saved.clone().text());
  }
  h.requests.length = 0;
  const rechecked = await settled(h.status);
  assert.deepEqual([...h.requests], [], "the cached recheck makes no provider request");
  const expect = (result: unknown, when: string) => {
    assert.deepEqual(manual(result), [301, 302], `${when}: both TVDB episodes are credited to their Manual Matches`);
    assert.deepEqual(autoMatched(result), [], `${when}: saved automatic evidence makes no Auto Match`);
    assert.deepEqual(issueIds(result), [], `${when}: the obsolete check and its root leave Scan Issues`);
    assert.deepEqual(missingTvdb(result), []);
  };
  expect(rechecked, "cached recheck");

  h.restart();
  expect(await h.status(), "after restart");
  h.requests.length = 0;
  expect(await h.rerun("ratingKey:target"), "single-show scan");
  assert.ok(!h.requests.some(path => path === "/3/find/301" || path === "/3/find/302"), "no crosswalk request for a covered episode");
  expect(await h.rerun(), "full scan");
});
