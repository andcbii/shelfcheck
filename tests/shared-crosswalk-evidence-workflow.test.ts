import assert from "node:assert/strict";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

// Shared crosswalk evidence (GLOSSARY): separate show comparisons that need the same TMDB
// external-ID crosswalk for one TVDB episode share its response, its receipt time and its
// rejection, while each comparison still decides ownership against current inventory.

type Issue = { id: string; operation: string; provider?: string; cause: string; impacts?: string[]; show?: { ratingKey?: string }; episode?: { id?: number } };
type AutoMatch = { method: string; tmdb: { id?: number }; tvdb: { id?: number } };
type Show = { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[]; autoMatches?: AutoMatch[] };
type Result = { report: { shows: Show[] }; coverage: { issues: Issue[]; pending?: unknown } };
type Name = "target" | "other";
const showOf = (result: unknown, name: Name) => (result as Result).report.shows.find(show => show.ratingKey === `ratingKey:${name}`)!;
const missingKeys = (result: unknown, name: Name) => showOf(result, name).missing.flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
const autoMatches = (result: unknown, name: Name) => (showOf(result, name).autoMatches || []).map(match => `${match.method}: TVDB ${match.tvdb.id} = TMDB ${match.tmdb.id}`).sort();
/** Each show's failed TMDB crosswalk checks of one TVDB episode, with cause and impact. */
const crosswalkIssues = (result: unknown, name: Name) => (result as Result).coverage.issues.filter(issue => issue.provider === "TMDB" && issue.episode?.id && ["episode-crosswalk", "episode-identity"].includes(issue.operation) && issue.show?.ratingKey === `ratingKey:${name}`).map(issue => `${issue.episode!.id}: ${issue.cause} ${(issue.impacts || []).join(" ")}`).sort();
const sharedFinds = (requests: string[]) => requests.filter(pathname => /^\/3\/find\/3\d\d$/.test(pathname)).sort();
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const empty = { tv_results: [], tv_episode_results: [] };
const settled = async (status: () => Promise<unknown>) => {
  let result = await status();
  for (let i = 0; i < 100 && (result as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await status(); }
  return result;
};

// "Target" (TMDB 10 / TVDB 20) and "Other" (TMDB 11 / TVDB 21) both list TVDB episodes 301 and
// 302 at coordinates neither owns, so each comparison reaches the same TMDB external-ID lookup.
// Plex owns TMDB 9001 in Target; TVDB 311 is a lookup only Other needs.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
const tmdbOther: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Pilot", show: "other" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const tvdbOnlyOther: Episode = { provider: "TVDB", id: 311, season: 2, episode: 3, name: "Eleven", show: "other" };
const catalogue = [tmdb1, tmdb3, tmdbOther, tvdb1, tvdb2, tvdb3, { ...tvdb1, show: "other" as const }, { ...tvdb2, show: "other" as const }, tvdbOnlyOther];

/** Day one: TVDB 301 matches owned TMDB 9001 and TVDB 302 has a valid empty answer, for both shows. */
async function sharedDayOne(t: test.TestContext, time = "2026-11-12T10:00:00Z") {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(time) });
  const owned = [tmdb1, tmdbOther];
  const h = await harness(t, catalogue, owned);
  h.state.bodies.set("/3/find/301", found(tmdb1));
  h.state.bodies.set("/3/find/302", empty);
  return { ...h, owned };
}
const matched = "Matched via TMDB External ID: TVDB 301 = TMDB 9001";

test("separate shows share one TMDB crosswalk request for a match and a valid empty answer, across restart, until the next UTC day", async t => {
  const { rerun, requests, restart } = await sharedDayOne(t);
  const first = await rerun();
  assert.deepEqual(sharedFinds(requests), ["/3/find/301", "/3/find/302", "/3/find/303", "/3/find/311"], "each lookup is requested once for both shows");
  for (const name of ["target", "other"] as const) {
    assert.deepEqual(autoMatches(first, name), [matched], `${name}: the shared match covers TVDB 301`);
    assert.ok(missingKeys(first, name).includes("TVDB:302"), `${name}: the shared empty answer leaves TVDB 302 missing`);
    assert.deepEqual(crosswalkIssues(first, name), [], "valid answers are not Coverage Issues");
  }

  // Later same-day scans, including after restart, reuse both shared answers.
  for (const time of ["2026-11-12T11:00:00Z", "2026-11-12T23:59:00Z"]) {
    restart();
    t.mock.timers.setTime(Date.parse(time));
    requests.length = 0;
    const repeat = await rerun();
    assert.deepEqual(sharedFinds(requests), [], `${time}: the shared responses are reused`);
    for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(repeat, name), [matched]);
  }

  // Reuse never renewed the receipt time: the next UTC day refreshes each needed lookup once.
  restart();
  t.mock.timers.setTime(Date.parse("2026-11-13T00:30:00Z"));
  requests.length = 0;
  const nextDay = await rerun();
  assert.deepEqual(sharedFinds(requests), ["/3/find/301", "/3/find/302", "/3/find/303", "/3/find/311"]);
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(nextDay, name), [matched]);
});

