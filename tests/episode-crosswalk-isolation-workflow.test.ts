import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const config = await import("../lib/server-config");
hook.deregister();
const connectTrakt = () => config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });

// Episode-scoped failures (GLOSSARY) in identity and crosswalk lookups: a rejected
// request or a successful response that cannot be interpreted stays with the
// affected TVDB episode. Its siblings and later independent methods still run.

type Issue = { id: string; operation: string; scope: string; category?: string; provider?: string; cause: string; action: string; impacts?: string[]; lookup?: { status?: number }; show?: { ratingKey?: string }; episode?: { provider?: string; id?: number; showId?: number; season?: number; episode?: number } };
const issuesOf = (result: unknown) => (result as { coverage: { issues: Issue[] } }).coverage.issues;
const pending = (result: unknown) => Boolean((result as { coverage: { pending?: unknown } }).coverage.pending);
const crosswalkIssues = (result: unknown) => issuesOf(result).filter(issue => issue.operation === "episode-crosswalk");
const showFailures = (result: unknown) => issuesOf(result).filter(issue => /^comparison-(failure|inputs):/.test(issue.id));

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so every TVDB
// episode needs identity/crosswalk evidence to be matched to the owned Plex files.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const catalogue = [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3];
const owned = [tmdb1, tmdb2];
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const missingKeys = (result: { report: { shows: { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[] }[] } }) =>
  (result.report.shows.find(item => item.ratingKey === "ratingKey:target")?.missing || []).flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();

test("a malformed successful TMDB crosswalk response stays with its episode and the show comparison completes", async t => {
  const { rerun, state, restart, status, requests } = await harness(t, catalogue, owned);
  state.bodies.set("/3/find/301", { tv_episode_results: {} });
  state.bodies.set("/3/find/302", found(tmdb2));
  // The show-level TVDB→TMDB association is malformed too; it is not needed to compare the show.
  state.bodies.set("/3/find/20", { tv_results: {} });
  const result = await rerun();
  assert.deepEqual(showFailures(result), [], "no show-level comparison failure");
  assert.deepEqual(missingKeys(result), ["TMDB:9003", "TVDB:301", "TVDB:303"], "the sibling crosswalk still collects TVDB 302; the failed one grants no coverage");
  const [issue, ...others] = crosswalkIssues(result);
  assert.deepEqual(others, []);
  assert.equal(issue.scope, "episode");
  assert.equal(issue.category, "Episode Matching");
  assert.equal(issue.provider, "TMDB");
  assert.deepEqual(issue.show, { ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20 });
  assert.deepEqual(issue.episode, { provider: "TVDB", id: 301, showId: 20, season: 2, episode: 1, title: "One" });
  assert.match(issue.cause, /TMDB external ID crosswalk could not be checked: TMDB returned a successful response that could not be interpreted/);
  assert.match(issue.impacts!.join(" "), /No other method established coverage, so this episode remains in missing results/);
  assert.doesNotMatch(JSON.stringify(issue), /network|request failed/i, "an unreadable payload is not presented as a provider outage");

  // A repeated failure updates the same cause; the lookup is retried, not answered from the saved malformed response.
  requests.length = 0;
  const again = await rerun();
  assert.ok(requests.includes("/3/find/301"), "the failed crosswalk is requested again on the next scan");
  assert.deepEqual(crosswalkIssues(again).map(item => item.id), [issue.id]);
  restart();
  assert.deepEqual(crosswalkIssues(await status()).map(item => item.id), [issue.id], "the current cause survives restart");

  // Recovery clears it: the lookup completes and simply finds no owned episode.
  state.bodies.set("/3/find/301", { tv_episode_results: [] });
  const recovered = await rerun();
  assert.deepEqual(crosswalkIssues(recovered), []);
  assert.deepEqual(missingKeys(recovered), ["TMDB:9003", "TVDB:301", "TVDB:303"]);
});

test("failed IMDb and Trakt crosswalks let the TMDB crosswalk still collect the episode, and the failed checks stay reported", async t => {
  const { rerun, state } = await harness(t, catalogue, owned);
  await connectTrakt();
  state.imdb.set(9001, "tt1");
  state.bodies.set("/v4/episodes/301/extended", { data: { remoteIds: {} } });
  state.bodies.set("/search/tvdb/301", {});
  state.statuses.set("/search/tvdb/302", 404);
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  const result = await rerun();
  assert.deepEqual(showFailures(result), []);
  assert.deepEqual(missingKeys(result), ["TMDB:9003", "TVDB:303"], "the later TMDB crosswalk collects both episodes");

  assert.deepEqual(crosswalkIssues(result).map(issue => `${issue.provider} ${issue.episode?.id}`).sort(), ["TVDB 301", "Trakt 301"], "each unreadable response is its own episode cause");
  for (const issue of crosswalkIssues(result)) {
    assert.match(issue.cause, /crosswalk could not be checked: (TVDB|Trakt) returned a successful response that could not be interpreted/);
    assert.match(issue.impacts!.join(" "), /Automatic provider evidence established coverage for this episode, so it remains collected; this failed check is still unresolved/);
  }
  // The rejected Trakt request keeps its Provider Lookup cause, which explains the episode impact once.
  const rejected = issuesOf(result).filter(issue => issue.provider === "Trakt" && issue.episode?.id === 302);
  assert.equal(rejected.length, 1, "one current cause for the rejected request");
  assert.equal(rejected[0].category, "Provider Lookup");
  assert.equal(rejected[0].lookup?.status, 404);
  assert.match(rejected[0].impacts!.join(" "), /Trakt episode crosswalk could not be checked: the Trakt request failed\..*remains collected/);

  state.bodies.delete("/v4/episodes/301/extended");
  state.bodies.set("/search/tvdb/301", []);
  state.statuses.delete("/search/tvdb/302");
  const recovered = await rerun();
  assert.deepEqual(issuesOf(recovered), [], "recovered lookups clear only their own causes");
  assert.deepEqual(missingKeys(recovered), ["TMDB:9003", "TVDB:303"]);
});

