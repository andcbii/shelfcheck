import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { catalogues, plexScan } from "./catalogue-override-harness";
import { harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const config = await import("../lib/server-config");
hook.deregister();
const connectTrakt = () => config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });

// Characterization of the evidence a cached recheck (a Manual Match or catalogue override
// change) compares from: the saved provider relationships it replays, the evidence it
// synthesizes for them, and when it adopts shared crosswalk evidence. SHELFCHECK-40 moves this
// into a saved evidence source; these tests pin today's behaviour so that move changes none of it.

type Issue = { id: string; operation: string; scope?: string; provider?: string; cause: string; impacts?: string[]; failedAt?: string; show?: { ratingKey?: string }; episode?: { id?: number } };
type AutoMatch = { method: string; tmdb: { id?: number }; tvdb: { id?: number } };
type ProviderMatch = { id: number; name?: string; slug?: string };
type Show = { ratingKey: string; tmdbId?: number; tvdbId?: number; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[]; autoMatches?: AutoMatch[]; providerMatches?: { tmdb: ProviderMatch[]; tvdb: ProviderMatch[] }; providerResolution?: { tmdb: boolean; tvdb: boolean } };
type Result = { report: { shows: Show[] }; coverage: { issues: Issue[]; pending?: unknown } };
type Name = "target" | "other";
const showOf = (result: unknown, name: Name = "target") => (result as Result).report.shows.find(show => show.ratingKey === `ratingKey:${name}`)!;
const missingKeys = (result: unknown, name: Name = "target") => showOf(result, name).missing.flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
const autoMatches = (result: unknown, name: Name = "target") => (showOf(result, name).autoMatches || []).map(match => `${match.method}: TVDB ${match.tvdb.id} = TMDB ${match.tmdb.id}`).sort();
const issuesOf = (result: unknown) => (result as Result).coverage.issues;
const showInputIssues = (result: unknown) => issuesOf(result).filter(issue => /^comparison-(failure|inputs):/.test(issue.id)).map(issue => issue.id);
/** One show's failed crosswalk checks and failed Provider Lookups of one TVDB episode. */
const episodeIssues = (result: unknown, name: Name, tvdbEpisodeId: number) => issuesOf(result).filter(issue => issue.show?.ratingKey === `ratingKey:${name}` && issue.episode?.id === tvdbEpisodeId);
const settled = async (status: () => Promise<unknown>) => {
  let result = await status();
  for (let i = 0; i < 100 && (result as Result).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await status(); }
  return result;
};
/** The provider relationships saved with a show's comparison. */
const savedRelationships = (name: Name = "target") => structuredClone(catalogues.readPlexInputs().comparisons[`ratingKey:${name}`]!.relationships);

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so every TVDB episode needs
// crosswalk evidence to be matched to an owned Plex file.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const catalogue = [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3];
const owned = [tmdb1, tmdb2];
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const empty = { tv_results: [], tv_episode_results: [] };
/** A cached recheck of every show that compares TVDB series 20, as a Manual Match change of TVDB 303 runs it. */
const recheckTarget = () => plexScan.requestCoverageRecheck({ members: [{ provider: "TVDB", id: tvdb3.id, showId: 20, show: "Target", title: "Three", season: 2, episode: 3, url: "" }] });

// --- Synthesized evidence ---------------------------------------------------------------

for (const provider of ["TMDB", "TVDB"] as const) test(`a cached recheck answers the Plex-reported ${provider} series lookups of a provider the last scan could not load as finding no series`, async t => {
  const { rerun, state, requests, status } = await harness(t, catalogue, owned);
  // The provider's catalogue and its series summary both fail, so neither is saved.
  if (provider === "TMDB") state.statuses.set("/3/tv/10", 404);
  else { state.statuses.set("/v4/series/20", 404); state.statuses.set("/v4/series/20/episodes/default", 404); }
  const scanned = await rerun();
  assert.deepEqual(showInputIssues(scanned), [], "the show is compared with the other provider");
  const matches = showOf(scanned).providerMatches!;

  requests.length = 0;
  await recheckTarget();
  const rechecked = await settled(status);
  assert.deepEqual(requests, [], "the cached recheck performs no HTTP");
  assert.deepEqual(showInputIssues(rechecked), [], "no saved answer is missing: the failed provider's series lookups find no series");
  assert.deepEqual(showOf(rechecked).providerMatches, matches);
  assert.deepEqual(missingKeys(rechecked), missingKeys(scanned));
  if (provider === "TMDB") assert.ok(!matches.tmdb.some(match => match.id === 10), "TMDB series 10 is not a series match");
  else assert.deepEqual(matches.tvdb, [{ id: 20 }], "TVDB series 20 has only its Plex ID, no summary");
});

test("a saved TVDB series summary answers ahead of the failed-provider placeholder", async t => {
  const { rerun, state, requests, status } = await harness(t, catalogue, owned);
  // Only the TVDB episode catalogue fails: the series summary is received and saved.
  state.statuses.set("/v4/series/20/episodes/default", 404);
  const scanned = await rerun();
  assert.deepEqual(showOf(scanned).providerMatches!.tvdb, [{ id: 20, name: "Target", slug: "target" }]);

  requests.length = 0;
  await recheckTarget();
  const rechecked = await settled(status);
  assert.deepEqual(requests, []);
  assert.deepEqual(showInputIssues(rechecked), []);
  assert.deepEqual(showOf(rechecked).providerMatches!.tvdb, [{ id: 20, name: "Target", slug: "target" }], "the saved summary, not an empty placeholder");
});

