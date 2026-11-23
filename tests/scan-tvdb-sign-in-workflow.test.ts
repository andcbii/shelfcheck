import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { memberVerificationIssueId, TVDB_AUTHENTICATION_ISSUE } from "../lib/coverage-issue-ids";
import { episode } from "./manual-match-members";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const scan = await import("../app/api/plex/scan/route");
const ignoreResults = await import("../lib/ignore-results");
const config = await import("../lib/server-config");
const store = await import("../lib/manual-coverage");
const savedIssues = await import("../lib/coverage-issues");
const { scanProviderClient } = await import("../lib/scan-provider-client");
const { PLEX_CACHE_VERSION } = await import("../lib/plex-scan-cache");
hook.deregister();

// The Plex scan signs in to TVDB once, after reading Plex, and its Manual Match
// recheck and later TVDB work share that one sign-in result.

type Scan = { scan: { status: string; error?: string }; report: { coverageRevision?: number; shows: { ratingKey: string }[] } | null; coverage: { revision: number; issues: { id: string; impacts?: string[]; causedBy?: string[] }[] } };
type Answer = Response | (() => Response);

/**
 * One Plex show (TMDB 10) and two saved Manual Matches, TMDB 101 with TVDB 201
 * and TMDB 102 with TVDB 202, behind a mocked fetch that records every request.
 * `signIn` answers each TVDB login attempt in turn; `member` may answer a
 * Manual Match member request; `plex` may answer a Plex request.
 */
async function fixture(t: TestContext, { matches = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-sign-in-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR, process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };
  const reopen = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };
  t.after(() => {
    reopen();
    for (const [i, key] of ["SHELFCHECK_DATA_DIR", "SHELFCHECK_CONFIG_DIR"].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    // A cooldown a case caused must not reach a later test.
    scanProviderClient.forgetProviderDeadlines();
    rmSync(dir, { recursive: true, force: true });
  });
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "tmdb-token", tvdbApiKey: "test" });
  ignoreResults.savedScanState("plex").options.patch({ diagnosticsEnabled: false });
  const first = matches ? store.saveCoverageMapping([episode("TMDB", 101), episode("TVDB", 201)]).mapping : undefined;
  const second = matches ? store.saveCoverageMapping([episode("TMDB", 102), episode("TVDB", 202)]).mapping : undefined;
  const requests: { url: URL; authorization: string | null }[] = [];
  const unexpected: string[] = [];
  t.after(() => assert.deepEqual(unexpected, [], "every request is one the fixture expects"));
  const f = {
    first: first!, second: second!, reopen, requests,
    signIn: [] as Answer[],
    member: (() => undefined) as (url: URL) => Answer | undefined,
    plex: (() => undefined) as (url: URL) => Answer | undefined,
    /** Set once a test mocks setTimeout: a scan then advances mocked time while it waits. */
    ticking: false,
  };
  const answer = (value: Answer) => typeof value === "function" ? value() : value;
  let signInAttempts = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.hostname === "plex") {
      const held = f.plex(url);
      if (held) return answer(held);
      if (url.pathname === "/library/sections") return Response.json({ MediaContainer: { Directory: [{ key: "1", type: "show" }] } });
      if (url.pathname.includes("allLeaves")) return Response.json({ MediaContainer: { Metadata: [] } });
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "1", title: "Target", Guid: [{ id: "tmdb://10" }] }] } });
    }
    if (url.pathname === "/v4/login") return answer(f.signIn[signInAttempts++] ?? Response.json({ data: { token: "unexpected-sign-in" } }));
    const held = f.member(url);
    if (held) return answer(held);
    const tvdbMember = url.pathname.match(/^\/v4\/episodes\/(\d+)\/extended$/);
    if (tvdbMember) return Response.json({ data: { id: Number(tvdbMember[1]) } });
    const tmdbMember = url.pathname.match(/^\/3\/tv\/10\/season\/1\/episode\/(\d+)$/);
    if (tmdbMember) return Response.json({ id: Number(tmdbMember[1]) });
    if (url.pathname === "/3/tv/10") return Response.json({ id: 10, name: "Target", seasons: [{ season_number: 1 }] });
    if (url.pathname === "/3/tv/10/season/1") return Response.json({ episodes: [{ id: 100, season_number: 1, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }] });
    if (url.pathname === "/3/tv/changes") return Response.json({ results: [], total_pages: 1 });
    if (url.pathname === "/v4/updates") return Response.json({ data: [] });
    unexpected.push(url.href);
    return Response.json({}, { status: 404 });
  });
  /** Starts a scan with `body` and waits for it to end, completed or not. */
  const scanWith = async (body: object): Promise<Scan> => {
    requests.length = 0;
    signInAttempts = 0;
    await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: JSON.stringify(body) }));
    for (let i = 0; i < 5000; i++) {
      const state = await (await scan.GET()).json() as Scan;
      if (state.scan.status !== "running") return state;
      if (f.ticking) { t.mock.timers.tick(250); await new Promise(resolve => setImmediate(resolve)); }
      else await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("scan timeout");
  };
  const completed = async (body: object) => { const state = await scanWith(body); assert.equal(state.scan.status, "completed", state.scan.error || ""); return state; };
  return Object.assign(f, {
    scanWith,
    fullScan: () => completed({}),
    showScan: () => completed({ ratingKey: "ratingKey:1" }),
    tvdbPaths: () => requests.filter(request => request.url.hostname.includes("thetvdb")).map(request => request.url.pathname),
    tmdbMemberPaths: () => requests.map(request => request.url.pathname).filter(pathname => pathname.startsWith("/3/tv/10/season/1/episode/")).sort(),
    memberIssue: (mappingId: string, provider: "TMDB" | "TVDB", id: number) => savedIssues.getCoverageIssue(memberVerificationIssueId(mappingId, { provider, id })),
    /** A saved Manual Match's health; a match never found unhealthy is healthy. */
    health: (mappingId: string) => { const mapping = store.listCoverageMappings().find(saved => saved.id === mappingId); assert.ok(mapping, "the Manual Match is kept"); return mapping.health || "healthy"; },
    /** The Scan Issues report as read from a reopened database. */
    reloadedIssues: async () => { reopen(); return (await (await scan.GET()).json() as Scan).coverage.issues; },
  });
}

