import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { catalogues, plexScan } from "./catalogue-override-harness";
import { harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const config = await import("../lib/server-config");
const coverageIssues = await import("../lib/coverage-issues");
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

// --- Shared crosswalk evidence replay ---------------------------------------------------

// "Target" (TMDB 10 / TVDB 20) and "Other" (TMDB 11 / TVDB 21) both list TVDB episode 301 at a
// coordinate neither owns, so each comparison reaches TVDB 301's TMDB external-ID crosswalk.
const tmdbOther: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Pilot", show: "other" };
const sharedCatalogue = [tmdb1, tmdb3, tmdbOther, tvdb1, tvdb3, { ...tvdb1, show: "other" as const }];
const matched = "Matched via TMDB External ID: TVDB 301 = TMDB 9001";
const T0 = Date.parse("2026-11-12T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
/** A cached recheck of both shows, as a Manual Match change of TVDB 301 runs it. */
const recheckBoth = () => plexScan.requestCoverageRecheck({ members: [{ provider: "TVDB", id: tvdb1.id, showId: 21, show: "Other", title: "One", season: 2, episode: 1, url: "" }] });

/** Day one at T0: one scan saves TVDB 301's match for both shows, with the same receipt time. */
async function sharedMatch(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(T0) });
  const h = await harness(t, sharedCatalogue, [tmdb1, tmdbOther]);
  h.state.bodies.set("/3/find/301", found(tmdb1));
  const first = await h.rerun();
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatches(first, name), [matched]);
  assert.equal(catalogues.readSharedTmdbCrosswalk(301)?.receivedAt, at(0));
  /** Target's single-show rescan at `ms` after T0: its forced lookup replaces the shared outcome. */
  const rescanTarget = async (ms: number) => { t.mock.timers.setTime(T0 + ms); return h.rerun("ratingKey:target"); };
  /** An offline recheck of both shows; asserts it made no request. */
  const recheck = async () => {
    h.requests.length = 0;
    await recheckBoth();
    const result = await settled(h.status);
    assert.deepEqual(h.requests, [], "the cached recheck performs no HTTP");
    return result;
  };
  return { ...h, rescanTarget, recheck };
}

for (const later of [0, 1]) test(`a shared outcome received ${later ? "after" : "at the same time as"} Other's saved copy ${later ? "replaces it in the recheck" : "leaves the comparison copy in use"}, in memory only`, async t => {
  const { state, rescanTarget, recheck } = await sharedMatch(t);
  state.bodies.set("/3/find/301", empty);
  assert.deepEqual(autoMatches(await rescanTarget(later), "target"), []);
  assert.equal(catalogues.readSharedTmdbCrosswalk(301)?.receivedAt, at(later));
  const saved = savedRelationships("other");

  const rechecked = await recheck();
  assert.deepEqual(showInputIssues(rechecked), []);
  assert.deepEqual(autoMatches(rechecked, "other"), later ? [] : [matched]);
  assert.equal(missingKeys(rechecked, "other").includes("TVDB:301"), Boolean(later));
  assert.deepEqual(episodeIssues(rechecked, "other", 301), [], "a replayed valid empty answer is not a Coverage Issue");
  assert.deepEqual(savedRelationships("other"), saved, "the replay replacement is not saved");
});

test("an undated saved copy is older than any dated shared outcome; without a dated one it is replayed", async t => {
  const { state, rescanTarget, recheck, writeUndatedRelationships } = await sharedMatch(t);
  // Releases before receipt times saved undated copies and no shared crosswalk evidence.
  writeUndatedRelationships();
  assert.ok(!catalogues.readSharedTmdbCrosswalk(301));
  assert.deepEqual(autoMatches(await recheck(), "other"), [matched], "with no shared outcome the undated copy is replayed");

  state.bodies.set("/3/find/301", empty);
  await rescanTarget(-60_000);
  const saved = savedRelationships("other");
  const rechecked = await recheck();
  assert.deepEqual(autoMatches(rechecked, "other"), [], "a shared outcome even older than the undated copy's scan replaces it");
  assert.ok(missingKeys(rechecked, "other").includes("TVDB:301"));
  assert.deepEqual(savedRelationships("other"), saved, "the replay replacement is not saved");
});

const rejections: { kind: string; serve: (state: Awaited<ReturnType<typeof harness>>["state"]) => void; cause: RegExp }[] = [
  { kind: "a failed request", serve: state => state.statuses.set("/3/find/301", 404), cause: /The saved TMDB response for this episode is not available to the offline recheck/ },
  { kind: "an unreadable response", serve: state => state.bodies.set("/3/find/301", { tv_episode_results: "unreadable" }), cause: /could not be interpreted/ },
];
for (const rejection of rejections) test(`a newer shared rejection by ${rejection.kind} grants Other's saved copy nothing in the recheck`, async t => {
  const { state, rescanTarget, recheck, restart } = await sharedMatch(t);
  rejection.serve(state);
  await rescanTarget(1);
  assert.equal(catalogues.readSharedTmdbCrosswalk(301)?.rejectedAt, at(1));
  const saved = savedRelationships("other");

  for (const restarting of [false, true]) {
    if (restarting) restart();
    const rechecked = await recheck();
    assert.deepEqual(showInputIssues(rechecked), [], "the episode's failure never fails the show");
    assert.deepEqual(autoMatches(rechecked, "other"), []);
    assert.ok(missingKeys(rechecked, "other").includes("TVDB:301"));
    const [issue, ...others] = episodeIssues(rechecked, "other", 301);
    assert.deepEqual(others, []);
    assert.equal(issue.operation, "episode-crosswalk");
    assert.match(issue.cause, rejection.cause);
    assert.deepEqual(savedRelationships("other"), saved, "the saved copy is kept, so a later shared outcome can still replace it");
  }
});