test("a scan crossing UTC midnight shares a response received after midnight and reuses it on its receipt date", async t => {
  const { rerun, state, requests, restart } = await sharedDayOne(t, "2026-11-12T23:59:58Z");
  state.onRequest = pathname => { if (pathname === "/3/find/301") t.mock.timers.setTime(Date.parse("2026-11-13T00:00:05Z")); };
  const crossing = await rerun();
  state.onRequest = undefined;
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "one lookup serves both shows within the scan");
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(crossing, name), [matched]);

  restart();
  t.mock.timers.setTime(Date.parse("2026-11-13T08:00:00Z"));
  requests.length = 0;
  const receiptDay = await rerun();
  assert.ok(!requests.includes("/3/find/301"), "the shared response received on 2026-11-13 is current that day");
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(receiptDay, name), [matched]);

  t.mock.timers.setTime(Date.parse("2026-11-14T00:00:01Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "the following UTC day refreshes it once");
});

for (const outcome of ["a usable response", "a failed request"] as const) test(`overlapping comparisons wait for the one in-flight lookup and share ${outcome}`, async t => {
  const { rerun, state, requests } = await sharedDayOne(t);
  if (outcome === "a failed request") state.statuses.set("/3/find/301", 404);
  // Hold TMDB's answer until both comparisons have loaded their provider inputs and reached the
  // crosswalk step; a second request for the lookup would be held too.
  let release!: () => void;
  state.hold.set("/3/find/301", new Promise<void>(resolve => { release = resolve; }));
  const seen = (pathname: string) => requests.filter(path => path === pathname).length;
  state.onRequest = () => { if (seen("/v4/series/20") >= 2 && seen("/v4/series/21") >= 2 && seen("/3/find/301") >= 1) setTimeout(release, 50); };
  const result = await rerun();
  state.onRequest = undefined;
  assert.equal(seen("/v4/series/21"), 2, "both comparisons ran in this scan");
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "exactly one request for the shared lookup");
  for (const name of ["target", "other"] as const) {
    if (outcome === "a usable response") {
      assert.deepEqual(autoMatches(result, name), [matched], `${name} receives the shared match`);
      assert.deepEqual(crosswalkIssues(result, name), []);
    } else {
      assert.deepEqual(autoMatches(result, name), [], `${name} grants no coverage`);
      assert.ok(missingKeys(result, name).includes("TVDB:301"));
      assert.match(crosswalkIssues(result, name)[0], /^301: .*TMDB request failed.*remains in missing results/, `${name} explains the shared failure`);
    }
  }
});

test("shared evidence is a provider relationship: each comparison decides ownership against current inventory", async t => {
  const { rerun, requests, owned, save, setFlags } = await sharedDayOne(t);
  await rerun();

  // Plex no longer owns TMDB 9001: the shared same-day match is reused but covers nothing.
  owned.splice(owned.indexOf(tmdb1), 1);
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  requests.length = 0;
  const removed = await rerun();
  assert.deepEqual(sharedFinds(requests), [], "no lookup is repeated");
  for (const name of ["target", "other"] as const) {
    assert.deepEqual(autoMatches(removed, name), []);
    assert.ok(missingKeys(removed, name).includes("TVDB:301"), `${name}: TVDB 301 is missing without the owned episode`);
  }

  // Owning it again restores coverage from the same shared response.
  owned.push(tmdb1);
  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  requests.length = 0;
  const restored = await rerun();
  assert.deepEqual(sharedFinds(requests), []);
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(restored, name), [matched]);

  // Report Missing outranks the coverage the shared match establishes.
  const saved = await save([tmdb1, tvdb1]);
  assert.ok(saved.ok, await saved.clone().text());
  await setFlags((await saved.json()).mapping.id, [tvdb1]);
  t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
  requests.length = 0;
  const reported = await rerun();
  assert.deepEqual(sharedFinds(requests), []);
  assert.ok(missingKeys(reported, "target").includes("TVDB:301"), "the reported-missing episode stays in Target's missing results");
});