const refused = () => Response.json({ status: "failure" }, { status: 401 });
const signedIn = (token: string) => () => Response.json({ data: { token } });
const SIGN_IN = TVDB_AUTHENTICATION_ISSUE;

/** Both Manual Matches' TVDB members wait under the sign-in issue, and their TMDB members were checked. */
function assertMembersWaitForSignIn(f: Awaited<ReturnType<typeof fixture>>) {
  assert.ok(!f.tvdbPaths().some(pathname => pathname.startsWith("/v4/episodes/")), "no TVDB member requests after a failed sign-in");
  assert.deepEqual(f.tmdbMemberPaths(), ["/3/tv/10/season/1/episode/101", "/3/tv/10/season/1/episode/102"], "TMDB members are still checked");
  for (const [mapping, id] of [[f.first, 201], [f.second, 202]] as const) {
    assert.deepEqual(f.memberIssue(mapping.id, "TVDB", id)?.causedBy, ["provider-authentication:TVDB"]);
    assert.equal(f.health(mapping.id), "pending", "the match is kept and waits for the next scan");
  }
  assert.equal(f.memberIssue(f.first.id, "TMDB", 101), undefined, "the TMDB member was verified");
  assert.ok(savedIssues.getCoverageIssue(SIGN_IN), "the sign-in issue the members point at is recorded");
}

/** The reloaded report shows the sign-in issue once with the blocked members folded under it. */
async function assertFoldedAfterReload(f: Awaited<ReturnType<typeof fixture>>) {
  const reloaded = await f.reloadedIssues();
  const signIn = reloaded.find(issue => issue.id === "provider-authentication:TVDB");
  assert.ok(signIn, "the sign-in issue is recorded");
  // Identical member impacts read as one line under their root.
  assert.ok(signIn.impacts?.some(impact => /Manual Match member/.test(impact)), "the blocked members fold under the sign-in issue");
  assert.ok(!reloaded.some(issue => issue.id.startsWith("member-verification:")), "no member issue shows on its own");
  for (const [mapping, id] of [[f.first, 201], [f.second, 202]] as const) assert.deepEqual(f.memberIssue(mapping.id, "TVDB", id)?.causedBy, ["provider-authentication:TVDB"], "each member still points at the sign-in issue after a reload");
}

