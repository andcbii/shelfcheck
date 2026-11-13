import assert from "node:assert/strict";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

// Episode-scoped failures (GLOSSARY) during combined/split evidence preparation
// must stay with the affected episode and its dependent relationships. The show
// comparison, its sibling episodes and independent matching methods continue.

type Issue = { id: string; operation: string; scope: string; category?: string; provider?: string; cause: string; action: string; impacts?: string[]; show?: { ratingKey?: string; title?: string; tmdbId?: number; tvdbId?: number }; episode?: { provider?: string; id?: number; showId?: number; season?: number; episode?: number } };
const issuesOf = (result: unknown) => (result as { coverage: { issues: Issue[] } }).coverage.issues;
const pending = (result: unknown) => Boolean((result as { coverage: { pending?: unknown } }).coverage.pending);
const episodeIssues = (result: unknown) => issuesOf(result).filter(issue => issue.id.startsWith("episode-check:"));

// Minimal sanitized Dragon Ball Z Kai records: an owned Plex/TMDB special S00E09
// (TMDB 1175909) shares its air date with TVDB special S00E08 (6003511), whose
// default TVDB title is null.
const tmdbSpecial: Episode = { provider: "TMDB", id: 1175909, season: 0, episode: 9, name: "Peace Returns! A Time of Rest for the Warriors!", airDate: "2010-04-05", runtime: 24 };
const tvdbSpecial: Episode = { provider: "TVDB", id: 6003511, season: 0, episode: 8, name: null, airDate: "2010-04-05", runtime: 24 };
// A double-length TMDB episode owned in Plex, split into two TVDB episodes.
const combined: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "Arrival", airDate: "2020-01-01", runtime: 48 };
const unownedTmdb: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Second", airDate: "2020-01-08", runtime: 24 };
const ownedTmdb: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Third", airDate: "2020-01-15", runtime: 24 };
const part1: Episode = { provider: "TVDB", id: 101, season: 1, episode: 1, name: "Arrival (1)", airDate: "2020-01-01", runtime: 24 };
const part2: Episode = { provider: "TVDB", id: 102, season: 1, episode: 2, name: "Arrival (2)", airDate: "2020-01-01", runtime: 24 };
const tvdbSecond: Episode = { provider: "TVDB", id: 103, season: 1, episode: 3, name: "Second", airDate: "2020-01-08", runtime: 24 };
const tvdbThird: Episode = { provider: "TVDB", id: 104, season: 1, episode: 4, name: "Third", airDate: "2020-01-15", runtime: 24 };

function catalogue(overrides: Partial<Record<number, Partial<Episode>>> = {}) {
  return [tmdbSpecial, tvdbSpecial, combined, unownedTmdb, ownedTmdb, part1, part2, tvdbSecond, tvdbThird].map(episode => ({ ...episode, ...overrides[episode.id] }));
}
const owned = [tmdbSpecial, combined, ownedTmdb];

test("a null provider title in combined/split evidence no longer aborts the show comparison (Dragon Ball Z Kai)", async t => {
  const { rerun } = await harness(t, catalogue(), owned);
  const result = await rerun();
  assert.deepEqual(issuesOf(result).filter(issue => issue.id.startsWith("comparison-failure:")), [], "no show-level comparison failure");
  const show = result.report.shows.find(item => item.ratingKey === "ratingKey:target")!;
  assert.ok(show, "the show comparison completed");
  // Unrelated siblings are still compared; the split parts of the owned combined episode are covered.
  assert.deepEqual(Object.keys(Object.fromEntries(show.missing.flatMap(episode => episode.sources.map(source => [`${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`, true])))).sort(), ["TMDB:9002", "TVDB:104"]);
  // The unresolved special's title is not needed by any required check, so no issue is raised for it.
  assert.deepEqual(episodeIssues(result), []);
});

const missingKeys = (result: { report: { shows: { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[] }[] } }) =>
  (result.report.shows.find(item => item.ratingKey === "ratingKey:target")?.missing || []).flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();

test("a split episode whose combined/split check fails stays missing, with one current episode issue explaining it", async t => {
  const { rerun, restart, status } = await harness(t, catalogue({ 102: { name: null } }), owned);
  const result = await rerun();
  // No guessed coverage for the unverifiable relationship; siblings still compared.
  assert.deepEqual(missingKeys(result), ["TMDB:9002", "TVDB:102", "TVDB:104"]);
  const [issue, ...others] = episodeIssues(result);
  assert.deepEqual(others, []);
  assert.equal(issue.scope, "episode");
  assert.equal(issue.category, "Episode Matching");
  assert.equal(issue.provider, "TVDB");
  assert.deepEqual(issue.show, { ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20 });
  assert.deepEqual(issue.episode, { provider: "TVDB", id: 102, showId: 20, season: 1, episode: 2 });
  assert.match(issue.cause, /Combined\/split episode matching could not be checked: TVDB returned no usable title for this episode\./);
  const impacts = issue.impacts!.join(" ");
  assert.match(impacts, /owned TMDB episode 9001 \(S01E01\)/);
  assert.match(impacts, /TVDB 101 \(S01E01\)/, "dependent relationship named");
  assert.match(impacts, /remains in missing results/);
  assert.doesNotMatch(JSON.stringify(issue), /network|request failed|toLowerCase/i, "a matching problem is not presented as a provider outage or a raw exception");

  // A repeated failure updates the same current cause.
  const again = await rerun();
  assert.deepEqual(episodeIssues(again).map(item => item.id), [issue.id]);
  restart();
  assert.deepEqual(episodeIssues(await status()).map(item => item.id), [issue.id], "the current cause survives restart");
});