test("undated legacy crosswalks are refreshed once for every show that needs them", async t => {
  const { rerun, requests, restart, writeUndatedRelationships } = await sharedDayOne(t);
  await rerun();
  writeUndatedRelationships();
  restart();
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  requests.length = 0;
  const upgraded = await rerun();
  assert.deepEqual(sharedFinds(requests), ["/3/find/301", "/3/find/302", "/3/find/303", "/3/find/311"]);
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(upgraded, name), [matched]);
});

test("a single-show rescan replaces the shared answer, and its failure rejects it for other shows, offline rechecks and restart", async t => {
  const { rerun, state, requests, restart, save, setFlags, status } = await sharedDayOne(t);
  await rerun();

  // TMDB removes the external ID. Rescanning Target forces the lookup and replaces the shared answer.
  state.bodies.set("/3/find/301", empty);
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  requests.length = 0;
  const rescanned = await rerun("ratingKey:target");
  assert.deepEqual(sharedFinds(requests), ["/3/find/301", "/3/find/302", "/3/find/303"], "the rescan forces Target's lookups");
  assert.deepEqual(autoMatches(rescanned, "target"), []);
  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  requests.length = 0;
  const ordinary = await rerun();
  assert.deepEqual(sharedFinds(requests), [], "the ordinary scan reuses the replaced answer");
  assert.deepEqual(autoMatches(ordinary, "other"), [], "Other does not recover its old copy of the match");
  assert.ok(missingKeys(ordinary, "other").includes("TVDB:301"));
  assert.deepEqual(crosswalkIssues(ordinary, "other"), [], "a valid empty answer is not a Coverage Issue");

  // TMDB restores the match; a rescan shares it again.
  state.bodies.set("/3/find/301", found(tmdb1));
  t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
  await rerun("ratingKey:target");
  t.mock.timers.setTime(Date.parse("2026-11-12T13:30:00Z"));
  requests.length = 0;
  assert.deepEqual(autoMatches(await rerun(), "other"), [matched]);
  assert.deepEqual(sharedFinds(requests), []);

  // A rescan of Target whose lookup fails rejects the shared answer: Other's offline recheck,
  // before and after restart, makes no request and grants no coverage from its saved copy.
  state.statuses.set("/3/find/301", 404);
  t.mock.timers.setTime(Date.parse("2026-11-12T14:00:00Z"));
  const failed = await rerun("ratingKey:target");
  assert.match(crosswalkIssues(failed, "target")[0], /^301: .*TMDB request failed/);
  const unrelated = await save([tmdb3, tvdb3]);
  assert.ok(unrelated.ok, await unrelated.clone().text());
  const mappingId = (await unrelated.json()).mapping.id as string;
  for (const restarting of [false, true]) {
    if (restarting) { restart(); await setFlags(mappingId, [tvdb3]); }
    requests.length = 0;
    const rechecked = await settled(status);
    assert.deepEqual([...requests], [], "the cached recheck stays offline");
    assert.deepEqual(autoMatches(rechecked, "other"), [], "the rejected shared answer is not revived from Other's saved copy");
    assert.ok(missingKeys(rechecked, "other").includes("TVDB:301"));
    assert.match(crosswalkIssues(rechecked, "other")[0], /^301: .*not available to the offline recheck/);
  }

  // A complete-set Manual Match still covers TVDB 301 offline, independently of the rejected answer.
  const manual = await save([tmdb1, tvdb1]);
  assert.ok(manual.ok, await manual.clone().text());
  requests.length = 0;
  const covered = await settled(status);
  assert.deepEqual([...requests], []);
  assert.ok(!missingKeys(covered, "other").includes("TVDB:301"), "independent Manual Match coverage is usable offline");
  assert.deepEqual(autoMatches(covered, "other"), []);
  assert.match(crosswalkIssues(covered, "other")[0], /^301: .*Manual Match established coverage for this episode, so it remains collected; this failed check is still unresolved/);

  // A same-day retry recovers: one request serves both shows' retries and clears their causes.
  state.statuses.delete("/3/find/301");
  t.mock.timers.setTime(Date.parse("2026-11-12T15:00:00Z"));
  requests.length = 0;
  const recovered = await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"]);
  for (const name of ["target", "other"] as const) {
    assert.deepEqual(autoMatches(recovered, name), [matched]);
    assert.deepEqual(crosswalkIssues(recovered, name), []);
  }
});

