import assert from "node:assert/strict";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

// Episode crosswalk freshness (GLOSSARY): a needed TMDB external-ID crosswalk is reused
// within the UTC day it was received and requested again when a live scan on a later
// UTC day reaches that matching step, independently of TMDB's show change feed.

type Issue = { id: string; operation: string; provider?: string; cause: string; impacts?: string[]; episode?: { id?: number } };
type AutoMatch = { method: string; tmdb: { id?: number }; tvdb: { id?: number } };
type Result = { report: { shows: { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[]; autoMatches?: AutoMatch[] }[] }; coverage: { issues: Issue[]; pending?: unknown } };
const target = (result: unknown) => (result as Result).report.shows.find(show => show.ratingKey === "ratingKey:target")!;
const missingKeys = (result: unknown) => target(result).missing.flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
const autoMatches = (result: unknown) => (target(result).autoMatches || []).map(match => `${match.method}: TVDB ${match.tvdb.id} = TMDB ${match.tmdb.id}`).sort();
const issuesOf = (result: unknown) => (result as Result).coverage.issues;
const finds = (requests: string[]) => requests.filter(pathname => pathname.startsWith("/3/find/")).sort();
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const empty = { tv_results: [], tv_episode_results: [] };

// Gumby Adventures: Plex owns TMDB 616705; TVDB numbers the same episode differently.
const gumbyTmdb: Episode = { provider: "TMDB", id: 616705, season: 1, episode: 5, name: "Gumby Business" };
const gumbyTvdb: Episode = { provider: "TVDB", id: 186920, season: 2, episode: 3, name: "Gumby Business" };

test("Gumby: an empty TMDB crosswalk becomes a match on a later UTC day without a cache clear or a TMDB show change", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00Z") });
  const { rerun, state, requests, restart } = await harness(t, [gumbyTmdb, gumbyTvdb], [gumbyTmdb]);
  const first = await rerun();
  assert.deepEqual(finds(requests), ["/3/find/186920", "/3/find/20"]);
  assert.deepEqual(missingKeys(first), ["TVDB:186920"], "TMDB has not yet linked the TVDB episode");
  assert.deepEqual(issuesOf(first), [], "a valid empty response is not a Coverage Issue");

  // TMDB adds TVDB 186920 to TMDB 616705's external IDs; its show change feed stays empty.
  state.bodies.set("/3/find/186920", found(gumbyTmdb));
  t.mock.timers.setTime(Date.parse("2026-11-12T17:30:00Z"));
  requests.length = 0;
  const sameDay = await rerun();
  assert.deepEqual(finds(requests), [], "the same UTC day reuses the valid empty response");
  assert.deepEqual(missingKeys(sameDay), ["TVDB:186920"]);

  restart();
  t.mock.timers.setTime(Date.parse("2026-11-13T12:01:00Z"));
  requests.length = 0;
  const nextDay = await rerun();
  assert.ok(requests.includes("/3/tv/changes"), "the TMDB change feed was checked");
  assert.ok(requests.includes("/3/find/186920"), "the next UTC day's needed crosswalk is requested again");
  assert.deepEqual(missingKeys(nextDay), [], "the episode is collected without a cache clear");
  assert.deepEqual(autoMatches(nextDay), ["Matched via TMDB External ID: TVDB 186920 = TMDB 616705"]);
  assert.deepEqual(issuesOf(nextDay), []);

  // Later same-day scans, including after restart, reuse the successful match.
  for (const time of ["2026-11-13T12:03:00Z", "2026-11-13T13:26:00Z"]) {
    restart();
    t.mock.timers.setTime(Date.parse(time));
    requests.length = 0;
    const repeat = await rerun();
    assert.deepEqual(finds(requests), [], `the ${time} scan reuses the match`);
    assert.deepEqual(missingKeys(repeat), []);
    assert.deepEqual(autoMatches(repeat), ["Matched via TMDB External ID: TVDB 186920 = TMDB 616705"]);
  }
});

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so each TVDB episode
// reaches the TMDB external-ID crosswalk unless an earlier method covers it.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const settled = async (status: () => Promise<unknown>) => {
  let result = await status();
  for (let i = 0; i < 100 && (result as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await status(); }
  return result;
};