test("repaired evidence completes the blocked check and clears only that show's episode cause", async t => {
  const otherCombined: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Begin", airDate: "2021-01-01", runtime: 48, show: "other" };
  const otherFiller: Episode = { provider: "TMDB", id: 9102, season: 1, episode: 3, name: "Next", airDate: "2021-01-08", runtime: 24, show: "other" };
  const otherPart1: Episode = { provider: "TVDB", id: 201, season: 1, episode: 1, name: "Begin (1)", airDate: "2021-01-01", runtime: 24, show: "other" };
  const otherPart2: Episode = { provider: "TVDB", id: 202, season: 1, episode: 2, name: null, airDate: "2021-01-01", runtime: 24, show: "other" };
  const episodes = [...catalogue({ 102: { name: null } }), otherCombined, otherFiller, otherPart1, otherPart2];
  const { rerun, state } = await harness(t, episodes, [...owned, otherCombined, otherFiller]);
  const failing = await rerun();
  assert.deepEqual(episodeIssues(failing).map(issue => issue.show?.ratingKey).sort(), ["ratingKey:other", "ratingKey:target"]);

  // The provider later supplies the title for Target's split episode only.
  episodes.find(episode => episode.id === 102)!.name = "Arrival (2)";
  state.tvdbChanged = [20];
  const repaired = await rerun();
  assert.deepEqual(missingKeys(repaired), ["TMDB:9002", "TVDB:104"], "the repaired relationship now covers the split episode");
  assert.deepEqual(episodeIssues(repaired).map(issue => `${issue.show?.ratingKey} ${issue.episode?.provider}:${issue.episode?.id}`), ["ratingKey:other TVDB:202"], "an unrelated unresolved cause is preserved");
});

test("a later direct ownership collects the episode but does not resolve its unrepaired failed check", async t => {
  const episodes = catalogue({ 102: { name: null } });
  const plex = [...owned];
  const { rerun, state } = await harness(t, episodes, plex);
  const [issue] = episodeIssues(await rerun());
  assert.equal(issue?.episode?.id, 102);

  // Plex now holds a file carrying TVDB episode 102's own identity (at unrelated Plex numbering).
  plex.push({ provider: "TVDB", id: 102, season: 9, episode: 9, name: null });
  const owning = await rerun();
  assert.ok(!missingKeys(owning).includes("TVDB:102"), "direct provider ownership collects the episode");
  const [retained, ...others] = episodeIssues(owning);
  assert.deepEqual(others, []);
  assert.equal(retained?.id, issue.id, "an unrelated successful method alone does not resolve the failed check");
  assert.match(retained.impacts!.join(" "), /Automatic provider evidence established coverage for this episode, so it remains collected/);

  // Only repaired evidence clears it.
  episodes.find(episode => episode.id === 102)!.name = "Arrival (2)";
  state.tvdbChanged = [20];
  assert.deepEqual(episodeIssues(await rerun()), []);
});

test("a complete-set Manual Match still collects an episode whose combined/split check failed, and the failed check stays reported", async t => {
  const { rerun, save, setFlags, status, requests, missing } = await harness(t, catalogue({ 102: { name: null } }), owned);
  await rerun();
  const saved = await save([combined, part2]);
  assert.ok(saved.ok, await saved.clone().text());
  const mappingId = (await saved.json()).mapping.id as string;
  // The offline cached recheck isolates the failure too: no provider requests, no show-level discard.
  const before = requests.length;
  let rechecked = await status();
  for (let i = 0; i < 100 && pending(rechecked); i++) { await new Promise(resolve => setTimeout(resolve, 10)); rechecked = await status(); }
  assert.equal(requests.length, before, "cached recheck performs no HTTP");
  assert.deepEqual(issuesOf(rechecked).filter(issue => /^comparison-(inputs|failure):/.test(issue.id)), []);
  assert.deepEqual(missingKeys(rechecked), ["TMDB:9002", "TVDB:104"], "the Manual Match collects the split episode");
  const [issue] = episodeIssues(rechecked);
  assert.equal(issue?.episode?.id, 102, "the failed check is retained");
  assert.match(issue.impacts!.join(" "), /complete-set Manual Match established coverage for this episode, so it remains collected; this failed check is still unresolved/);

  const scanned = await rerun();
  assert.deepEqual(missingKeys(scanned), ["TMDB:9002", "TVDB:104"]);
  assert.deepEqual(episodeIssues(scanned).map(item => item.id), [issue.id]);

  // Report Missing outranks every method, so the combined/split check is no longer needed.
  await setFlags(mappingId, [part2]);
  const reported = await rerun();
  assert.equal(missing(reported)["TVDB:102"], "reported-missing");
  assert.deepEqual(episodeIssues(reported), []);
});
