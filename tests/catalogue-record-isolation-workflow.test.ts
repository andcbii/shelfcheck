import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const sqlite = await import("../lib/sqlite");
hook.deregister();

// A malformed individual TMDB or TVDB catalogue record is an Episode-scoped
// failure (GLOSSARY), not an unreadable catalogue: usable sibling records are
// still compared, and the bad record is reported in 05 — Scan Issues without
// inventing an episode identity, numbering or missing result.

type Issue = { id: string; operation: string; scope: string; provider?: string; cause: string; action: string; impacts?: string[]; show?: { ratingKey?: string; title?: string; tmdbId?: number; tvdbId?: number }; episode?: { provider?: string; id?: number; showId?: number; season?: number; episode?: number; title?: string } };
type Row = { season: number; episode: number; title?: string; airDate?: string; tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] };
type Result = { coverage: { issues: Issue[] }; report: { shows: { ratingKey: string; missing: Row[]; providerResolution?: { tmdb: boolean; tvdb: boolean } }[] } };
const issuesOf = (result: unknown) => (result as Result).coverage.issues;
const recordIssues = (result: unknown) => issuesOf(result).filter(issue => issue.operation === "catalogue-record");
const sharedIssues = (result: unknown) => issuesOf(result).filter(issue => /^(catalogue-refresh|comparison-inputs|comparison-failure):/.test(issue.id));
const target = (result: unknown) => (result as Result).report.shows.find(show => show.ratingKey === "ratingKey:target")!;
// Missing rows by provider identity, or by provider numbering when the record has no identity.
const rows = (result: unknown) => target(result).missing.flatMap(row => row.sources.map(source => {
  const id = source === "TMDB" ? row.tmdbEpisodeId : row.tvdbEpisodeId;
  return id === undefined ? `${source} S${row.season}E${row.episode}` : `${source}:${id}`;
})).sort();

const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tvdb1: Episode = { provider: "TVDB", id: 101, season: 1, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 102, season: 1, episode: 2, name: "Two" };
const catalogue = [tmdb1, tmdb2, tvdb1, tvdb2];
const owned = [tmdb1];

test("malformed TVDB catalogue records keep usable siblings and are reported without invented identities or rows", async t => {
  const { rerun, state } = await harness(t, catalogue, owned);
  state.tvdbRecords = [
    null,
    { id: 105, seasonNumber: 1, name: "No numbering" },
    { seasonNumber: 1, number: 5, name: "No identity", aired: "2020-02-01" },
    { name: "Nothing usable" },
  ];
  const result = await rerun();
  assert.deepEqual(sharedIssues(result), [], "a bad record is not an unreadable catalogue or a failed show comparison");
  assert.deepEqual(target(result).providerResolution, { tmdb: true, tvdb: true }, "the show stays matched");
  // Usable siblings are compared normally; the numbered record without identity follows numbering-based decisions.
  assert.deepEqual(rows(result), ["TMDB:9002", "TVDB S1E5", "TVDB:102"]);
  const row = target(result).missing.find(item => item.episode === 5)!;
  assert.deepEqual([row.title, row.airDate], ["No identity", "2020-02-01"], "its own title and air date drive normal presentation and aired-date rules");
  const issues = recordIssues(result);
  const byEpisode = (predicate: (issue: Issue) => boolean) => issues.filter(predicate);
  const identified = byEpisode(issue => issue.episode?.id === 105);
  assert.equal(identified.length, 1);
  assert.equal(identified[0].scope, "episode");
  assert.deepEqual(identified[0].episode, { provider: "TVDB", id: 105, showId: 20, title: "No numbering" }, "no numbering is invented");
  assert.match(identified[0].cause, /no usable season and episode numbering/i);
  assert.match(identified[0].impacts!.join(" "), /not compared|cannot be compared/i);
  const numbered = byEpisode(issue => issue.episode?.season === 1 && issue.episode?.episode === 5);
  assert.equal(numbered.length, 1);
  assert.deepEqual(numbered[0].episode, { provider: "TVDB", showId: 20, season: 1, episode: 5, title: "No identity" }, "no identity is invented");
  assert.match(numbered[0].cause, /no usable episode ID/i);
  assert.match(numbered[0].impacts!.join(" "), /numbering/i);
  const unidentifiable = byEpisode(issue => !issue.episode);
  assert.equal(unidentifiable.length, 2, "each unidentifiable record is reported with provider and show context only");
  for (const issue of unidentifiable) {
    assert.equal(issue.scope, "show");
    assert.equal(issue.provider, "TVDB");
    assert.deepEqual(issue.show, { ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20 });
    assert.match(issue.cause, /TVDB series 20/);
    assert.match(issue.impacts!.join(" "), /no missing result/i, "skipped records are not claimed verified");
  }
  assert.equal(issues.length, 4);
  assert.doesNotMatch(JSON.stringify(issues), /network|TypeError|Cannot read/i);
});