test("an offline Manual Match recheck replays an older saved match without HTTP and without renewing it", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00Z") });
  const { rerun, state, requests, restart, save, status } = await harness(t, [tmdb1, tmdb3, tvdb1, tvdb3], [tmdb1]);
  state.bodies.set("/3/find/301", found(tmdb1));
  const first = await rerun();
  assert.deepEqual(missingKeys(first), ["TMDB:9003", "TVDB:303"]);
  assert.deepEqual(autoMatches(first), ["Matched via TMDB External ID: TVDB 301 = TMDB 9001"]);

  // On the next UTC day, a Manual Match edit rechecks the show offline from saved evidence.
  restart();
  t.mock.timers.setTime(Date.parse("2026-11-13T09:00:00Z"));
  state.bodies.set("/3/find/301", empty);
  const saved = await save([tmdb3, tvdb3]);
  assert.ok(saved.ok, await saved.clone().text());
  requests.length = 0;
  const rechecked = await settled(status);
  assert.deepEqual([...requests], [], "the cached recheck stays offline");
  assert.deepEqual(missingKeys(rechecked), ["TMDB:9003", "TVDB:303"], "the older saved match remains available offline");
  assert.deepEqual(autoMatches(rechecked), ["Matched via TMDB External ID: TVDB 301 = TMDB 9001"]);

  // The replay did not renew the day-one receipt: the next live scan refreshes it, and the
  // fresh empty response withdraws the coverage that match established.
  restart();
  t.mock.timers.setTime(Date.parse("2026-11-13T10:00:00Z"));
  requests.length = 0;
  const live = await rerun();
  assert.ok(requests.includes("/3/find/301"), "the day-one response is requested again");
  assert.deepEqual(missingKeys(live), ["TMDB:9003", "TVDB:301", "TVDB:303"]);
  assert.deepEqual(autoMatches(live), []);
  assert.deepEqual(issuesOf(live), [], "a valid empty response creates no Coverage Issue");
});

test("a fresh empty response withdraws only its old match's coverage; a Manual Match still covers its episode", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00Z") });
  const { rerun, state, requests, save } = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2], [tmdb1, tmdb2]);
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  const saved = await save([tmdb1, tvdb1]);
  assert.ok(saved.ok, await saved.clone().text());
  const first = await rerun();
  assert.deepEqual(missingKeys(first), []);
  assert.deepEqual(autoMatches(first), ["Matched via TMDB External ID: TVDB 301 = TMDB 9001", "Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);

  // TMDB removes both external IDs; the change is seen on the next UTC day.
  state.bodies.set("/3/find/301", empty);
  state.bodies.set("/3/find/302", empty);
  t.mock.timers.setTime(Date.parse("2026-11-13T12:00:00Z"));
  requests.length = 0;
  const next = await rerun();
  assert.deepEqual(finds(requests).filter(path => path !== "/3/find/20"), ["/3/find/301", "/3/find/302"]);
  assert.deepEqual(missingKeys(next), ["TVDB:302"], "the Manual Match still covers TVDB 301; TVDB 302 lost its only coverage");
  assert.deepEqual(autoMatches(next), []);
  assert.deepEqual(issuesOf(next), [], "valid empty responses are not Coverage Issues");
});