test("a failed shared refresh grants no coverage to any show and is retried the same day", async t => {
  const { rerun, state, requests } = await sharedDayOne(t);
  await rerun();
  state.statuses.set("/3/find/301", 404);
  for (const time of ["2026-11-13T09:00:00Z", "2026-11-13T10:00:00Z"]) {
    t.mock.timers.setTime(Date.parse(time));
    requests.length = 0;
    const failed = await rerun();
    assert.ok(requests.includes("/3/find/301"), `${time}: the failed lookup is requested again`);
    for (const name of ["target", "other"] as const) {
      assert.deepEqual(autoMatches(failed, name), [], `${time}: ${name} grants no coverage from the expired answer`);
      assert.match(crosswalkIssues(failed, name)[0], /^301: .*TMDB request failed.*remains in missing results/);
    }
  }
  state.statuses.delete("/3/find/301");
  t.mock.timers.setTime(Date.parse("2026-11-13T11:00:00Z"));
  requests.length = 0;
  const recovered = await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "one retry serves both shows");
  for (const name of ["target", "other"] as const) {
    assert.deepEqual(autoMatches(recovered, name), [matched]);
    assert.deepEqual(crosswalkIssues(recovered, name), []);
  }
});

test("clearing one show's cache and provider-change invalidation replace the shared answer without invalidating unrelated evidence", async t => {
  const { rerun, clearCache, state, requests } = await sharedDayOne(t);
  await rerun();

  // Clearing Target's cache forces its lookup; Other cannot keep the old shared match.
  state.bodies.set("/3/find/301", empty);
  await clearCache("ratingKey:target");
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  requests.length = 0;
  const cleared = await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"]);
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(cleared, name), [], `${name} uses the replaced answer`);
  assert.ok(!requests.includes("/3/find/311"), "Other's unrelated lookup is still reused");
  assert.ok(!requests.includes("/v4/series/21/episodes/default") && !requests.includes("/3/tv/11/season/1"), "Other's catalogues are not downloaded again");

  // Other lists TMDB show 10 as an alias found through the crosswalk, so a TMDB change to show 10
  // invalidates Other's TMDB relationships (Target defers it: its catalogue was downloaded today).
  // Other's forced lookup replaces the shared answer.
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/tv/changes", { results: [{ id: 10 }], total_pages: 1 });
  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  requests.length = 0;
  const changed = await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "provider-change invalidation forces the lookup");
  assert.ok(!requests.includes("/v4/series/21/episodes/default"), "Other's TVDB catalogue is not downloaded again");
  assert.deepEqual(autoMatches(changed, "other"), [matched]);
  state.bodies.delete("/3/tv/changes");
  t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
  requests.length = 0;
  const later = await rerun();
  // Target's ordinary lookup reuses the replaced answer instead of its own saved empty copy.
  // Other's stays forced while the change to show 10 is deferred, as before.
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"]);
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(later, name), [matched]);
});

/** Saves an unrelated Manual Match, which runs an offline recheck; returns its mapping ID. */
async function saveUnrelatedMatch(save: (members: Episode[]) => Promise<Response>) {
  const unrelated = await save([tmdb3, tvdb3]);
  assert.ok(unrelated.ok, await unrelated.clone().text());
  return (await unrelated.json()).mapping.id as string;
}