test("a refused TVDB sign-in is the scan's one sign-in: Manual Match TVDB members wait under it, TMDB members are still checked, and the grouping survives a reload", async (t) => {
  const f = await fixture(t);
  // A second sign-in would succeed and clear the issue the members point at: it must never be sent.
  f.signIn = [refused, signedIn("second")];
  const state = await f.fullScan();
  assert.deepEqual(f.tvdbPaths(), ["/v4/login"], "one sign-in request and no other TVDB request");
  assertMembersWaitForSignIn(f);
  assert.equal(state.report?.coverageRevision, state.coverage.revision, "the scan keeps the report of its own recheck");
  await assertFoldedAfterReload(f);
});

test("every kind of failed TVDB sign-in links the blocked members the same way, within the provider client's own attempts", async (t) => {
  const f = await fixture(t);
  // Network retries back off on mocked time, so the test does not sleep.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.ticking = true;
  const unreachable = () => { throw new TypeError("fetch failed"); };
  const failures: [kind: string, attempt: Answer, attempts: number][] = [
    ["an HTTP error", refused, 1],
    ["a network error, retried by the provider client", unreachable, 5],
    ["an unreadable answer", () => new Response("{broken", { headers: { "Content-Type": "application/json" } }), 1],
    ["a too-long rate-limit wait", () => new Response(null, { status: 429, headers: { "Retry-After": "86400" } }), 1],
    ["a missing token", () => Response.json({ data: {} }), 1],
  ];
  for (const [kind, attempt, attempts] of failures) {
    // A good scan first: its sign-in clears the earlier sign-in issue, and checked members clear theirs.
    f.signIn = [signedIn("good")];
    await f.fullScan();
    assert.equal(savedIssues.getCoverageIssue(SIGN_IN), undefined, `a successful sign-in clears the earlier sign-in issue (before ${kind})`);
    assert.equal(f.memberIssue(f.first.id, "TVDB", 201), undefined);
    assert.equal(f.health(f.first.id), "healthy");
    f.signIn = [...Array(attempts).fill(attempt), signedIn("second")];
    await f.fullScan();
    assert.deepEqual(f.tvdbPaths(), Array(attempts).fill("/v4/login"), `${kind}: one sign-in within the client's bounded attempts, and no second sign-in`);
    assertMembersWaitForSignIn(f);
    // TVDB asked for a day: a restart would forget it; so does the next case.
    scanProviderClient.forgetProviderDeadlines();
  }
});

test("after a successful TVDB sign-in the recheck uses its token, and member failures are the members' own", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.ticking = true;
  f.signIn = [refused];
  await f.fullScan();
  assert.ok(savedIssues.getCoverageIssue(SIGN_IN));
  // TVDB 201 is gone; TVDB 202 cannot be reached; TMDB 102's coordinates no longer answer.
  f.signIn = [signedIn("scan-token"), signedIn("second")];
  f.member = url => url.pathname === "/v4/episodes/201/extended" ? Response.json({}, { status: 404 })
    : url.pathname === "/v4/episodes/202/extended" ? () => { throw new TypeError("fetch failed"); }
    : url.pathname === "/3/tv/10/season/1/episode/102" ? Response.json({}, { status: 404 })
    : undefined;
  await f.fullScan();
  assert.equal(f.tvdbPaths().filter(pathname => pathname === "/v4/login").length, 1, "one sign-in");
  const memberRequests = f.requests.filter(request => request.url.pathname.startsWith("/v4/episodes/"));
  assert.ok(memberRequests.length, "TVDB members are requested after a good sign-in");
  assert.ok(memberRequests.every(request => request.authorization === "Bearer scan-token"), "with the scan's sign-in token");
  assert.equal(savedIssues.getCoverageIssue(SIGN_IN), undefined, "the earlier sign-in issue is cleared");
  assert.equal(f.health(f.first.id), "needs-review", "a TVDB episode 404 still needs review");
  assert.equal(f.health(f.second.id), "pending", "a member network failure or TMDB coordinate miss is pending");
  for (const [mapping, provider, id] of [[f.first, "TVDB", 201], [f.second, "TVDB", 202], [f.second, "TMDB", 102]] as const) {
    const issue = f.memberIssue(mapping.id, provider, id);
    assert.ok(issue, `${provider} ${id} has its own issue`);
    assert.equal(issue.causedBy, undefined, `${provider} ${id} gets no sign-in cause`);
  }
  // A match needing review waits for an edit: a later good scan does not recheck or revive it.
  f.member = () => undefined;
  f.signIn = [signedIn("scan-token")];
  await f.fullScan();
  assert.ok(!f.tvdbPaths().includes("/v4/episodes/201/extended"), "a match needing review is skipped");
  assert.equal(f.health(f.first.id), "needs-review");
  assert.equal(f.health(f.second.id), "healthy");
});

