import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";
import { lookupFailureIssueId } from "../lib/coverage-issue-ids";
import { providerLookup } from "../lib/provider-lookup";
import { seedStoredCoverageIssues } from "./stored-coverage-issues";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const catalogues = await import("../lib/plex-catalogues");
const coverageIssues = await import("../lib/coverage-issues");
const config = await import("../lib/server-config");
const { database } = await import("../lib/sqlite");
hook.deregister();

// Characterization (SHELFCHECK-124): what a live Plex scan run saves and requests for every
// matching lookup, and the lookup Coverage Issues it raises. Later Stories of SHELFCHECK-40 move
// this code; these tests pin today's behaviour. Stored keys are lookup keys (SHELFCHECK-141).

/** The saved provider relationship keys: `<lookup kind>:<inputs>`. */
const keys = {
  tmdbSeriesByTvdb: (id: number) => `tmdb-series-by-tvdb:${id}`,
  tmdbEpisodeByTvdb: (id: number) => `tmdb-episode-by-tvdb:${id}`,
  tmdbSeries: (id: number) => `tmdb-series:${id}:summary`,
  tmdbSeriesWithExternalIds: (id: number) => `tmdb-series:${id}:external-ids`,
  tvdbSeries: (id: number) => `tvdb-series:${id}`,
  tvdbEpisodeExtended: (id: number) => `tvdb-episode-extended:${id}`,
  traktEpisodeByTvdb: (id: number) => `trakt-episode-by-tvdb:${id}`,
  tmdbEpisode: (show: number, season: number, episode: number) => `tmdb-episode:${show}:${season}:${episode}`,
};
const requestIssueId = (relationship: string) => `episode-identity:ratingKey:target:${relationship}`;

type Issue = { id: string; operation: string; provider?: string; scope?: string; cause: string; causedBy?: string[]; failedAt?: string; crosswalk?: string; kind?: string; episode?: { id?: number } };
type Result = { coverage: { issues: Issue[] } };
const issuesOf = (result: unknown) => (result as Result).coverage.issues;
const comparison = () => catalogues.readPlexInputs().comparisons["ratingKey:target"];
const relationships = () => comparison().relationships;
const shared = (tvdbEpisodeId: number) => catalogues.readSharedTmdbCrosswalk(tvdbEpisodeId);
/** Requests per pathname, so an added or dropped request to any provider shows. */
const tally = (requests: string[]) => requests.reduce<Record<string, number>>((counts, pathname) => ({ ...counts, [pathname]: (counts[pathname] || 0) + 1 }), {});
const found = (episode: Episode, showId = 10) => ({ tv_episode_results: [{ id: episode.id, show_id: showId, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const empty = { tv_results: [], tv_episode_results: [] };
const plexInventory = { "/library/sections": 1, "/library/sections/1/all": 1, "/library/metadata/target/allLeaves": 1, "/library/metadata/target": 1 };

// Target (TMDB 10 / TVDB 20): TMDB numbers the season S1, TVDB numbers it S2. Plex owns TMDB 9001,
// which also carries an IMDb GUID. TVDB 301 is matched through its IMDb ID; TVDB 302 and 303 reach
// the TMDB external-ID crosswalk.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const imdbExtended = { data: { id: 301, remoteIds: [{ id: "tt0000001", sourceName: "IMDB" }] } };

async function target(t: test.TestContext, time = "2026-11-12T12:00:00Z") {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(time) });
  const h = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2, tvdb3], [tmdb1, tmdb2]);
  h.state.imdb.set(9001, "tt0000001");
  h.state.bodies.set("/v4/episodes/301/extended", imdbExtended);
  h.state.bodies.set("/3/find/302", found(tmdb2));
  return h;
}