// --- Recovery after the comparison's own failed request ---------------------------------

/** Other's rescan at T0+1s fails TVDB 301's lookup, leaving no saved copy and a dated failed request. */
async function otherFailed(t: test.TestContext) {
  const h = await sharedMatch(t);
  h.state.statuses.set("/3/find/301", 404);
  t.mock.timers.setTime(T0 + 1000);
  const failed = await h.rerun("ratingKey:other");
  assert.deepEqual(autoMatches(failed, "other"), []);
  const [request] = episodeIssues(failed, "other", 301).filter(issue => issue.operation === "episode-identity");
  assert.equal(request.failedAt, at(1000));
  h.state.statuses.delete("/3/find/301");
  return { ...h, request };
}

test("a shared answer received strictly after the comparison's own failed request is recovered, saved, then resolves that request, and stays", async t => {
  const { rescanTarget, recheck, restart, request } = await otherFailed(t);
  assert.deepEqual(autoMatches(await rescanTarget(2000), "target"), [matched]);
  const before = savedRelationships("other");

  const rechecked = await recheck();
  assert.deepEqual(autoMatches(rechecked, "other"), [matched]);
  assert.deepEqual(episodeIssues(rechecked, "other", 301), [], "the failed request is resolved");
  assert.equal(coverageIssues.getCoverageIssue(request.id), undefined);
  const after = savedRelationships("other");
  const added = Object.keys(after).filter(key => !Object.hasOwn(before, key));
  assert.equal(added.length, 1, "exactly the recovered answer is saved");
  assert.deepEqual(after[added[0]], { provider: "TMDB", value: found(tmdb1), receivedAt: at(2000) }, "with the shared answer's original receipt time");
  for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key]);

  // Later rechecks and restarts keep the recovery.
  for (const restarting of [false, true]) {
    if (restarting) restart();
    const again = await recheck();
    assert.deepEqual(autoMatches(again, "other"), [matched]);
    assert.deepEqual(episodeIssues(again, "other", 301), []);
    assert.deepEqual(savedRelationships("other"), after);
  }
});

const noRecovery: { kind: string; arrange: (h: Awaited<ReturnType<typeof otherFailed>>) => Promise<void> }[] = [
  { kind: "received at the same time as the failed request", arrange: async h => { await h.rescanTarget(1000); } },
  { kind: "when the failed request has no failure time", arrange: async h => { await h.rescanTarget(2000); const { failedAt: _, ...undated } = coverageIssues.getCoverageIssue(h.request.id)!; coverageIssues.setCoverageIssue(undated); } },
  { kind: "when no failed request is recorded", arrange: async h => { await h.rescanTarget(2000); coverageIssues.resolveCoverageIssue(h.request.id); } },
];
for (const variant of noRecovery) test(`a shared answer ${variant.kind} is not recovered into the comparison`, async t => {
  const h = await otherFailed(t);
  await variant.arrange(h);
  const before = savedRelationships("other");
  const issue = coverageIssues.getCoverageIssue(h.request.id);

  const rechecked = await h.recheck();
  assert.deepEqual(showInputIssues(rechecked), []);
  assert.deepEqual(autoMatches(rechecked, "other"), [], "the missing copy stays unavailable");
  assert.ok(missingKeys(rechecked, "other").includes("TVDB:301"));
  assert.deepEqual(coverageIssues.getCoverageIssue(h.request.id), issue, "the failed request is left as it was");
  assert.deepEqual(savedRelationships("other"), before, "nothing is saved");
});

test("a recovered answer that cannot be saved leaves the failed request open, and a later recheck recovers it", async t => {
  const { rescanTarget, recheck, request } = await otherFailed(t);
  await rescanTarget(2000);
  const before = savedRelationships("other");
  // Saving Other's comparison with changed relationships fails; other saves succeed.
  const db = (globalThis as typeof globalThis & { __shelfcheckDatabase?: import("node:sqlite").DatabaseSync }).__shelfcheckDatabase!;
  db.exec(`CREATE TRIGGER fail_recovery_save BEFORE UPDATE ON shelfcheck_plex_generated_inputs
    WHEN NEW.cache_key='comparison:ratingKey:other' AND json_extract(NEW.payload,'$.relationships') IS NOT json_extract(OLD.payload,'$.relationships')
    BEGIN SELECT RAISE(ABORT,'disk full'); END`);

  const failed = await recheck();
  assert.deepEqual(coverageIssues.getCoverageIssue(request.id)?.failedAt, request.failedAt, "the failed request stays open");
  assert.deepEqual(savedRelationships("other"), before);
  assert.deepEqual(showInputIssues(failed), ["comparison-inputs:ratingKey:other"], "the show keeps last-good results");

  db.exec("DROP TRIGGER fail_recovery_save");
  const recovered = await recheck();
  assert.deepEqual(autoMatches(recovered, "other"), [matched]);
  assert.equal(coverageIssues.getCoverageIssue(request.id), undefined);
  assert.deepEqual(showInputIssues(recovered), []);
});
