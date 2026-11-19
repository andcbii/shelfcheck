import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const config = await import("../lib/server-config");
hook.deregister();

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so each TVDB episode needs a
// crosswalk. TMDB's own find returns nothing, so only Trakt's episode search can match them.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const mapping = (tvdb: Episode, tmdb: Episode) => ({ type: "episode", episode: { season: tmdb.season, number: tmdb.episode, ids: { tvdb: tvdb.id, tmdb: tmdb.id } }, show: { ids: { tmdb: 10, tvdb: 20 } } });
const missingKeys = (result: { report: { shows: { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[] }[] } }) =>
  (result.report.shows.find(item => item.ratingKey === "ratingKey:target")?.missing || []).flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
const authorization = (init?: RequestInit) => new Headers(init?.headers).get("Authorization");

test("a Plex scan run refreshes a Trakt token that expires mid-run and its remaining Trakt checks succeed", async t => {
  const { rerun, state } = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2], [tmdb1, tmdb2]);
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  state.bodies.set("/3/find/301", { tv_episode_results: [] });
  state.bodies.set("/3/find/302", { tv_episode_results: [] });
  let searches = 0;
  const tokenRequests: unknown[] = [];
  const searchTokens: (string | null)[] = [];
  state.respond = (url, init) => {
    if (url.hostname === "auth.trakt.tv") {
      tokenRequests.push(JSON.parse(String(init?.body)));
      return Response.json({ access_token: "new", refresh_token: "refresh-2", expires_in: 86400, created_at: Math.floor(Date.now() / 1000) });
    }
    const search = url.pathname.match(/^\/search\/tvdb\/(\d+)$/);
    if (!search) return undefined;
    searches += 1;
    searchTokens.push(authorization(init));
    // The old token expires after the first search.
    if (authorization(init) === "Bearer old" && searches > 1) return Response.json({ error: "expired" }, { status: 401 });
    return Response.json([mapping(search[1] === "301" ? tvdb1 : tvdb2, search[1] === "301" ? tmdb1 : tmdb2)]);
  };
  const result = await rerun();
  assert.deepEqual(missingKeys(result), [], "both TVDB episodes are matched through Trakt");
  assert.equal(tokenRequests.length, 1, "one refresh");
  assert.equal((tokenRequests[0] as { grant_type: string }).grant_type, "refresh_token");
  assert.deepEqual(searchTokens, ["Bearer old", "Bearer old", "Bearer new"], "the rejected search is replayed once with the refreshed token");
  const saved = await config.readTraktCredentials();
  assert.equal(saved?.accessToken, "new");
  assert.equal(saved?.refreshToken, "refresh-2");
  const issues = (result as unknown as { coverage: { issues: { provider?: string }[] } }).coverage.issues;
  assert.deepEqual(issues.filter(issue => issue.provider === "Trakt"), [], "no Trakt failure is recorded");
});

test("when Trakt rejects the token for every lookup at once, the Plex scan run refreshes it once", async t => {
  const { rerun, state } = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2], [tmdb1, tmdb2]);
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  state.bodies.set("/3/find/301", { tv_episode_results: [] });
  state.bodies.set("/3/find/302", { tv_episode_results: [] });
  let refreshes = 0;
  state.respond = (url, init) => {
    if (url.hostname === "auth.trakt.tv") { refreshes += 1; return Response.json({ access_token: "new", refresh_token: "refresh-2", expires_in: 86400, created_at: Math.floor(Date.now() / 1000) }); }
    const search = url.pathname.match(/^\/search\/tvdb\/(\d+)$/);
    if (!search) return undefined;
    if (authorization(init) !== "Bearer new") return Response.json({ error: "expired" }, { status: 401 });
    return Response.json([mapping(search[1] === "301" ? tvdb1 : tvdb2, search[1] === "301" ? tmdb1 : tmdb2)]);
  };
  const result = await rerun();
  assert.deepEqual(missingKeys(result), []);
  assert.equal(refreshes, 1);
});

type Issue = { id: string; operation: string; provider?: string; crosswalk?: string; cause: string; lookup?: { status?: number }; episode?: { id?: number } };
const issuesOf = (result: unknown) => (result as { coverage: { issues: Issue[] } }).coverage.issues;
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const traktEpisodeIssues = (result: unknown) => issuesOf(result).filter(issue => issue.id !== "provider-authentication:Trakt" && (issue.provider === "Trakt" || issue.crosswalk === "Trakt" || /Trakt/.test(issue.cause)));

test("a Trakt login that cannot be refreshed raises one Coverage Issue, stops further Trakt lookups and leaves TMDB fallback working", async t => {
  const { rerun, state } = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2], [tmdb1, tmdb2]);
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  const saved = await config.readTraktCredentials();
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  let searches = 0;
  state.respond = (url) => {
    if (url.hostname === "auth.trakt.tv") return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (url.pathname.startsWith("/search/tvdb/")) { searches += 1; return Response.json({ error: "expired" }, { status: 401 }); }
    return undefined;
  };
  const result = await rerun();
  assert.deepEqual(missingKeys(result), [], "TMDB fallback still matches both episodes");
  const login = issuesOf(result).filter(issue => issue.id === "provider-authentication:Trakt");
  assert.equal(login.length, 1);
  assert.equal(login[0].lookup?.status, 400, "the refresh failure's own status, not a made-up expiry");
  assert.deepEqual(traktEpisodeIssues(result), [], "no per-episode Trakt failures");
  assert.equal(searches, 1, "the queued lookup is not sent once the login has failed");
  assert.deepEqual(await config.readTraktCredentials(), saved, "the saved login is untouched");
});

test("a rejected Trakt login keeps earlier episode evidence, and its Coverage Issue clears only after a Trakt lookup succeeds", async t => {
  const { rerun, state } = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2], [tmdb1, tmdb2]);
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  let mode: "one-fails" | "forbidden" | "working" = "one-fails";
  state.respond = (url) => {
    const search = url.pathname.match(/^\/search\/tvdb\/(\d+)$/);
    if (!search) return undefined;
    if (mode === "forbidden") return Response.json({}, { status: 403 });
    if (mode === "one-fails" && search[1] === "302") return Response.json({}, { status: 404 });
    return Response.json([mapping(search[1] === "301" ? tvdb1 : tvdb2, search[1] === "301" ? tmdb1 : tmdb2)]);
  };
  const first = await rerun();
  const earlier = traktEpisodeIssues(first).map(issue => issue.id).sort();
  assert.ok(earlier.length > 0, "the failed Trakt lookup for 302 is recorded");

  mode = "forbidden";
  const rejected = await rerun();
  assert.equal(issuesOf(rejected).filter(issue => issue.id === "provider-authentication:Trakt")[0]?.lookup?.status, 403);
  assert.deepEqual(traktEpisodeIssues(rejected).map(issue => issue.id).sort(), earlier, "earlier episode evidence stays; no new per-episode failures");
  assert.deepEqual(missingKeys(rejected), []);

  mode = "working";
  const recovered = await rerun();
  assert.deepEqual(issuesOf(recovered).filter(issue => issue.id === "provider-authentication:Trakt"), [], "a successful Trakt lookup clears the login issue");
  assert.deepEqual(traktEpisodeIssues(recovered), []);
});