test("an offline recheck replays a later shared outcome instead of its older copy, so a rejected and then replaced answer is never revived", async t => {
  const { rerun, state, requests, restart, save, setFlags, status } = await sharedDayOne(t);
  await rerun();

  // Day two: a single-show rescan of Target fails, rejecting the shared answer; a second rescan
  // receives a valid empty answer that replaces the rejection. Other keeps its day-one copy.
  state.statuses.set("/3/find/301", 404);
  t.mock.timers.setTime(Date.parse("2026-11-13T09:00:00Z"));
  await rerun("ratingKey:target");
  state.statuses.delete("/3/find/301");
  state.bodies.set("/3/find/301", empty);
  t.mock.timers.setTime(Date.parse("2026-11-13T10:00:00Z"));
  assert.deepEqual(autoMatches(await rerun("ratingKey:target"), "target"), []);

  const mappingId = await saveUnrelatedMatch(save);
  for (const restarting of [false, true]) {
    if (restarting) { restart(); await setFlags(mappingId, [tvdb3]); }
    requests.length = 0;
    const rechecked = await settled(status);
    assert.deepEqual([...requests], [], "the cached recheck stays offline");
    assert.deepEqual(autoMatches(rechecked, "other"), [], "Other's older copy of the match is not revived");
    assert.ok(missingKeys(rechecked, "other").includes("TVDB:301"));
    assert.deepEqual(crosswalkIssues(rechecked, "other"), [], "the replayed valid empty answer is not a Coverage Issue");
  }

  // The replayed answer kept its original receipt time: later that day it is reused, the next day refreshed.
  t.mock.timers.setTime(Date.parse("2026-11-13T11:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), []);
  t.mock.timers.setTime(Date.parse("2026-11-14T00:00:01Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"]);
});

for (const failure of ["a failed request", "an unreadable response"] as const) test(`clearing one show's cache keeps a rejection by ${failure} that other shows' offline rechecks depend on`, async t => {
  const { rerun, state, requests, clearCache, save, status } = await sharedDayOne(t);
  await rerun();

  // Target's forced refresh fails, rejecting the shared answer; then the user clears Target.
  if (failure === "a failed request") state.statuses.set("/3/find/301", 404);
  else state.bodies.set("/3/find/301", { tv_episode_results: "unreadable" });
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  const failed = await rerun("ratingKey:target");
  assert.match(crosswalkIssues(failed, "target")[0], failure === "a failed request" ? /^301: .*TMDB request failed/ : /^301: /);
  assert.deepEqual(autoMatches(failed, "target"), []);
  await clearCache("ratingKey:target");

  await saveUnrelatedMatch(save);
  requests.length = 0;
  const rechecked = await settled(status);
  assert.deepEqual([...requests], [], "the cached recheck stays offline");
  assert.deepEqual(autoMatches(rechecked, "other"), [], "the rejected answer is not revived from Other's saved copy");
  assert.ok(missingKeys(rechecked, "other").includes("TVDB:301"));

  // An independent complete-set Manual Match still covers TVDB 301 offline.
  const manual = await save([tmdb1, tvdb1]);
  assert.ok(manual.ok, await manual.clone().text());
  requests.length = 0;
  const covered = await settled(status);
  assert.deepEqual([...requests], []);
  assert.ok(!missingKeys(covered, "other").includes("TVDB:301"));
});

test("clearing one show's cache after its rescan replaced the shared answer does not let other shows' offline rechecks revive their older copy", async t => {
  const { rerun, state, requests, restart, clearCache, save, setFlags, status } = await sharedDayOne(t);
  await rerun();

  // Target's rescan replaces the shared match with a valid empty answer; then Target is cleared.
  state.bodies.set("/3/find/301", empty);
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  assert.deepEqual(autoMatches(await rerun("ratingKey:target"), "target"), []);
  await clearCache("ratingKey:target");

  const mappingId = await saveUnrelatedMatch(save);
  for (const restarting of [false, true]) {
    if (restarting) { restart(); await setFlags(mappingId, [tvdb3]); }
    requests.length = 0;
    const rechecked = await settled(status);
    assert.deepEqual([...requests], [], "the cached recheck stays offline");
    assert.deepEqual(autoMatches(rechecked, "other"), [], "Other's older copy of the match is not revived");
    assert.ok(missingKeys(rechecked, "other").includes("TVDB:301"));
  }

  // The cleared answer is never reused live: the next scan requests it once for both shows.
  state.bodies.set("/3/find/301", found(tmdb1));
  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  requests.length = 0;
  const live = await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"]);
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(live, name), [matched]);
  t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), [], "the new answer is current again");
});

test("a rejection from another show's ordinary next-day refresh stops Other's offline recheck before and after restart", async t => {
  const { rerun, state, requests, restart, save, setFlags, status } = await sharedDayOne(t);
  await rerun();

  // Day two: Other's Plex metadata is unavailable, so its last-good comparison (and its day-one
  // copy of the match) is retained without reaching the lookup; Target's ordinary refresh fails.
  state.statuses.set("/3/find/301", 404);
  state.statuses.set("/library/metadata/other", 404);
  t.mock.timers.setTime(Date.parse("2026-11-13T09:00:00Z"));
  requests.length = 0;
  const failed = await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "only Target requested the lookup");
  assert.match(crosswalkIssues(failed, "target")[0], /^301: .*TMDB request failed/);
  state.statuses.delete("/library/metadata/other");

  const mappingId = await saveUnrelatedMatch(save);
  for (const restarting of [false, true]) {
    if (restarting) { restart(); await setFlags(mappingId, [tvdb3]); }
    requests.length = 0;
    const rechecked = await settled(status);
    assert.deepEqual([...requests], [], "the cached recheck stays offline");
    assert.deepEqual(autoMatches(rechecked, "other"), [], "the rejected answer is not revived from Other's saved copy");
    assert.ok(missingKeys(rechecked, "other").includes("TVDB:301"));
    assert.match(crosswalkIssues(rechecked, "other")[0], /^301: .*not available to the offline recheck/);
  }

  const manual = await save([tmdb1, tvdb1]);
  assert.ok(manual.ok, await manual.clone().text());
  requests.length = 0;
  const covered = await settled(status);
  assert.deepEqual([...requests], []);
  assert.ok(!missingKeys(covered, "other").includes("TVDB:301"), "independent Manual Match coverage is usable offline");
});

