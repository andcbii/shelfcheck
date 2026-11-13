import assert from "node:assert/strict";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

// TVDB's default episode catalogue stays the first source. Only an unusable
// default title is recovered, from the English translation of that exact TVDB
// episode, and a failed recovery stays an Episode-scoped failure (GLOSSARY).

type Issue = { id: string; operation: string; scope: string; category?: string; provider?: string; cause: string; action: string; impacts?: string[]; causedBy?: string[]; show?: { ratingKey?: string }; episode?: { provider?: string; id?: number; showId?: number; season?: number; episode?: number; title?: string } };
type Result = { coverage: { issues: Issue[]; pending?: unknown }; report: { shows: { ratingKey: string; missing: { title?: string; tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[] }[] } };
const episodeIssues = (result: unknown) => (result as Result).coverage.issues.filter(issue => issue.id.startsWith("episode-check:"));
const target = (result: unknown) => (result as Result).report.shows.find(item => item.ratingKey === "ratingKey:target")!;
const missingKeys = (result: unknown) => (target(result)?.missing || []).flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
const translationRequests = (requests: string[]) => requests.filter(path => path.includes("/translations/"));

// Minimal sanitized Dragon Ball Z Kai records: owned Plex/TMDB special S00E09
// (TMDB 1175909) and TVDB special S00E08 (6003511) share an air date; TVDB's
// default title is null while its English translation has the title.
const dbzTitle = "Peace Returns! A Time of Rest for the Warriors!";
const tmdbSpecial: Episode = { provider: "TMDB", id: 1175909, season: 0, episode: 9, name: dbzTitle, airDate: "2010-04-05", runtime: 24 };
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

test("an untitled TVDB episode recovers its English title by episode ID and it is used for ordinary matching", async t => {
  const { rerun, state, requests } = await harness(t, catalogue({ 102: { name: null }, 6003511: { name: null } }), owned);
  state.english.set(102, "Arrival (2)");
  state.english.set(6003511, dbzTitle);
  // A translation that differs from a valid default title must never be requested or used.
  state.english.set(104, "Not The Default");
  const result = await rerun();
  assert.deepEqual(missingKeys(result), ["TMDB:9002", "TVDB:104"], "the recovered title completes the combined/split match");
  assert.equal(target(result).missing.find(episode => episode.tvdbEpisodeId === 104)?.title, "Third", "a valid default title stays authoritative");
  assert.deepEqual(episodeIssues(result), [], "a successful fallback leaves no Scan Issue");
  assert.deepEqual(translationRequests(requests).sort(), ["/v4/episodes/102/translations/eng", "/v4/episodes/6003511/translations/eng"], "only untitled episodes are requested, by TVDB episode ID");
  assert.ok(!requests.some(path => /\/series\/\d+\/episodes\/(?!default)/.test(path)), "no English series catalogue is downloaded");
});

test("Dragon Ball Z Kai: the special's English title is recovered by TVDB ID despite differing numbering, and the comparison completes", async t => {
  const { rerun, state, requests, save, setFlags, missing } = await harness(t, catalogue(), owned);
  state.english.set(6003511, dbzTitle);
  const result = await rerun();
  assert.deepEqual((result as unknown as Result).coverage.issues.filter(issue => /^comparison-(failure|inputs):/.test(issue.id)), [], "no show-level comparison failure");
  assert.deepEqual(missingKeys(result), ["TMDB:9002", "TVDB:104"], "sibling episodes are still compared");
  assert.deepEqual(translationRequests(requests), ["/v4/episodes/6003511/translations/eng"], "requested by TVDB episode ID, not Plex/TMDB S00E09 numbering");
  assert.deepEqual(episodeIssues(result), []);

  // The recovered title is the TVDB special's title wherever it is shown, at its own TVDB numbering.
  const saved = await save([tmdbSpecial, tvdbSpecial]);
  assert.ok(saved.ok, await saved.clone().text());
  await setFlags((await saved.json()).mapping.id, [tvdbSpecial]);
  const reported = await rerun();
  assert.equal(missing(reported)["TVDB:6003511"], "reported-missing");
  const row = target(reported).missing.find(episode => episode.tvdbEpisodeId === 6003511)!;
  assert.equal(row.title, dbzTitle);
});

test("an English translation without a usable title keeps the title-dependent check safe and explains why", async t => {
  for (const english of [null, "   ", undefined]) {
    await t.test(`English name ${english === undefined ? "absent (404)" : JSON.stringify(english)}`, async t => {
      const { rerun, state } = await harness(t, catalogue({ 102: { name: null } }), owned);
      if (english !== undefined) state.english.set(102, english);
      const result = await rerun();
      assert.deepEqual(missingKeys(result), ["TMDB:9002", "TVDB:102", "TVDB:104"], "no guessed coverage; siblings still compared");
      const [issue, ...others] = episodeIssues(result);
      assert.deepEqual(others, [], "no English answer is not a failed request");
      assert.equal(issue.operation, "compound-matching");
      assert.equal(issue.cause, "Combined/split episode matching could not be checked: TVDB returned no usable default or English title for this episode.");
      assert.match(issue.impacts!.join(" "), /remains in missing results/);
    });
  }
});

test("a failed English request is its own episode issue; the dependent check stays safe and both clear when a later scan recovers the title", async t => {
  const { rerun, state, requests, restart, status } = await harness(t, catalogue({ 102: { name: null } }), owned);
  state.statuses.set("/v4/episodes/102/translations/eng", 403);
  state.english.set(6003511, dbzTitle);
  const failing = await rerun();
  assert.deepEqual(missingKeys(failing), ["TMDB:9002", "TVDB:102", "TVDB:104"]);
  const issue = episodeIssues(failing).find(item => item.operation === "title-recovery")!;
  assert.ok(issue, JSON.stringify(episodeIssues(failing)));
  assert.equal(issue.id, "episode-check:ratingKey:target:title-recovery:TVDB:102");
  assert.equal(issue.provider, "TVDB");
  assert.deepEqual(issue.episode, { provider: "TVDB", id: 102, showId: 20, season: 1, episode: 2 });
  assert.equal(issue.cause, "English title recovery could not be checked: 403 — TVDB request failed.");
  const text = JSON.stringify((failing as unknown as Result).coverage.issues);
  assert.match(text, /TVDB returned no usable default title for this episode, and its English title could not be retrieved\./, "the blocked combined/split check is explained as its dependent impact");
  assert.doesNotMatch(text, /Bearer|api4\.thetvdb\.com/, "no secrets or request URLs");

  // Repeated failure keeps one cause and survives restart.
  const ids = episodeIssues(failing).map(item => item.id).sort();
  assert.deepEqual(episodeIssues(await rerun()).map(item => item.id).sort(), ids);
  restart();
  assert.deepEqual(episodeIssues(await status()).map(item => item.id).sort(), ids);

  // The next scan retries only that episode even though the catalogue is reused, and recovers.
  state.statuses.delete("/v4/episodes/102/translations/eng");
  state.english.set(102, "Arrival (2)");
  const before = requests.length;
  const recovered = await rerun();
  const scanned = requests.slice(before);
  assert.deepEqual(translationRequests(scanned), ["/v4/episodes/102/translations/eng"]);
  assert.ok(!scanned.some(path => path.endsWith("/episodes/default")), "no whole-catalogue download");
  assert.deepEqual(missingKeys(recovered), ["TMDB:9002", "TVDB:104"]);
  assert.deepEqual(episodeIssues(recovered), [], "successful recovery leaves no stale issue");
});

test("a recovered title is saved and reused; a later valid default title stays authoritative", async t => {
  const episodes = catalogue({ 102: { name: null }, 104: { name: null } });
  const { rerun, state, requests, restart } = await harness(t, episodes, owned);
  state.english.set(102, "Arrival (2)");
  state.english.set(104, "Third (English)");
  state.english.set(6003511, dbzTitle);
  const first = await rerun();
  assert.equal(target(first).missing.find(episode => episode.tvdbEpisodeId === 104)?.title, "Third (English)");

  restart();
  let before = requests.length;
  const reused = await rerun();
  assert.deepEqual(translationRequests(requests.slice(before)), [], "a saved recovered title is not requested again");
  assert.deepEqual(missingKeys(reused), ["TMDB:9002", "TVDB:104"]);

  // A fresh default catalogue that is still untitled reuses the saved English titles.
  state.tvdbChanged = [20];
  before = requests.length;
  const downloaded = await rerun();
  assert.ok(requests.slice(before).some(path => path.endsWith("/series/20/episodes/default")));
  assert.deepEqual(translationRequests(requests.slice(before)), []);
  assert.deepEqual(missingKeys(downloaded), ["TMDB:9002", "TVDB:104"]);
  assert.equal(target(downloaded).missing.find(episode => episode.tvdbEpisodeId === 104)?.title, "Third (English)");

  // The provider later supplies a valid default title: it replaces the recovered one.
  episodes.find(episode => episode.id === 104)!.name = "Third";
  before = requests.length;
  const repaired = await rerun();
  assert.equal(target(repaired).missing.find(episode => episode.tvdbEpisodeId === 104)?.title, "Third");
  assert.deepEqual(translationRequests(requests.slice(before)), []);
});

test("a cached Manual Match recheck stays offline and keeps an unresolved English title failure", async t => {
  const { rerun, state, requests, save, status } = await harness(t, catalogue({ 102: { name: null } }), owned);
  state.statuses.set("/v4/episodes/102/translations/eng", 403);
  const failing = await rerun();
  const ids = episodeIssues(failing).map(item => item.id).sort();
  assert.ok(ids.includes("episode-check:ratingKey:target:title-recovery:TVDB:102"));
  const saved = await save([combined, part2]);
  assert.ok(saved.ok, await saved.clone().text());
  const before = requests.length;
  let rechecked = await status();
  for (let i = 0; i < 100 && (rechecked as unknown as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); rechecked = await status(); }
  assert.equal(requests.length, before, "cached recheck performs no HTTP");
  assert.deepEqual(missingKeys(rechecked), ["TMDB:9002", "TVDB:104"], "the Manual Match collects the split episode");
  assert.deepEqual(episodeIssues(rechecked).map(item => item.id).sort(), ids, "the unresolved recovery is not consumed by the recheck");
  assert.equal(episodeIssues(rechecked).find(item => item.operation === "title-recovery")?.cause, "English title recovery could not be checked: 403 — TVDB request failed.");
});
