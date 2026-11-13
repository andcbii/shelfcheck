import assert from "node:assert/strict";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

// A failed required refresh of an expired TMDB external-ID crosswalk (episode crosswalk
// freshness, GLOSSARY) rejects the old response: it grants no coverage in that live scan,
// after restart or in an offline Manual Match recheck, even when the show's last-good
// comparison is otherwise retained because a provider catalogue download failed.

type Issue = { id: string; operation: string; provider?: string; cause: string; impacts?: string[]; episode?: { id?: number } };
type AutoMatch = { method: string; tmdb: { id?: number }; tvdb: { id?: number } };
type Result = { report: { shows: { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[]; autoMatches?: AutoMatch[] }[] }; coverage: { issues: Issue[]; pending?: unknown } };
const target = (result: unknown) => (result as Result).report.shows.find(show => show.ratingKey === "ratingKey:target")!;
const missingKeys = (result: unknown) => target(result).missing.flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
const autoMatches = (result: unknown) => (target(result).autoMatches || []).map(match => `${match.method}: TVDB ${match.tvdb.id} = TMDB ${match.tmdb.id}`).sort();
const issuesOf = (result: unknown) => (result as Result).coverage.issues;
/** Each failed TMDB crosswalk check of one TVDB episode, with its cause and impact on that episode. */
const crosswalkIssues = (result: unknown) => issuesOf(result).filter(issue => issue.provider === "TMDB" && issue.episode?.id && ["episode-crosswalk", "episode-identity"].includes(issue.operation)).map(issue => `${issue.episode!.id}: ${issue.cause} ${(issue.impacts || []).join(" ")}`).sort();
const crosswalkFinds = (requests: string[]) => requests.filter(pathname => /^\/3\/find\/30\d$/.test(pathname)).sort();
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const empty = { tv_results: [], tv_episode_results: [] };
const settled = async (status: () => Promise<unknown>) => {
  let result = await status();
  for (let i = 0; i < 100 && (result as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await status(); }
  return result;
};

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so each TVDB episode
// reaches the TMDB external-ID crosswalk unless an earlier method covers it.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const tvdbCatalogue = "/v4/series/20/episodes/default";

/** Day one: both crosswalks match an owned TMDB episode; TMDB 9003 / TVDB 303 are not owned. */
async function matchedOnDayOne(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00Z") });
  const h = await harness(t, [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3], [tmdb1, tmdb2]);
  h.state.bodies.set("/3/find/301", found(tmdb1));
  h.state.bodies.set("/3/find/302", found(tmdb2));
  const first = await h.rerun();
  assert.deepEqual(missingKeys(first), ["TMDB:9003", "TVDB:303"]);
  assert.deepEqual(autoMatches(first), ["Matched via TMDB External ID: TVDB 301 = TMDB 9001", "Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);
  return h;
}

/** On the next UTC day TVDB reports the series changed, but its catalogue download fails. */
function failTvdbCatalogueDownload(h: Awaited<ReturnType<typeof harness>>) {
  h.state.tvdbChanged = [20];
  h.state.statuses.set(tvdbCatalogue, 404);
}

for (const catalogueFails of [true, false]) test(`a rejected crosswalk refresh${catalogueFails ? " during a scan whose catalogue download failed" : ""} is not revived by offline rechecks before or after restart`, async t => {
  const h = await matchedOnDayOne(t);
  const { rerun, state, requests, restart, save, status } = h;

  // Day two: TMDB rejects TVDB 301's expired crosswalk refresh (and, in one variant, the TVDB
  // catalogue download fails so the last-good comparison is retained); TVDB 302's refresh succeeds.
  if (catalogueFails) failTvdbCatalogueDownload(h);
  state.statuses.set("/3/find/301", 404);
  t.mock.timers.setTime(Date.parse("2026-11-13T12:00:00Z"));
  requests.length = 0;
  const failed = await rerun();
  if (catalogueFails) {
    assert.ok(requests.includes(tvdbCatalogue), "the changed TVDB catalogue was requested");
    assert.ok(issuesOf(failed).some(issue => issue.id === "catalogue-refresh:TVDB:ratingKey:target"), "the failed catalogue download is reported");
  }
  assert.deepEqual(crosswalkFinds(requests), ["/3/find/301", "/3/find/302", "/3/find/303"], "every needed expired crosswalk is requested");
  assert.deepEqual(missingKeys(failed), ["TMDB:9003", "TVDB:301", "TVDB:303"], "the rejected old match grants no coverage");
  assert.deepEqual(autoMatches(failed), ["Matched via TMDB External ID: TVDB 302 = TMDB 9002"], "the sibling's fresh match remains usable");
  assert.equal(crosswalkIssues(failed).length, 1);
  assert.match(crosswalkIssues(failed)[0], /^301: .*TMDB request failed.*No other method established coverage, so this episode remains in missing results/);

  // An offline Manual Match recheck before restart does not revive the rejected answer.
  const unrelated = await save([tmdb3, tvdb3]);
  assert.ok(unrelated.ok, await unrelated.clone().text());
  requests.length = 0;
  const before = await settled(status);
  assert.deepEqual([...requests], [], "the cached recheck stays offline");
  assert.deepEqual(missingKeys(before), ["TMDB:9003", "TVDB:301", "TVDB:303"]);
  assert.deepEqual(autoMatches(before), ["Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);
  assert.match(crosswalkIssues(before)[0], /^301: .*TMDB request failed.*remains in missing results/, "the failed check is retained");

  // After restart, a complete-set Manual Match covers TVDB 301 offline without marking its crosswalk recovered.
  restart();
  const manual = await save([tmdb1, tvdb1]);
  assert.ok(manual.ok, await manual.clone().text());
  requests.length = 0;
  const after = await settled(status);
  assert.deepEqual([...requests], [], "the cached recheck stays offline after restart");
  assert.deepEqual(missingKeys(after), ["TMDB:9003", "TVDB:303"], "independent Manual Match coverage is usable offline");
  assert.deepEqual(autoMatches(after), ["Matched via TMDB External ID: TVDB 302 = TMDB 9002"], "the rejected match is not revived");
  assert.match(crosswalkIssues(after)[0], /^301: .*TMDB request failed.*Manual Match established coverage for this episode, so it remains collected; this failed check is still unresolved/);

  // The offline rechecks renewed nothing: the next same-day live scan retries only the failed
  // lookup, reusing TVDB 302's fresh response, and a valid empty answer resolves only that cause.
  state.statuses.delete("/3/find/301");
  state.bodies.set("/3/find/301", empty);
  t.mock.timers.setTime(Date.parse("2026-11-13T15:00:00Z"));
  requests.length = 0;
  const retried = await rerun();
  assert.deepEqual(crosswalkFinds(requests), ["/3/find/301"], "only the failed crosswalk is requested again");
  assert.deepEqual(missingKeys(retried), ["TMDB:9003", "TVDB:303"]);
  assert.deepEqual(autoMatches(retried), ["Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);
  assert.deepEqual(crosswalkIssues(retried), [], "a valid empty answer is not a Coverage Issue");
});

const unreadablePayloads: { kind: string; serve: (h: Awaited<ReturnType<typeof harness>>) => void; cause: RegExp }[] = [
  { kind: "a successful response of the wrong shape", serve: h => h.state.bodies.set("/3/find/301", { tv_episode_results: {} }), cause: /could not be interpreted/ },
  { kind: "a successful response that is not JSON", serve: h => h.state.raw.set("/3/find/301", "<html>maintenance</html>"), cause: /unreadable/ },
];
for (const payload of unreadablePayloads) test(`an expired crosswalk refreshed with ${payload.kind} grants nothing, is retried the same day and stays rejected across offline rechecks and restart`, async t => {
  const h = await matchedOnDayOne(t);
  const { rerun, state, requests, restart, save, setFlags, status } = h;

  // Day two: the TVDB catalogue download fails and TMDB answers TVDB 301's refresh unreadably.
  failTvdbCatalogueDownload(h);
  payload.serve(h);
  for (const time of ["2026-11-13T12:00:00Z", "2026-11-13T13:00:00Z"]) {
    t.mock.timers.setTime(Date.parse(time));
    requests.length = 0;
    const unreadable = await rerun();
    assert.ok(requests.includes("/3/find/301"), `${time}: the unreadable response is requested again`);
    assert.deepEqual(missingKeys(unreadable), ["TMDB:9003", "TVDB:301", "TVDB:303"], `${time}: the old match is not used`);
    assert.deepEqual(autoMatches(unreadable), ["Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);
    assert.equal(crosswalkIssues(unreadable).length, 1);
    assert.match(crosswalkIssues(unreadable)[0], /^301: .*remains in missing results/);
    assert.match(crosswalkIssues(unreadable)[0], payload.cause, "a failed check, not a confirmed no-match");
  }

  // Offline rechecks before and after restart keep the failure and make no requests.
  const saved = await save([tmdb3, tvdb3]);
  assert.ok(saved.ok, await saved.clone().text());
  const { mapping } = await saved.json() as { mapping: { id: string } };
  for (const restarting of [false, true]) {
    if (restarting) {
      restart();
      await setFlags(mapping.id, [tvdb3]);
    }
    requests.length = 0;
    const rechecked = await settled(status);
    assert.deepEqual([...requests], [], "the cached recheck stays offline");
    assert.deepEqual(missingKeys(rechecked), ["TMDB:9003", "TVDB:301", "TVDB:303"]);
    assert.deepEqual(autoMatches(rechecked), ["Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);
    assert.match(crosswalkIssues(rechecked)[0], /^301: .*remains in missing results/);
    assert.match(crosswalkIssues(rechecked)[0], payload.cause, "the failed check is retained");
  }

  // A later same-day scan whose response is usable and owned collects the episode and clears only that cause.
  state.raw.delete("/3/find/301");
  state.bodies.set("/3/find/301", found(tmdb1));
  t.mock.timers.setTime(Date.parse("2026-11-13T16:00:00Z"));
  requests.length = 0;
  const recovered = await rerun();
  assert.deepEqual(crosswalkFinds(requests), ["/3/find/301"]);
  assert.deepEqual(missingKeys(recovered), ["TMDB:9003", "TVDB:303"]);
  assert.deepEqual(autoMatches(recovered), ["Matched via TMDB External ID: TVDB 301 = TMDB 9001", "Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);
  assert.deepEqual(crosswalkIssues(recovered), []);
  assert.ok(issuesOf(recovered).some(issue => issue.id === "catalogue-refresh:TVDB:ratingKey:target"), "the unrelated catalogue failure stays unresolved");
});
