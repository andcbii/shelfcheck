import assert from "node:assert/strict";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

// Unresolved episode recovery is retried on later user-requested scans that include
// the show, even when its provider catalogue is reused, and only where it is needed.

type Issue = { id: string; operation: string; cause: string; impacts?: string[] };
type Result = { coverage: { issues: Issue[]; pending?: unknown }; report: { shows: { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[] }[] } };
const episodeIssues = (result: unknown) => (result as Result).coverage.issues.filter(issue => issue.id.startsWith("episode-check:")).map(issue => issue.id).sort();
const currentIssues = (result: unknown) => (result as Result).coverage.issues.map(issue => issue.id).sort();
const missingKeys = (result: unknown) => ((result as Result).report.shows.find(item => item.ratingKey === "ratingKey:target")?.missing || []).flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
const translations = (requests: string[]) => requests.filter(path => path.includes("/translations/")).sort();
const downloads = (requests: string[]) => requests.filter(path => /\/season\/\d+$|\/episodes\/default$/.test(path)).sort();

// An owned double-length TMDB episode split into two TVDB episodes; the second part's
// default title is missing, so the combined/split check needs its English title.
const combined: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "Arrival", airDate: "2020-01-01", runtime: 48 };
const unowned: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Second", airDate: "2020-01-08", runtime: 24 };
const finale: Episode = { provider: "TMDB", id: 9006, season: 1, episode: 6, name: "Finale", airDate: "2020-02-01", runtime: 24 };
const part1: Episode = { provider: "TVDB", id: 101, season: 1, episode: 1, name: "Arrival (1)", airDate: "2020-01-01", runtime: 24 };
const part2: Episode = { provider: "TVDB", id: 102, season: 1, episode: 2, name: null, airDate: "2020-01-01", runtime: 24 };
// Untitled (as upcoming episodes often are) but no check needs its title while Finale is not owned.
const untitled: Episode = { provider: "TVDB", id: 105, season: 1, episode: 5, name: null, airDate: "2020-02-01", runtime: 24 };
const part2Check = "episode-check:ratingKey:target:compound-matching:TVDB:102";
const untitledCheck = "episode-check:ratingKey:target:compound-matching:TVDB:105";

test("an English title answered as unavailable is requested again only on scans where a title-dependent check needs it", async t => {
  const owned = [combined];
  const { rerun, state, requests } = await harness(t, [combined, unowned, finale, part1, part2, untitled], owned);
  const first = await rerun();
  assert.deepEqual(translations(requests), ["/v4/episodes/102/translations/eng", "/v4/episodes/105/translations/eng"], "every untitled episode is tried once");
  assert.deepEqual(episodeIssues(first), [part2Check]);
  assert.deepEqual(missingKeys(first), ["TMDB:9002", "TMDB:9006", "TVDB:102", "TVDB:105"]);

  // Same-day rescan reuses the catalogues: only the blocked check's title is requested again.
  let before = requests.length;
  const second = await rerun();
  assert.deepEqual(translations(requests.slice(before)), ["/v4/episodes/102/translations/eng"]);
  assert.deepEqual(downloads(requests.slice(before)), [], "no catalogue download");
  assert.deepEqual(episodeIssues(second), [part2Check], "repeated failure keeps one cause");

  // Owning Finale makes the untitled episode's title needed: the same scan asks TVDB again
  // before explaining the blocked check, even though the catalogue is reused.
  owned.push(finale);
  before = requests.length;
  const needed = await rerun();
  assert.deepEqual(translations(requests.slice(before)), ["/v4/episodes/102/translations/eng", "/v4/episodes/105/translations/eng"]);
  assert.deepEqual(downloads(requests.slice(before)), [], "no catalogue download");
  assert.deepEqual(episodeIssues(needed), [part2Check, untitledCheck]);
  assert.match((needed as unknown as Result).coverage.issues.find(issue => issue.id === untitledCheck)!.cause, /no usable default or English title/);

  // TVDB adds both English titles: each is recovered, the checks complete and their causes clear.
  state.english.set(102, "Arrival (2)");
  state.english.set(105, "Finale");
  before = requests.length;
  const repaired = await rerun();
  assert.deepEqual(translations(requests.slice(before)), ["/v4/episodes/102/translations/eng", "/v4/episodes/105/translations/eng"]);
  assert.deepEqual(downloads(requests.slice(before)), []);
  assert.deepEqual(episodeIssues(repaired), []);
  assert.deepEqual(missingKeys(repaired), ["TMDB:9002", "TVDB:105"], "the recovered title completes the split match");

  // Recovered titles are reused without repeating the translation requests.
  before = requests.length;
  await rerun();
  assert.deepEqual(translations(requests.slice(before)), []);
});