test("a forced retry and another show's ordinary lookup of the same episode share one in-flight request", async t => {
  const { rerun, state, requests } = await sharedDayOne(t);
  await rerun();
  // Target's failed rescan records a failed crosswalk, so its next lookup is a forced retry.
  state.statuses.set("/3/find/301", 404);
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  await rerun("ratingKey:target");
  state.statuses.delete("/3/find/301");

  let release!: () => void;
  state.hold.set("/3/find/301", new Promise<void>(resolve => { release = resolve; }));
  state.onRequest = pathname => { if (pathname === "/3/find/301") setTimeout(release, 50); };
  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  requests.length = 0;
  const result = await rerun();
  state.onRequest = undefined;
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "exactly one request serves both lookups");
  for (const name of ["target", "other"] as const) {
    assert.deepEqual(autoMatches(result, name), [matched], `${name} receives the shared result`);
    assert.deepEqual(crosswalkIssues(result, name), []);
  }
});

test("same-day reuse during a scan that crosses UTC midnight does not renew the shared receipt time", async t => {
  const { rerun, state, requests } = await sharedDayOne(t);
  await rerun();
  // A scan starting on 2026-11-12 reuses the 2026-11-12 answer after the clock passes midnight.
  t.mock.timers.setTime(Date.parse("2026-11-12T23:59:58Z"));
  state.onRequest = pathname => { if (pathname.startsWith("/library/metadata/")) t.mock.timers.setTime(Date.parse("2026-11-13T00:00:05Z")); };
  requests.length = 0;
  const crossing = await rerun();
  state.onRequest = undefined;
  assert.deepEqual(sharedFinds(requests), [], "the scan's starting UTC date makes the answer current");
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(crossing, name), [matched]);

  // Had reuse renewed it, the answer would look received on 2026-11-13 and be reused today.
  t.mock.timers.setTime(Date.parse("2026-11-13T08:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "the answer received on 2026-11-12 is refreshed once");
});

for (const restarting of [false, true]) test(`an offline recheck adopts a shared answer recovered after its own failed lookup${restarting ? ", across restart" : ""}`, async t => {
  const { rerun, state, requests, restart, save, status } = await sharedDayOne(t);
  await rerun();

  // Other's rescan fails, leaving it no saved copy and a failed check; Target's later rescan
  // receives a usable answer, which replaces the shared rejection.
  state.statuses.set("/3/find/301", 404);
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  const failed = await rerun("ratingKey:other");
  assert.deepEqual(autoMatches(failed, "other"), []);
  assert.match(crosswalkIssues(failed, "other")[0], /^301: .*TMDB request failed/);
  state.statuses.delete("/3/find/301");
  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  assert.deepEqual(autoMatches(await rerun("ratingKey:target"), "target"), [matched]);

  if (restarting) restart();
  await saveUnrelatedMatch(save);
  requests.length = 0;
  const rechecked = await settled(status);
  assert.deepEqual([...requests], [], "the cached recheck stays offline");
  assert.deepEqual(autoMatches(rechecked, "other"), [matched], "Other adopts the recovered shared answer");
  assert.ok(!missingKeys(rechecked, "other").includes("TVDB:301"), "TVDB 301 is covered");
  assert.deepEqual(crosswalkIssues(rechecked, "other"), [], "the usable answer to this lookup resolves Other's failed check");

  // The adopted answer kept its original receipt time: reused later that day, refreshed the next.
  t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
  requests.length = 0;
  assert.deepEqual(autoMatches(await rerun(), "other"), [matched]);
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), []);
  t.mock.timers.setTime(Date.parse("2026-11-13T00:00:01Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(requests.filter(path => path === "/3/find/301"), ["/3/find/301"]);
});