test("an undated saved crosswalk is refreshed only when matching needs it, and an unused expired one is never requested", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00Z") });
  const plex = [tmdb1, tmdb2];
  const { rerun, state, requests, restart, writeUndatedRelationships } = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2], plex);
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  assert.deepEqual(missingKeys(await rerun()), []);

  // An upgrade leaves responses saved without a receipt time; Plex now owns TVDB 301 directly.
  writeUndatedRelationships();
  restart();
  plex.push({ ...tvdb1, season: 9, episode: 9 });
  t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
  requests.length = 0;
  const upgraded = await rerun();
  assert.deepEqual(finds(requests).filter(path => path !== "/3/find/20"), ["/3/find/302"], "only the needed undated crosswalk is requested, even on the same UTC day");
  assert.deepEqual(missingKeys(upgraded), []);
  assert.deepEqual(autoMatches(upgraded), ["Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);

  // The refreshed response now has a receipt time and is reused that day.
  t.mock.timers.setTime(Date.parse("2026-11-12T14:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(finds(requests), []);

  // On a later UTC day, direct ownership still covers TVDB 301: its old crosswalk is neither requested nor reported.
  t.mock.timers.setTime(Date.parse("2026-11-14T12:00:00Z"));
  requests.length = 0;
  const later = await rerun();
  assert.ok(!requests.includes("/3/find/301"), "an unused expired crosswalk is not requested");
  assert.ok(requests.includes("/3/find/302"));
  assert.deepEqual(missingKeys(later), []);
  assert.deepEqual(issuesOf(later), [], "no age-only Coverage Issue");
});

test("a scan keeps its starting UTC date: a response received after midnight is reused within that scan and on its receipt date", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T23:59:58Z") });
  const { rerun, state, requests, restart } = await harness(t, [gumbyTmdb, gumbyTvdb], [gumbyTmdb]);
  state.bodies.set("/3/find/186920", found(gumbyTmdb));
  // The crosswalk response arrives after UTC midnight.
  state.onRequest = pathname => { if (pathname === "/3/find/186920") t.mock.timers.setTime(Date.parse("2026-11-13T00:00:05Z")); };
  const crossing = await rerun();
  state.onRequest = undefined;
  assert.deepEqual(requests.filter(path => path === "/3/find/186920"), ["/3/find/186920"], "one lookup within the scan");
  assert.deepEqual(missingKeys(crossing), []);

  // A later scan on the receipt date reuses it, including after restart.
  restart();
  t.mock.timers.setTime(Date.parse("2026-11-13T08:00:00Z"));
  requests.length = 0;
  const receiptDay = await rerun();
  assert.deepEqual(finds(requests), [], "the response received on 2026-11-13 is current for that day");
  assert.deepEqual(autoMatches(receiptDay), ["Matched via TMDB External ID: TVDB 186920 = TMDB 616705"]);

  t.mock.timers.setTime(Date.parse("2026-11-14T00:00:01Z"));
  requests.length = 0;
  await rerun();
  assert.ok(requests.includes("/3/find/186920"), "the following UTC day refreshes it");
});

test("single-show rescan, cache clearing and provider-change invalidation still bypass same-day reuse", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T10:00:00Z") });
  const { rerun, clearCache, state, requests } = await harness(t, [tmdb1, tvdb1], [tmdb1]);
  state.bodies.set("/3/find/301", found(tmdb1));
  await rerun();
  const lookupAfter = async (time: string, action: () => Promise<unknown>) => {
    t.mock.timers.setTime(Date.parse(time));
    requests.length = 0;
    const result = await action();
    assert.deepEqual(missingKeys(result), []);
    return requests.includes("/3/find/301");
  };
  assert.equal(await lookupAfter("2026-11-12T11:00:00Z", () => rerun()), false, "an ordinary same-day scan reuses the response");
  assert.equal(await lookupAfter("2026-11-12T12:00:00Z", () => rerun("ratingKey:target")), true, "a single-show rescan forces the lookup");
  assert.equal(await lookupAfter("2026-11-12T13:00:00Z", async () => { await clearCache("ratingKey:target"); return rerun(); }), true, "clearing the show's cache forces the lookup");
  assert.equal(await lookupAfter("2026-11-12T14:00:00Z", async () => { await clearCache(); return rerun(); }), true, "clearing the whole cache forces the lookup");

  // Next UTC day: the daily refresh, then a TMDB change to the show re-downloads its catalogue and invalidates its relationships.
  assert.equal(await lookupAfter("2026-11-13T09:00:00Z", () => rerun()), true, "the next UTC day refreshes the response");
  state.bodies.set("/3/tv/changes", { results: [{ id: 10 }], total_pages: 1 });
  assert.equal(await lookupAfter("2026-11-13T10:00:00Z", () => rerun()), true, "provider-change invalidation forces the same-day lookup");
  state.bodies.delete("/3/tv/changes");
  assert.equal(await lookupAfter("2026-11-13T11:00:00Z", () => rerun()), false);
});