test("a saved catalogue's series summary answers ahead of the failed-provider placeholder", async t => {
  const { rerun, state, requests, status } = await harness(t, catalogue, owned);
  state.statuses.set("/3/tv/10", 404);
  const scanned = await rerun();
  assert.ok(!showOf(scanned).providerMatches!.tmdb.some(match => match.id === 10));
  // Another show's scan has since saved TMDB series 10's catalogue; this show's last scan had none,
  // so the recheck still does not compare it, but its series summary answers the series lookup.
  const downloadedAt = new Date().toISOString();
  catalogues.savePlexCatalogue("tmdb", 10, { version: 1, downloadedAt, show: { id: 10, name: "Saved catalogue", seasons: [{ season_number: 1 }] }, episodes: [] });

  requests.length = 0;
  await recheckTarget();
  const rechecked = await settled(status);
  assert.deepEqual(requests, []);
  assert.deepEqual(showInputIssues(rechecked), []);
  assert.equal(showOf(rechecked).providerResolution?.tmdb, false, "TMDB is still not compared");
  assert.deepEqual(showOf(rechecked).providerMatches!.tmdb.filter(match => match.id === 10), [{ id: 10, name: "Saved catalogue" }]);
});

test("a saved series lookup answer replays ahead of the saved catalogue's series summary", async t => {
  const { rerun, state, requests, status } = await harness(t, catalogue, owned);
  // TMDB series 10's catalogue download fails, but its plain series lookup succeeds and is saved.
  state.respond = url => url.pathname === "/3/tv/10" && url.searchParams.has("append_to_response") ? Response.json({}, { status: 404 }) : undefined;
  const scanned = await rerun();
  assert.equal(showOf(scanned).providerResolution?.tmdb, false);
  assert.deepEqual(showOf(scanned).providerMatches!.tmdb.filter(match => match.id === 10), [{ id: 10, name: "Target" }]);
  catalogues.savePlexCatalogue("tmdb", 10, { version: 1, downloadedAt: new Date().toISOString(), show: { id: 10, name: "Saved catalogue", seasons: [{ season_number: 1 }] }, episodes: [] });

  requests.length = 0;
  await recheckTarget();
  const rechecked = await settled(status);
  assert.deepEqual(requests, []);
  assert.deepEqual(showInputIssues(rechecked), []);
  assert.deepEqual(showOf(rechecked).providerMatches!.tmdb.filter(match => match.id === 10), [{ id: 10, name: "Target" }], "the saved answer, not the catalogue summary");
});

// --- Trakt ------------------------------------------------------------------------------

/** Trakt's validated mapping of TVDB 301 to owned TMDB 9001 in Target. */
const traktMapping = { type: "episode", episode: { season: 1, number: 1, ids: { tvdb: 301, tmdb: 9001 } }, show: { ids: { tmdb: 10, tvdb: 20 } } };
const traktIssues = (result: unknown) => issuesOf(result).filter(issue => issue.provider === "Trakt");

test("a cached recheck replays saved Trakt crosswalks even after the Trakt login is removed", async t => {
  const { rerun, state, requests, status } = await harness(t, catalogue, owned);
  await connectTrakt();
  state.bodies.set("/search/tvdb/301", [traktMapping]);
  state.bodies.set("/3/find/302", found(tmdb2));
  const scanned = await rerun();
  assert.ok(requests.includes("/search/tvdb/301"));
  assert.deepEqual(autoMatches(scanned), ["Matched via TMDB External ID: TVDB 302 = TMDB 9002", "Matched via Trakt: TVDB 301 = TMDB 9001"]);

  await config.clearTraktAuthorization();
  requests.length = 0;
  await recheckTarget();
  const rechecked = await settled(status);
  assert.deepEqual(requests, [], "the cached recheck performs no HTTP");
  assert.deepEqual(showInputIssues(rechecked), []);
  assert.deepEqual(autoMatches(rechecked), autoMatches(scanned), "the saved comparison's Trakt relationships decide, not the current login");
  assert.deepEqual(traktIssues(rechecked), []);
});

test("a cached recheck does not use Trakt when the saved comparison has no Trakt relationship, even once Trakt is connected", async t => {
  const { rerun, state, requests, status } = await harness(t, catalogue, owned);
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  const scanned = await rerun();
  assert.ok(!requests.some(path => path.startsWith("/search/tvdb/")), "the scan had no Trakt login");
  assert.deepEqual(autoMatches(scanned), ["Matched via TMDB External ID: TVDB 301 = TMDB 9001", "Matched via TMDB External ID: TVDB 302 = TMDB 9002"]);

  await connectTrakt();
  requests.length = 0;
  await recheckTarget();
  const rechecked = await settled(status);
  assert.deepEqual(requests, [], "the cached recheck performs no HTTP");
  assert.deepEqual(showInputIssues(rechecked), []);
  assert.deepEqual(autoMatches(rechecked), autoMatches(scanned));
  assert.deepEqual(traktIssues(rechecked), [], "no Trakt crosswalk is looked for, so none is unavailable");
  assert.deepEqual(issuesOf(rechecked).filter(issue => issue.operation === "episode-crosswalk"), []);
});