test("malformed TMDB catalogue records keep usable siblings and are reported without invented identities or rows", async t => {
  const { rerun, state } = await harness(t, catalogue, owned);
  state.tmdbRecords = { 1: [
    null,
    { id: 9005, season_number: 1, episode_number: "5", name: "Bad numbering" },
    { season_number: 1, episode_number: 6, name: 42, air_date: "2020-02-01" },
    "junk",
  ] };
  const result = await rerun();
  assert.deepEqual(sharedIssues(result), []);
  assert.deepEqual(rows(result), ["TMDB S1E6", "TMDB:9002", "TVDB:102"]);
  const issues = recordIssues(result);
  assert.deepEqual(issues.map(issue => [issue.scope, issue.provider, issue.episode]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
    ["episode", "TMDB", { provider: "TMDB", id: 9005, showId: 10, title: "Bad numbering" }],
    ["episode", "TMDB", { provider: "TMDB", showId: 10, season: 1, episode: 6 }],
    ["show", "TMDB", undefined],
    ["show", "TMDB", undefined],
  ]);
  for (const issue of issues.filter(item => !item.episode)) assert.match(issue.cause, /TMDB show 10 catalogue record \(season 1 record \d\)/);
});

test("record issues stay current across catalogue reuse and restart, deduplicate, and clear only when the record is repaired", async t => {
  const { rerun, state, requests, restart, status } = await harness(t, catalogue, owned);
  state.tmdbRecords = { 1: [{ id: 9005, season_number: 1, name: "Bad numbering" }] };
  state.tvdbRecords = [null, { seasonNumber: 1, number: 5, name: "No identity" }];
  const first = recordIssues(await rerun()).map(issue => issue.id).sort();
  assert.equal(first.length, 3);
  assert.equal(new Set(first).size, 3);

  // The saved catalogues are reused on the same day: the bad records are not re-downloaded, yet still reported once.
  const reused = await rerun();
  assert.deepEqual(requests.filter(path => /\/season\/\d+$|\/episodes\/default$/.test(path)).length, 2, "only the first scan downloaded catalogues");
  assert.deepEqual(recordIssues(reused).map(issue => issue.id).sort(), first);
  assert.deepEqual(rows(reused), ["TMDB:9002", "TVDB S1E5", "TVDB:102"]);
  restart();
  assert.deepEqual(recordIssues(await status()).map(issue => issue.id).sort(), first, "current causes survive restart");
  assert.deepEqual(recordIssues(await rerun()).map(issue => issue.id).sort(), first, "a restarted reuse neither duplicates nor forgets them");

  // TVDB repairs its records; the next download clears only TVDB's causes.
  state.tvdbRecords = [];
  state.tvdbChanged = [20];
  const repaired = await rerun();
  assert.deepEqual(recordIssues(repaired).map(issue => `${issue.provider} ${issue.episode?.id}`), ["TMDB 9005"], "the unrelated TMDB cause is kept");
  assert.deepEqual(rows(repaired), ["TMDB:9002", "TVDB:102"]);
});

test("malformed records in a previously saved catalogue are isolated on reuse and in offline cached rechecks", async t => {
  const { rerun, requests, restart, save, status } = await harness(t, catalogue, owned);
  await rerun();
  // A catalogue saved before record validation, holding malformed records.
  const saved = sqlite.readPlexGeneratedInputs<{ episodes: unknown[] }>("tvdb:20")!;
  sqlite.writePlexGeneratedInputs("tvdb:20", { ...saved, episodes: [...saved.episodes, null, { source: "TVDB", season: 1, episode: 6, providerEpisodeId: "x", title: "Bad identity" }] });
  restart();
  const reused = await rerun();
  assert.deepEqual(sharedIssues(reused), [], "the reused catalogue is not treated as unreadable and the show comparison completes");
  assert.deepEqual(rows(reused), ["TMDB:9002", "TVDB S1E6", "TVDB:102"]);
  const ids = recordIssues(reused).map(issue => issue.id).sort();
  assert.equal(ids.length, 2);

  // A Manual Match save rechecks the show offline from saved inputs, with the same isolation.
  const response = await save([tmdb2, tvdb2]);
  assert.ok(response.ok, await response.clone().text());
  const before = requests.length;
  let rechecked = await status() as unknown as Result & { coverage: { pending?: unknown } };
  for (let i = 0; i < 100 && rechecked.coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); rechecked = await status() as unknown as typeof rechecked; }
  assert.equal(requests.length, before, "cached recheck performs no HTTP");
  assert.deepEqual(sharedIssues(rechecked), []);
  assert.deepEqual(rows(rechecked), ["TMDB:9002", "TVDB S1E6", "TVDB:102"]);
  assert.deepEqual(recordIssues(rechecked).map(issue => issue.id).sort(), ids, "a cached recheck neither clears nor duplicates the causes");
});