test("a scan that fails reading Plex, or whose single show is gone from Plex, sends no TVDB sign-in and leaves earlier issues as they were", async (t) => {
  const f = await fixture(t);
  f.signIn = [refused];
  await f.fullScan();
  const stored = () => [savedIssues.getCoverageIssue(SIGN_IN), f.memberIssue(f.first.id, "TVDB", 201), f.memberIssue(f.second.id, "TVDB", 202)].map(issue => JSON.stringify(issue));
  const before = stored();
  const healthBefore = [f.health(f.first.id), f.health(f.second.id)];
  const plexFailures: [failure: string, plex: (url: URL) => Answer | undefined, body: object][] = [
    ["Plex sections failure", url => url.pathname === "/library/sections" ? Response.json({}, { status: 403 }) : undefined, {}],
    ["Plex library failure", url => url.pathname === "/library/sections/1/all" ? Response.json({}, { status: 403 }) : undefined, {}],
    ["single show missing from Plex", () => undefined, { ratingKey: "ratingKey:gone" }],
  ];
  for (const [failure, plex, body] of plexFailures) {
    f.plex = plex;
    f.signIn = [signedIn("would-clear")];
    const state = await f.scanWith(body);
    assert.equal(state.scan.status, "error", failure);
    assert.deepEqual(f.tvdbPaths(), [], `${failure}: no TVDB sign-in or member request`);
    assert.deepEqual(stored(), before, `${failure}: the earlier sign-in and member issues are left as they were`);
    assert.deepEqual([f.health(f.first.id), f.health(f.second.id)], healthBefore);
  }
  await assertFoldedAfterReload(f);
});