test("a complete-set Manual Match collects an episode whose crosswalk failed; the cause stays until the lookup recovers or Report Missing makes it unnecessary", async t => {
  const plex = [...owned];
  const { rerun, state, save, setFlags, status, requests, missing } = await harness(t, catalogue, plex);
  state.bodies.set("/3/find/301", { tv_episode_results: {} });
  state.bodies.set("/3/find/302", found(tmdb2));
  state.bodies.set("/3/find/303", { tv_episode_results: [null] });
  const [first] = crosswalkIssues(await rerun()).filter(issue => issue.episode?.id === 301);
  assert.ok(first);
  const saved = await save([tmdb1, tvdb1]);
  assert.ok(saved.ok, await saved.clone().text());
  const mappingId = (await saved.json()).mapping.id as string;

  // The offline cached recheck interprets the saved responses again: no HTTP, no show-level discard.
  const before = requests.length;
  let rechecked = await status();
  for (let i = 0; i < 100 && pending(rechecked); i++) { await new Promise(resolve => setTimeout(resolve, 10)); rechecked = await status(); }
  assert.equal(requests.length, before, "cached recheck performs no HTTP");
  assert.deepEqual(showFailures(rechecked), []);
  assert.deepEqual(missingKeys(rechecked), ["TMDB:9003", "TVDB:303"], "the Manual Match collects TVDB 301");
  const byEpisode = (result: unknown) => Object.fromEntries(crosswalkIssues(result).map(issue => [issue.episode!.id!, issue]));
  assert.equal(byEpisode(rechecked)[301]?.id, first.id, "the failed check is retained");
  assert.match(byEpisode(rechecked)[301].impacts!.join(" "), /A complete-set Manual Match established coverage for this episode, so it remains collected/);
  assert.match(byEpisode(rechecked)[303].impacts!.join(" "), /remains in missing results/, "an unrelated failed check is preserved");

  const scanned = await rerun();
  assert.deepEqual(missingKeys(scanned), ["TMDB:9003", "TVDB:303"]);
  assert.deepEqual(Object.keys(byEpisode(scanned)).sort(), ["301", "303"]);

  // Plex now owns TVDB 301 directly, so its crosswalk is not looked up again: the unrepaired cause stays.
  plex.push({ ...tvdb1, season: 9, episode: 9 });
  requests.length = 0;
  const owning = await rerun();
  assert.ok(!requests.includes("/3/find/301"), "an unnecessary crosswalk is not requested");
  assert.equal(byEpisode(owning)[301]?.id, first.id, "another method alone does not resolve the failed check");
  assert.match(byEpisode(owning)[301].cause, /could not be interpreted/);
  assert.match(byEpisode(owning)[301].impacts!.join(" "), /established coverage for this episode, so it remains collected/);

  // Report Missing outranks every method, so the crosswalk check is no longer needed.
  await setFlags(mappingId, [tvdb1]);
  const reported = await rerun();
  assert.equal(missing(reported)["TVDB:301"], "reported-missing");
  assert.deepEqual(Object.keys(byEpisode(reported)), ["303"], "only the unrelated cause remains");
});

test("every failed Trakt validation of one episode is recorded as a cause of its failed crosswalk", async t => {
  const { rerun, state } = await harness(t, catalogue, owned);
  await connectTrakt();
  // Trakt maps TVDB 301 to two TMDB episodes; validating each against TMDB fails.
  const mapping = (episode: Episode) => ({ type: "episode", episode: { season: episode.season, number: episode.episode, ids: { tvdb: 301, tmdb: episode.id } }, show: { ids: { tmdb: 10, tvdb: 20 } } });
  state.bodies.set("/search/tvdb/301", [mapping(tmdb1), mapping(tmdb2)]);
  state.statuses.set("/3/tv/10/season/1/episode/1", 404);
  state.statuses.set("/3/tv/10/season/1/episode/2", 403);
  const result = await rerun();
  assert.deepEqual(showFailures(result), []);
  const validations = issuesOf(result).filter(issue => issue.operation === "episode-identity" && issue.provider === "TMDB" && issue.episode?.season === 1).sort((a, b) => a.episode!.episode! - b.episode!.episode!);
  assert.deepEqual(validations.map(issue => issue.lookup?.status), [404, 403], "each rejected validation keeps its own Provider Lookup cause");
  for (const issue of validations) assert.match(issue.impacts!.join(" "), /Trakt episode crosswalk could not be checked/, `the crosswalk failure is grouped under ${issue.id}`);
  assert.ok(missingKeys(result).includes("TVDB:301"), "no coverage is guessed");
});