test("a downloaded catalogue with no usable records is a shared-input failure that keeps last-good results, not an empty verified catalogue", async t => {
  // TVDB's records come only from the raw response here.
  const { rerun, state } = await harness(t, [tmdb1, tmdb2], owned);
  state.tvdbRecords = [{ id: 101, seasonNumber: 1, number: 1, name: "One" }, { id: 102, seasonNumber: 1, number: 2, name: "Two", aired: "2020-01-01" }];
  const good = await rerun();
  assert.deepEqual(rows(good), ["TMDB:9002", "TVDB:102"]);

  state.tvdbRecords = [null, { name: "Nothing usable" }];
  state.tvdbChanged = [20];
  const broken = await rerun();
  const refresh = issuesOf(broken).find(issue => issue.id === "catalogue-refresh:TVDB:ratingKey:target");
  assert.ok(refresh, "the unreadable catalogue is reported as a catalogue failure");
  assert.match(refresh.cause, /TVDB returned an incomplete or unreadable response/);
  assert.doesNotMatch(refresh.cause, /network/i);
  assert.deepEqual(rows(broken), ["TMDB:9002", "TVDB:102"], "last-good TVDB records are still compared, not an empty catalogue");
  assert.deepEqual(recordIssues(broken), [], "records of a rejected catalogue are not reported individually");
});

test("a TVDB record with an ID but no numbering still takes part in ID-based checks, such as its Report Missing flag", async t => {
  const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
  const tvdb3: Episode = { provider: "TVDB", id: 103, season: 1, episode: 3, name: "Three" };
  // TVDB's episode record (used to save the Manual Match) has numbering; its default catalogue record does not.
  const { rerun, state, save, setFlags, missing } = await harness(t, [...catalogue, tmdb3, tvdb3], [tmdb1, tmdb3]);
  const record = (episode: Episode) => ({ id: episode.id, seasonNumber: episode.season, number: episode.episode, name: episode.name, aired: "2020-01-01" });
  state.bodies.set("/v4/series/20/episodes/default", { data: { episodes: [record(tvdb1), record(tvdb2), { id: 103, seasonNumber: 1, name: "Three", aired: "2020-01-01" }] } });
  const first = await rerun();
  assert.deepEqual(rows(first), ["TMDB:9002", "TVDB:102"], "no row is invented for the unnumbered record");

  const saved = await save([tmdb3, tvdb3]);
  assert.ok(saved.ok, await saved.clone().text());
  await setFlags((await saved.json()).mapping.id, [tvdb3]);
  const reported = await rerun();
  assert.equal(missing(reported)["TVDB:103"], "reported-missing", "the flag on its ID keeps it missing, at its saved Manual Match numbering");
  const row = target(reported).missing.find(item => item.tvdbEpisodeId === 103)!;
  assert.deepEqual([row.season, row.episode], [1, 3], "a regular-season record keeps its saved season, not season 0");
  const [issue, ...others] = recordIssues(reported);
  assert.deepEqual(others, []);
  assert.equal(issue.episode?.id, 103, "the record is still reported as lacking numbering");
  assert.match(issue.impacts!.join(" "), /Manual Match/);
});

test("a saved catalogue whose records are all unusable is not reused as an empty verified catalogue", async t => {
  const { rerun, requests, restart } = await harness(t, catalogue, owned);
  assert.deepEqual(rows(await rerun()), ["TMDB:9002", "TVDB:102"]);
  // The saved TVDB catalogue is damaged: no record has both identity and numbering.
  const saved = sqlite.readPlexGeneratedInputs<{ episodes: unknown[] }>("tvdb:20")!;
  sqlite.writePlexGeneratedInputs("tvdb:20", { ...saved, episodes: [null, { source: "TVDB", providerEpisodeId: 102, title: "Two" }] });
  restart();
  const before = requests.length;
  const result = await rerun();
  assert.ok(requests.slice(before).includes("/v4/series/20/episodes/default"), "the unusable saved catalogue is refreshed instead of reused");
  assert.deepEqual(rows(result), ["TMDB:9002", "TVDB:102"], "TVDB 102 is still missing, not hidden by an empty catalogue");
  assert.deepEqual(sharedIssues(result), []);
});

test("a saved catalogue whose records are all unusable keeps last-good results when its refresh fails", async t => {
  const { rerun, state, restart } = await harness(t, catalogue, owned);
  assert.deepEqual(rows(await rerun()), ["TMDB:9002", "TVDB:102"]);
  const saved = sqlite.readPlexGeneratedInputs<{ episodes: unknown[] }>("tvdb:20")!;
  sqlite.writePlexGeneratedInputs("tvdb:20", { ...saved, episodes: [null, { source: "TVDB", providerEpisodeId: 102, title: "Two" }] });
  restart();
  state.bodies.set("/v4/series/20/episodes/default", { data: { episodes: [null] } });
  const result = await rerun();
  const refresh = issuesOf(result).find(issue => issue.id === "catalogue-refresh:TVDB:ratingKey:target");
  assert.ok(refresh, "the failed refresh is reported");
  assert.match((refresh as Issue & { lookup?: { impact?: string } }).lookup?.impact || "", /No previous catalogue data is available/, "the unusable saved catalogue is not offered as last-good data");
  assert.match(refresh.impacts!.join(" "), /comparison could not be checked.*Last-good comparison results were retained/);
  assert.deepEqual(rows(result), ["TMDB:9002", "TVDB:102"], "last-good comparison results are retained");
});