test("a failed refresh of an expired crosswalk grants no coverage from the old answer and is retried the same day", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00Z") });
  const { rerun, state, requests, restart, save, status } = await harness(t, [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3], [tmdb1, tmdb2]);
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  const saved = await save([tmdb2, tvdb2]);
  assert.ok(saved.ok, await saved.clone().text());
  const first = await rerun();
  assert.deepEqual(missingKeys(first), ["TMDB:9003", "TVDB:303"]);
  // Each failed TMDB crosswalk check of one TVDB episode, with its cause and impact on that episode.
  const crosswalkIssues = (result: unknown) => issuesOf(result).filter(issue => issue.provider === "TMDB" && issue.episode?.id && ["episode-crosswalk", "episode-identity"].includes(issue.operation)).map(issue => `${issue.episode!.id}: ${issue.cause} ${(issue.impacts || []).join(" ")}`).sort();

  // Next UTC day, TMDB rejects both expired crosswalks' refreshes.
  state.statuses.set("/3/find/301", 404);
  state.statuses.set("/3/find/302", 404);
  for (const time of ["2026-11-13T12:00:00Z", "2026-11-13T13:00:00Z"]) {
    t.mock.timers.setTime(Date.parse(time));
    requests.length = 0;
    const failed = await rerun();
    assert.deepEqual(finds(requests).filter(path => path === "/3/find/301" || path === "/3/find/302"), ["/3/find/301", "/3/find/302"], `${time}: both failed refreshes are requested`);
    assert.deepEqual(missingKeys(failed), ["TMDB:9003", "TVDB:301", "TVDB:303"], "the old match no longer covers TVDB 301; the Manual Match still covers TVDB 302");
    assert.deepEqual(autoMatches(failed), []);
    const [missingCause, collectedCause, ...others] = crosswalkIssues(failed);
    assert.deepEqual(others, []);
    assert.match(missingCause, /^301: .*TMDB request failed.*No other method established coverage, so this episode remains in missing results/, "a failed check, not a confirmed no-match");
    assert.match(collectedCause, /^302: .*TMDB request failed.*Manual Match established coverage for this episode, so it remains collected/);
  }

  // An unreadable successful response is retried like a rejected one and grants nothing.
  state.statuses.delete("/3/find/301");
  state.bodies.set("/3/find/301", { tv_episode_results: {} });
  for (const time of ["2026-11-13T14:00:00Z", "2026-11-13T15:00:00Z"]) {
    t.mock.timers.setTime(Date.parse(time));
    requests.length = 0;
    const unreadable = await rerun();
    assert.ok(requests.includes("/3/find/301"), `${time}: the unreadable response is requested again`);
    assert.deepEqual(missingKeys(unreadable), ["TMDB:9003", "TVDB:301", "TVDB:303"]);
    assert.match(crosswalkIssues(unreadable)[0], /^301: .*could not be interpreted.*remains in missing results/);
  }

  // An offline recheck after restart does not revive the rejected answer.
  restart();
  const edited = await save([tmdb3, tvdb3]);
  assert.ok(edited.ok, await edited.clone().text());
  requests.length = 0;
  const rechecked = await settled(status);
  assert.deepEqual([...requests], []);
  assert.deepEqual(missingKeys(rechecked), ["TMDB:9003", "TVDB:301", "TVDB:303"]);
  assert.deepEqual(autoMatches(rechecked), []);
  assert.match(crosswalkIssues(rechecked)[0], /^301: .*could not be interpreted.*remains in missing results/, "the failed check is retained");

  // Recovery clears only its own cause; TVDB 302's failed check stays unresolved despite its Manual Match.
  state.bodies.set("/3/find/301", found(tmdb1));
  t.mock.timers.setTime(Date.parse("2026-11-13T16:00:00Z"));
  const recovered = await rerun();
  assert.deepEqual(missingKeys(recovered), ["TMDB:9003", "TVDB:303"]);
  assert.deepEqual(autoMatches(recovered), ["Matched via TMDB External ID: TVDB 301 = TMDB 9001"]);
  assert.deepEqual(crosswalkIssues(recovered).map(issue => issue.split(":")[0]), ["302"]);
});