// The English title request and the TMDB crosswalk of the untitled split part both fail.
// The dependent combined/split check and the crosswalk are grouped under their failed requests.
const recovery = "episode-check:ratingKey:target:title-recovery:TVDB:102";
const crosswalkRequest = "episode-identity:ratingKey:target:TMDB:https://api.themoviedb.org/3/find/102?external_source=tvdb_id";
const unresolved = [crosswalkRequest, recovery].sort();
const providerRequests = (requests: string[]) => requests.filter(path => !path.startsWith("/library/") && !["/3/tv/changes", "/v4/updates", "/v4/login"].includes(path)).sort();
async function failingRecovery(t: test.TestContext) {
  const fixture = await harness(t, [combined, unowned, part1, part2], [combined]);
  fixture.state.statuses.set("/v4/episodes/102/translations/eng", 403);
  fixture.state.statuses.set("/3/find/102", 404);
  return fixture;
}

test("unresolved episode recovery survives restart, is retried narrowly on reused catalogues and clears only after repair", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-11T12:00:00Z") });
  const day = 86400_000;
  const { rerun, state, requests, restart, status } = await failingRecovery(t);
  const first = await rerun();
  assert.deepEqual(downloads(requests), ["/3/tv/10/season/1", "/v4/series/20/episodes/default"]);
  assert.deepEqual(currentIssues(first), unresolved);
  assert.deepEqual(missingKeys(first), ["TMDB:9002", "TVDB:102"]);

  // Next day, with the catalogues reused: only the failed episode lookups are requested again.
  t.mock.timers.tick(day);
  let before = requests.length;
  const retried = await rerun();
  assert.deepEqual(providerRequests(requests.slice(before)), ["/3/find/102", "/v4/episodes/102/translations/eng"], "no catalogue download or unrelated provider refresh");
  assert.deepEqual(currentIssues(retried), unresolved, "repeated failures keep one cause each");

  // Restart preserves the pending recovery; the next scan retries it again.
  restart();
  assert.deepEqual(currentIssues(await status()), unresolved);
  t.mock.timers.tick(day);
  before = requests.length;
  assert.deepEqual(currentIssues(await rerun()), unresolved);
  assert.deepEqual(providerRequests(requests.slice(before)), ["/3/find/102", "/v4/episodes/102/translations/eng"]);

  // TVDB and TMDB recover: each repaired cause clears and the split match completes.
  state.statuses.clear();
  state.english.set(102, "Arrival (2)");
  t.mock.timers.tick(day);
  before = requests.length;
  const repaired = await rerun();
  assert.deepEqual(providerRequests(requests.slice(before)), ["/3/find/102", "/v4/episodes/102/translations/eng"]);
  assert.deepEqual(currentIssues(repaired), []);
  assert.deepEqual(missingKeys(repaired), ["TMDB:9002"]);

  // Successful recovery is saved and reused after restart without repeating its requests.
  restart();
  t.mock.timers.tick(day);
  before = requests.length;
  const reused = await rerun();
  assert.deepEqual(providerRequests(requests.slice(before)), []);
  assert.deepEqual(currentIssues(reused), []);
  assert.deepEqual(missingKeys(reused), ["TMDB:9002"]);

  // Recovering one title is not a catalogue download: the TVDB catalogue still ages from its first download.
  t.mock.timers.tick(55 * day);
  before = requests.length;
  await rerun();
  assert.ok(!requests.slice(before).includes("/v4/series/20/episodes/default"), "day 59: still reused");
  t.mock.timers.tick(2 * day);
  before = requests.length;
  await rerun();
  assert.ok(requests.slice(before).includes("/v4/series/20/episodes/default"), "day 61: refreshed by age");
});

test("a cached Manual Match recheck neither consumes pending episode recovery nor clears it when it collects the episode", async t => {
  const { rerun, state, requests, save, status } = await failingRecovery(t);
  await rerun();
  const saved = await save([combined, part2]);
  assert.ok(saved.ok, await saved.clone().text());
  // Saving resolves the members; the recheck it queues is offline.
  let before = requests.length;
  let rechecked = await status();
  for (let i = 0; i < 100 && (rechecked as unknown as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); rechecked = await status(); }
  assert.deepEqual(requests.slice(before), [], "the cached recheck makes no requests");
  assert.deepEqual(missingKeys(rechecked), ["TMDB:9002"], "the Manual Match collects the episode");
  assert.deepEqual(currentIssues(rechecked), unresolved, "alternative ownership does not clear the failed checks");
  assert.match(JSON.stringify((rechecked as unknown as Result).coverage.issues), /A complete-set Manual Match established coverage for this episode, so it remains collected; this failed check is still unresolved\./);

  // The next scan still retries the recovery (alongside the Manual Match's own refresh obligation).
  before = requests.length;
  const retried = await rerun();
  assert.deepEqual(translations(requests.slice(before)), ["/v4/episodes/102/translations/eng"]);
  assert.ok(requests.slice(before).includes("/3/find/102"));
  assert.deepEqual(currentIssues(retried), unresolved);
  assert.deepEqual(missingKeys(retried), ["TMDB:9002"]);

  state.statuses.clear();
  state.english.set(102, "Arrival (2)");
  const repaired = await rerun();
  assert.deepEqual(currentIssues(repaired), [], "only repair clears the causes");
  assert.deepEqual(missingKeys(repaired), ["TMDB:9002"]);
});