test("a scan that fails after its Manual Match recheck leaves the sign-in issue and its folded members intact after a reload", async (t) => {
  const f = await fixture(t);
  // The report store fails at the final commit, long after the recheck.
  (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!.exec("CREATE TRIGGER fail_report BEFORE UPDATE OF report ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;");
  f.signIn = [refused, signedIn("second")];
  const state = await f.scanWith({});
  assert.equal(state.scan.status, "error");
  assert.equal(state.scan.error, "report store unavailable");
  assertMembersWaitForSignIn(f);
  await assertFoldedAfterReload(f);
});

test("a single-show scan signs in once and still rechecks every Manual Match", async (t) => {
  const f = await fixture(t);
  // A single-show scan needs a report at the current coverage revision, so the full scan already left the matches pending.
  f.signIn = [refused];
  await f.fullScan();
  f.signIn = [refused, signedIn("second")];
  await f.showScan();
  assert.deepEqual(f.tvdbPaths(), ["/v4/login"]);
  assertMembersWaitForSignIn(f);
  await assertFoldedAfterReload(f);
});

test("a single-show scan after a successful TVDB sign-in sends member requests with its token and clears the earlier sign-in issue", async (t) => {
  const f = await fixture(t);
  f.signIn = [refused];
  await f.fullScan();
  assert.ok(savedIssues.getCoverageIssue(SIGN_IN));
  // TVDB refuses each member on its own, so both matches stay pending and the single-show scan keeps its report revision.
  f.signIn = [signedIn("scan-token"), signedIn("second")];
  f.member = url => url.pathname.startsWith("/v4/episodes/") ? Response.json({}, { status: 403 }) : undefined;
  await f.showScan();
  assert.equal(f.tvdbPaths().filter(pathname => pathname === "/v4/login").length, 1, "one sign-in");
  const memberRequests = f.requests.filter(request => request.url.pathname.startsWith("/v4/episodes/"));
  assert.deepEqual(memberRequests.map(request => request.url.pathname).sort(), ["/v4/episodes/201/extended", "/v4/episodes/202/extended"], "TVDB members are requested after a good sign-in");
  assert.ok(memberRequests.every(request => request.authorization === "Bearer scan-token"), "with the scan's sign-in token");
  assert.equal(savedIssues.getCoverageIssue(SIGN_IN), undefined, "the earlier sign-in issue is cleared");
  for (const [mapping, id] of [[f.first, 201], [f.second, 202]] as const) {
    const issue = f.memberIssue(mapping.id, "TVDB", id);
    assert.ok(issue, `TVDB ${id} has its own issue`);
    assert.equal(issue.causedBy, undefined, `TVDB ${id} no longer points at the sign-in issue`);
  }
});

test("a scan without Manual Matches still signs in to TVDB once", async (t) => {
  const f = await fixture(t, { matches: false });
  f.signIn = [signedIn("only"), signedIn("second")];
  await f.fullScan();
  assert.deepEqual(f.tvdbPaths(), ["/v4/login"]);
  f.signIn = [refused, signedIn("second")];
  await f.fullScan();
  assert.deepEqual(f.tvdbPaths(), ["/v4/login"]);
  assert.ok(savedIssues.getCoverageIssue(SIGN_IN), "a failed sign-in is still recorded for catalogue downloads and freshness");
});

test("a recheck that changes a Manual Match's health keeps the scan's own report, and does not resume from a Resume point saved before the change", async (t) => {
  const f = await fixture(t);
  const revision = store.coverageState().revision;
  // A usable Resume point of the Plex show, saved at the current coverage revision.
  ignoreResults.savedScanState("plex").resumePoint.write({ shows: [{ ratingKey: "ratingKey:1", title: "Saved before the change", plexEpisodes: 0, missing: [] }], scanCache: { "ratingKey:1": {} }, cacheVersion: PLEX_CACHE_VERSION, autoCompoundEpisodes: true, savedAt: new Date().toISOString(), coverageRevision: revision });
  f.signIn = [refused];
  const state = await f.fullScan();
  assert.ok(state.coverage.revision > revision, "the recheck changed Manual Match health");
  assert.equal(state.report?.coverageRevision, state.coverage.revision, "the scan commits its own report at the new revision");
  assert.deepEqual((state.report as unknown as { shows: { title: string }[] }).shows.map(show => show.title), ["Target"], "the show is compared again, not resumed");
  assert.ok(f.requests.some(request => request.url.pathname === "/3/tv/10/season/1"), "its catalogue was read for this revision");
});

test("a recheck that changes a Manual Match's health does not reuse a Plex report saved before the change as current", async (t) => {
  const f = await fixture(t);
  const revision = store.coverageState().revision;
  // A usable saved report of the Plex show at the current coverage revision, with no Resume point.
  ignoreResults.savedScanState("plex").report.write({ shows: [{ ratingKey: "ratingKey:1", title: "Saved before the change", plexEpisodes: 0, missing: [] }], scanCache: { "ratingKey:1": {} }, cacheVersion: PLEX_CACHE_VERSION, autoCompoundEpisodes: true, lastScan: "2020-01-01T00:00:00.000Z", coverageRevision: revision });
  f.signIn = [refused];
  const state = await f.fullScan();
  assert.ok(state.coverage.revision > revision, "the recheck changed Manual Match health");
  assert.equal(state.report?.coverageRevision, state.coverage.revision, "the new report is saved at the new revision");
  assert.deepEqual((state.report as unknown as { shows: { title: string }[] }).shows.map(show => show.title), ["Target"], "the show is compared again, not taken from the saved report");
  assert.ok(f.requests.some(request => request.url.pathname === "/3/tv/10/season/1"), "its catalogue was read for this revision");
});