test("a live scan saves each provider relationship, the IMDb crosswalk results and shared crosswalk evidence with their receipt times", async t => {
  const { rerun, requests, state } = await target(t);
  await rerun();
  const at = "2026-11-12T12:00:00.000Z";
  assert.deepEqual(relationships(), {
    [keys.tmdbSeriesByTvdb(20)]: { provider: "TMDB", value: empty, receivedAt: at },
    [keys.tvdbSeries(20)]: { provider: "TVDB", value: { data: { id: 20, name: "Target", slug: "target" } }, receivedAt: at },
    [keys.tvdbEpisodeExtended(301)]: { provider: "TVDB", value: imdbExtended, receivedAt: at },
    [keys.tvdbEpisodeExtended(302)]: { provider: "TVDB", value: { data: { id: 302, seriesId: 20, seasonNumber: 2, number: 2, name: "Two" } }, receivedAt: at },
    [keys.tvdbEpisodeExtended(303)]: { provider: "TVDB", value: { data: { id: 303, seriesId: 20, seasonNumber: 2, number: 3, name: "Three" } }, receivedAt: at },
    [keys.tmdbEpisodeByTvdb(302)]: { provider: "TMDB", value: found(tmdb2), receivedAt: at },
    [keys.tmdbEpisodeByTvdb(303)]: { provider: "TMDB", value: empty, receivedAt: at },
  });
  assert.deepEqual(comparison().tvdbEpisodeImdbIds, { 301: ["tt0000001"], 302: [], 303: [] }, "the IMDb crosswalk results are saved separately");
  assert.deepEqual(shared(302), { value: found(tmdb2), receivedAt: at });
  assert.deepEqual(shared(303), { value: empty, receivedAt: at });
  assert.equal(shared(301), null, "only TMDB external-ID crosswalks are shared");
  assert.equal(shared(20), null, "a series association is not shared crosswalk evidence");
  assert.deepEqual(tally(requests), {
    ...plexInventory, "/v4/login": 1, "/3/tv/10": 1, "/3/tv/10/season/1": 1, "/v4/series/20/episodes/default": 1,
    // The catalogue download's slug read and the TVDB series summary are separate requests of one URL.
    "/v4/series/20": 2,
    "/3/find/20": 1, "/v4/episodes/301/extended": 1, "/v4/episodes/302/extended": 1, "/v4/episodes/303/extended": 1, "/3/find/302": 1, "/3/find/303": 1,
  });
  const firstScan = relationships();

  // A later same-day scan reuses every saved relationship and renews no receipt time.
  t.mock.timers.setTime(Date.parse("2026-11-12T15:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(tally(requests), { ...plexInventory, "/v4/login": 1, "/3/tv/changes": 1, "/v4/updates": 1 }, "only plain transport: Plex and both change feeds");
  assert.deepEqual(relationships(), firstScan);
  assert.deepEqual(shared(302), { value: found(tmdb2), receivedAt: at });

  // TVDB reports the series changed: its catalogue is downloaded again, with its own slug read.
  state.tvdbChanged = [20];
  t.mock.timers.setTime(Date.parse("2026-11-12T16:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(tally(requests), {
    ...plexInventory, "/v4/login": 1, "/3/tv/changes": 1, "/v4/updates": 1, "/v4/series/20/episodes/default": 1, "/v4/series/20": 2,
    "/v4/episodes/301/extended": 1, "/v4/episodes/302/extended": 1, "/v4/episodes/303/extended": 1,
  }, "TVDB relationships and IMDb crosswalk results are requested again; TMDB relationships are reused");
  const changedAt = "2026-11-12T16:00:00.000Z";
  assert.deepEqual(Object.fromEntries(Object.entries(relationships()).map(([key, value]) => [key, value.receivedAt])), {
    [keys.tmdbSeriesByTvdb(20)]: at, [keys.tmdbEpisodeByTvdb(302)]: at, [keys.tmdbEpisodeByTvdb(303)]: at,
    [keys.tvdbSeries(20)]: changedAt, [keys.tvdbEpisodeExtended(301)]: changedAt, [keys.tvdbEpisodeExtended(302)]: changedAt, [keys.tvdbEpisodeExtended(303)]: changedAt,
  });
});

/** Receipt times of a TVDB episode's TMDB crosswalk: this comparison's copy, then the shared evidence. */
const crosswalkReceipts = (tvdbEpisodeId: number) => [relationships()[keys.tmdbEpisodeByTvdb(tvdbEpisodeId)]?.receivedAt, shared(tvdbEpisodeId)?.receivedAt];

test("episode crosswalk freshness: a response received on or after the scan's starting UTC date is reused, including one received after midnight during the scan, and reuse never renews it", async t => {
  const { rerun, requests, state } = await target(t, "2026-11-12T23:59:58Z");
  // TVDB 303's crosswalk response arrives after UTC midnight.
  state.onRequest = pathname => { if (pathname === "/3/find/303") t.mock.timers.setTime(Date.parse("2026-11-13T00:00:05Z")); };
  await rerun();
  state.onRequest = undefined;
  assert.deepEqual(crosswalkReceipts(302), ["2026-11-12T23:59:58.000Z", "2026-11-12T23:59:58.000Z"]);
  assert.deepEqual(crosswalkReceipts(303), ["2026-11-13T00:00:05.000Z", "2026-11-13T00:00:05.000Z"], "the actual receipt time, not the scan's start");

  // The next scan starts on 2026-11-13: TVDB 302's response is from an earlier UTC date; TVDB 303's is not.
  t.mock.timers.setTime(Date.parse("2026-11-13T08:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(requests.filter(pathname => pathname.startsWith("/3/find/3")), ["/3/find/302"]);
  assert.deepEqual(crosswalkReceipts(302), ["2026-11-13T08:00:00.000Z", "2026-11-13T08:00:00.000Z"]);
  assert.deepEqual(crosswalkReceipts(303), ["2026-11-13T00:00:05.000Z", "2026-11-13T00:00:05.000Z"], "reuse never renews the receipt time");
});

/** TMDB lookups a same-day scan sends: series associations and episode crosswalks. */
const tmdbFinds = (requests: string[]) => requests.filter(pathname => pathname.startsWith("/3/find/")).sort();

test("forced lookups: a changed TMDB alias and a TVDB ID change bypass same-day reuse", async t => {
  const { rerun, requests, state } = await target(t, "2026-11-12T10:00:00Z");
  // TMDB associates TVDB 20 with an alias series, TMDB 12, too.
  state.bodies.set("/3/find/20", { tv_results: [{ id: 12, name: "Target (alias)" }], tv_episode_results: [] });
  await rerun();
  assert.deepEqual(comparison().tmdbAliases, [12, 10]);

  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(tmdbFinds(requests), [], "an ordinary same-day scan reuses every TMDB lookup");

  // TMDB's change feed reports the alias changed: the comparison's TMDB relationships are rebuilt.
  state.bodies.set("/3/tv/changes", { results: [{ id: 12 }], total_pages: 1 });
  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(tmdbFinds(requests), ["/3/find/20", "/3/find/302", "/3/find/303"]);
  assert.equal(comparison().staleRelationships, undefined, "the rebuilt comparison is no longer stale");
  state.bodies.delete("/3/tv/changes");

  // Plex now matches the show to TVDB 21, which lists the same episodes.
  const tvdbEpisodes = [tvdb1, tvdb2, tvdb3].map(episode => ({ id: episode.id, seasonNumber: episode.season, number: episode.episode, name: episode.name, aired: "2020-01-01" }));
  state.respond = url => {
    if (url.hostname === "plex" && (url.pathname === "/library/sections/1/all" || url.pathname === "/library/metadata/target")) return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "target", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://21" }] }] } });
    if (url.pathname === "/v4/series/21") return Response.json({ data: { id: 21, name: "Target", slug: "target" } });
    if (url.pathname === "/v4/series/21/episodes/default") return Response.json({ data: { episodes: tvdbEpisodes } });
    return undefined;
  };
  t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.equal(comparison().tvdbId, 21);
  assert.deepEqual(tmdbFinds(requests), ["/3/find/21", "/3/find/302", "/3/find/303"], "the TVDB ID change forces the episode crosswalks");

  t.mock.timers.setTime(Date.parse("2026-11-12T14:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(tmdbFinds(requests), []);
});

test("forced lookups: a stale alias seen while the show was not compared forces its next same-day lookups", async t => {
  const { rerun, requests, state } = await target(t, "2026-11-12T10:00:00Z");
  state.bodies.set("/3/find/20", { tv_results: [{ id: 12, name: "Target (alias)" }], tv_episode_results: [] });
  await rerun();
  assert.deepEqual(comparison().tmdbAliases, [12, 10]);

  // A scan sees TMDB 12 changed, but Plex's show details fail, so Target is not compared and its relationships are marked stale.
  state.bodies.set("/3/tv/changes", { results: [{ id: 12 }], total_pages: 1 });
  state.statuses.set("/library/metadata/target", 403);
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  await rerun();
  assert.deepEqual(comparison().staleRelationships, { tmdb: true });
  state.bodies.delete("/3/tv/changes");
  state.statuses.delete("/library/metadata/target");

  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(tmdbFinds(requests), ["/3/find/20", "/3/find/302", "/3/find/303"], "the stale comparison's TMDB lookups are forced although no change is reported now");
  assert.equal(comparison().staleRelationships, undefined);
});

test("forced lookups: a show's own failed crosswalk is requested again even when current shared evidence exists", async t => {
  const { rerun, requests, state } = await target(t, "2026-11-12T10:00:00Z");
  state.statuses.set("/3/find/303", 404);
  await rerun();
  assert.deepEqual(shared(303), { rejectedAt: "2026-11-12T10:00:00.000Z" });
  state.statuses.delete("/3/find/303");
  // Another show's comparison later received a usable answer for the same lookup.
  catalogues.saveSharedTmdbCrosswalk(303, { value: empty, receivedAt: "2026-11-12T10:30:00.000Z" });

  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.deepEqual(tmdbFinds(requests), ["/3/find/303"], "only the failed crosswalk is requested again");
  assert.deepEqual(crosswalkReceipts(303), ["2026-11-12T11:00:00.000Z", "2026-11-12T11:00:00.000Z"]);
});

test("rejection boundaries: the shared outcome rejects a failed request and an unreadable response; the comparison copy keeps no receipt time", async t => {
  const { rerun, state } = await target(t, "2026-11-12T10:00:00Z");
  state.statuses.set("/3/find/302", 404);
  state.bodies.set("/3/find/303", { tv_episode_results: {} });
  await rerun();
  assert.deepEqual(shared(302), { rejectedAt: "2026-11-12T10:00:00.000Z" }, "a failed request leaves no response");
  assert.equal(Object.hasOwn(relationships(), keys.tmdbEpisodeByTvdb(302)), false);
  assert.deepEqual(shared(303), { value: { tv_episode_results: {} }, rejectedAt: "2026-11-12T10:00:00.000Z" }, "an unreadable response is kept only to explain the failure");
  assert.deepEqual(relationships()[keys.tmdbEpisodeByTvdb(303)], { provider: "TMDB", value: { tv_episode_results: {} } });
});

test("a lookup is marked checked before its request: a retained last-good comparison drops the copy of a crosswalk whose refresh failed", async t => {
  const { rerun, state } = await target(t, "2026-11-12T10:00:00Z");
  await rerun();
  const dayOne = relationships();

  // Next UTC day: the TVDB catalogue download fails, so the last-good comparison is retained.
  // TVDB 302's crosswalk refresh succeeds and TVDB 303's fails.
  state.tvdbChanged = [20];
  state.statuses.set("/v4/series/20/episodes/default", 404);
  state.statuses.set("/3/find/303", 404);
  t.mock.timers.setTime(Date.parse("2026-11-13T10:00:00Z"));
  await rerun();
  const retained = { ...dayOne, [keys.tmdbEpisodeByTvdb(302)]: { provider: "TMDB", value: found(tmdb2), receivedAt: "2026-11-13T10:00:00.000Z" } };
  delete retained[keys.tmdbEpisodeByTvdb(303)];
  assert.deepEqual(relationships(), retained, "only the checked crosswalks' outcomes replace the last-good evidence");
});

test("an open failed-request Coverage Issue without a failure time blocks reuse of its saved series association", async t => {
  const { rerun, requests } = await target(t, "2026-11-12T10:00:00Z");
  await rerun();
  // Issues saved by older releases have no failure time.
  for (const relationship of [keys.tmdbSeriesByTvdb(20), keys.tmdbEpisodeByTvdb(303)]) seedStoredCoverageIssues(database(), { id: requestIssueId(relationship), operation: "episode-identity", provider: "TMDB", scope: "show", cause: "TMDB request failed.", action: "Run a Plex scan." });

  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  requests.length = 0;
  const result = await rerun();
  assert.deepEqual(tmdbFinds(requests), ["/3/find/20"], "the association is requested again; the crosswalk's current shared evidence resolves its issue without a request");
  assert.deepEqual(issuesOf(result), []);
});

test("lookup diagnostics: series summaries raise no lookup issue; a success resolves its request issue before an unreadable answer is recorded as an episode failure", async t => {
  const { rerun, state, requests } = await target(t, "2026-11-12T10:00:00Z");
  // TVDB 302's crosswalk names a TMDB series the comparison does not know; its summary request fails.
  state.bodies.set("/3/find/302", found(tmdb2, 12));
  state.statuses.set("/3/tv/12", 404);
  state.statuses.set("/3/find/303", 404);
  const failed = await rerun();
  assert.equal(requests.filter(pathname => pathname === "/3/tv/12").length, 1, "the series summary was requested");
  assert.deepEqual(comparison().tmdbEpisodeAliases, [12]);
  assert.deepEqual(issuesOf(failed), [{
    id: requestIssueId(keys.tmdbEpisodeByTvdb(303)), failedAt: "2026-11-12T10:00:00.000Z",
    operation: "episode-identity", provider: "TMDB", scope: "episode", category: "Provider Lookup",
    show: { ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20 },
    episode: { provider: "TVDB", id: 303, showId: 20, season: 2, episode: 3, title: "Three" },
    cause: "404 — record not found",
    action: "Check the recorded source reference; retry after checking or correcting the reference.",
    lookup: {
      failureKind: "http", status: 404,
      impact: "Episode identity and coverage could not be fully verified. Available last-good results were retained.",
      requested: { provider: "TMDB", kind: "external ID search", id: 303 },
      source: [{ provider: "Plex", kind: "TVDB series", id: 20 }, { provider: "TVDB", kind: "catalogue episode", id: 303, cached: false }],
    },
    impacts: ["Target: TMDB external ID crosswalk could not be checked: the TMDB request failed. This crosswalk granted no coverage for this episode; the remaining matching methods were still checked. No other method established coverage, so this episode remains in missing results."],
  }], "only the failed crosswalk request: the failed series summary raises no lookup issue");

  state.statuses.delete("/3/find/303");
  state.bodies.set("/3/find/303", { tv_episode_results: {} });
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  const unreadable = await rerun();
  assert.equal(coverageIssues.getCoverageIssue(lookupFailureIssueId("ratingKey:target", providerLookup.tmdbEpisodeByTvdbEpisode(303))), undefined, "the successful request resolved its failed-request issue");
  assert.deepEqual(issuesOf(unreadable), [{
    id: "episode-check:ratingKey:target:episode-crosswalk:TMDB:TVDB:303",
    operation: "episode-crosswalk", provider: "TMDB", scope: "episode", category: "Episode Matching",
    show: { ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20 },
    episode: { provider: "TVDB", id: 303, showId: 20, season: 2, episode: 3, title: "Three" },
    cause: "TMDB external ID crosswalk could not be checked: TMDB returned a successful response that could not be interpreted (tv_episode_results is not a list of records).",
    action: "Run a Plex scan to request this crosswalk again; if TMDB keeps returning an unreadable response, report it with this issue's details.",
    impacts: ["This crosswalk granted no coverage for this episode; the remaining matching methods were still checked.", "No other method established coverage, so this episode remains in missing results."],
  }], "the unreadable answer is an episode failure with no request cause");
});

test("the TMDB basic series summary and the TMDB series summary with external IDs are separate saved answers", async t => {
  const { rerun, state, requests } = await target(t, "2026-11-12T10:00:00Z");
  // TVDB 302's crosswalk names TMDB 12 as its series, so its summary with external IDs is requested.
  const basic = { id: 12, name: "Target (basic)" };
  const withExternalIds = { id: 12, name: "Target (external IDs)", external_ids: { tvdb_id: null } };
  let plexReportsTmdb12 = false;
  state.respond = url => {
    if (plexReportsTmdb12 && url.hostname === "plex" && url.pathname === "/library/metadata/target") return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "target", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://20" }, { id: "tmdb://12" }] }] } });
    if (url.pathname === "/3/tv/12") return Response.json(url.searchParams.get("append_to_response") === "external_ids" ? withExternalIds : basic);
    return undefined;
  };
  state.bodies.set("/3/find/302", found(tmdb2, 12));
  await rerun();
  assert.deepEqual(relationships()[keys.tmdbSeriesWithExternalIds(12)], { provider: "TMDB", value: withExternalIds, receivedAt: "2026-11-12T10:00:00.000Z" });
  assert.equal(Object.hasOwn(relationships(), keys.tmdbSeries(12)), false);

  // Plex now also reports TMDB 12 for the show: its basic summary is requested, not answered by the saved one with external IDs.
  plexReportsTmdb12 = true;
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  requests.length = 0;
  await rerun();
  assert.equal(requests.filter(pathname => pathname === "/3/tv/12").length, 1);
  assert.deepEqual(relationships()[keys.tmdbSeries(12)], { provider: "TMDB", value: basic, receivedAt: "2026-11-12T11:00:00.000Z" });
  assert.deepEqual(relationships()[keys.tmdbSeriesWithExternalIds(12)], { provider: "TMDB", value: withExternalIds, receivedAt: "2026-11-12T10:00:00.000Z" }, "both answers are kept");
});

test("a Trakt episode search and its TMDB episode validation are saved provider relationships", async t => {
  const { rerun, state, requests } = await target(t, "2026-11-12T10:00:00Z");
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  const search = [{ type: "episode", episode: { season: 1, number: 2, ids: { tvdb: 302, tmdb: 9002 } }, show: { ids: { tmdb: 10, tvdb: 20 } } }];
  state.respond = url => url.pathname === "/search/tvdb/302" ? Response.json(search) : url.pathname === "/search/tvdb/303" ? Response.json([]) : undefined;
  await rerun();
  const at = "2026-11-12T10:00:00.000Z";
  const saved = relationships();
  assert.deepEqual(saved[keys.traktEpisodeByTvdb(302)], { provider: "Trakt", value: search, receivedAt: at });
  assert.deepEqual(saved[keys.traktEpisodeByTvdb(303)], { provider: "Trakt", value: [], receivedAt: at });
  assert.deepEqual(saved[keys.tmdbEpisode(10, 1, 2)],{ provider: "TMDB", value: { id: 9002, season_number: 1, episode_number: 2, name: "Two" }, receivedAt: at });
  assert.equal(Object.hasOwn(saved, keys.tmdbEpisodeByTvdb(302)), false, "the Trakt match makes TVDB 302's TMDB crosswalk unnecessary");
  assert.deepEqual(tally(requests.filter(pathname => pathname.startsWith("/search/") || pathname.startsWith("/3/find/") || pathname.includes("/episode/"))), { "/search/tvdb/302": 1, "/search/tvdb/303": 1, "/3/tv/10/season/1/episode/2": 1, "/3/find/20": 1, "/3/find/303": 1 });
});

test("a failed TMDB series association raises one show-scoped lookup issue", async t => {
  const { rerun, state } = await target(t, "2026-11-12T10:00:00Z");
  state.statuses.set("/3/find/20", 404);
  const result = await rerun();
  assert.deepEqual(issuesOf(result), [{
    id: requestIssueId(keys.tmdbSeriesByTvdb(20)), failedAt: "2026-11-12T10:00:00.000Z",
    operation: "provider-association", provider: "TMDB", scope: "show", category: "Provider Lookup",
    show: { ratingKey: "ratingKey:target", title: "Target", tmdbId: 10, tvdbId: 20 },
    cause: "404 — record not found",
    action: "Check the Plex provider ID reference; retry after checking or correcting the reference.",
    lookup: {
      failureKind: "http", status: 404,
      impact: "Episode identity and coverage could not be fully verified. Available last-good results were retained.",
      requested: { provider: "TMDB", kind: "external ID search", id: 20 },
      source: [{ provider: "Plex", kind: "TVDB series", id: 20 }],
    },
  }]);

  state.statuses.delete("/3/find/20");
  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  assert.deepEqual(issuesOf(await rerun()), [], "the successful request resolves it");
});

// Fixed at the SHELFCHECK-40 cutover (SHELFCHECK-141): a TMDB series association and a TMDB episode
// crosswalk with the same numeric TVDB ID have separate saved relationship keys, so clearing one
// show's cache invalidates only that show's own episode crosswalks.
test("clearing one show's cache leaves current another show's episode crosswalk that has its TVDB series ID; clearing that show invalidates it", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T10:00:00Z") });
  // Other (TMDB 11 / TVDB 21) lists TVDB episode 20 at coordinates it does not own; Target is TVDB series 20.
  const tmdbOther: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Pilot", show: "other" };
  const tvdbEpisode20: Episode = { provider: "TVDB", id: 20, season: 2, episode: 1, name: "Pilot", show: "other" };
  const { rerun, clearCache, requests } = await harness(t, [tmdb1, tvdb1, tmdbOther, tvdbEpisode20], [tmdb1, tmdbOther]);
  await rerun();
  assert.deepEqual(shared(20), { value: empty, receivedAt: "2026-11-12T10:00:00.000Z" }, "Other's crosswalk of TVDB episode 20");
  assert.ok(Object.hasOwn(relationships(), keys.tmdbSeriesByTvdb(20)), "Target's association with TVDB series 20");
  assert.equal(Object.hasOwn(relationships(), keys.tmdbEpisodeByTvdb(20)), false, "is not an episode crosswalk of TVDB episode 20");

  t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
  await clearCache("ratingKey:target");
  assert.deepEqual(shared(20), { value: empty, receivedAt: "2026-11-12T10:00:00.000Z" }, "clearing Target's series association leaves the episode's shared evidence current");

  // Target requests its series association again; Other's same-day crosswalk of episode 20 is reused.
  requests.length = 0;
  await rerun();
  assert.equal(tally(requests)["/3/find/20"], 1);
  assert.deepEqual(shared(20), { value: empty, receivedAt: "2026-11-12T10:00:00.000Z" });

  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  await clearCache("ratingKey:other");
  assert.deepEqual(shared(20), { value: empty, receivedAt: "2026-11-12T10:00:00.000Z", invalidatedAt: "2026-11-12T12:00:00.000Z" }, "clearing Other's episode crosswalk invalidates it");
});
