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
const plexInputs = await import("../lib/plex-catalogues");
hook.deregister();

// The Plex scan signs in to TVDB once, after reading Plex, and its Manual Match
// recheck and later TVDB work share that one sign-in result.

type Scan = { scan: { status: string; error?: string }; report: { coverageRevision?: number; shows: { ratingKey: string }[] } | null; coverage: { revision: number; issues: { id: string; impacts?: string[]; causedBy?: string[] }[] } };
type Answer = Response | (() => Response);
/** A Plex show and its TMDB catalogue of season 1 `episodes` (one, `tmdbId * 10`, by default); `owns` lists the TVDB episodes it holds in Plex. */
type PlexShow = { ratingKey: string; title: string; tmdbId: number; episodes?: number[]; owns?: number[] };

/**
 * One Plex show (TMDB 10) and two saved Manual Matches, TMDB 101 with TVDB 201
 * and TMDB 102 with TVDB 202, behind a mocked fetch that records every request.
 * `signIn` answers each TVDB login attempt in turn; `member` may answer a
 * Manual Match member request; `plex` may answer a Plex request. `shows` lists
 * the Plex library, each show with its own TMDB catalogue of one episode; it may
 * change between scans.
 */
async function fixture(t: TestContext, { matches = true, shows = [{ ratingKey: "1", title: "Target", tmdbId: 10 }] as PlexShow[] } = {}) {
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
    first: first!, second: second!, reopen, requests, shows,
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
      const leaves = url.pathname.match(/^\/library\/metadata\/([^/]+)\/allLeaves$/);
      if (leaves) return Response.json({ MediaContainer: { Metadata: (f.shows.find(show => show.ratingKey === leaves[1])?.owns || []).map((id, index) => ({ ratingKey: `${leaves[1]}-${id}`, parentIndex: 1, index: index + 1, Guid: [{ id: `tvdb://${id}` }] })) } });
      const metadata = f.shows.map(show => ({ ratingKey: show.ratingKey, title: show.title, Guid: [{ id: `tmdb://${show.tmdbId}` }] }));
      const one = url.pathname.match(/^\/library\/metadata\/([^/]+)$/);
      return Response.json({ MediaContainer: { Metadata: one ? metadata.filter(show => show.ratingKey === one[1]) : metadata } });
    }
    if (url.pathname === "/v4/login") return answer(f.signIn[signInAttempts++] ?? Response.json({ data: { token: "unexpected-sign-in" } }));
    const held = f.member(url);
    if (held) return answer(held);
    const tvdbMember = url.pathname.match(/^\/v4\/episodes\/(\d+)\/extended$/);
    if (tvdbMember) return Response.json({ data: { id: Number(tvdbMember[1]) } });
    const tmdbMember = url.pathname.match(/^\/3\/tv\/10\/season\/1\/episode\/(\d+)$/);
    if (tmdbMember) return Response.json({ id: Number(tmdbMember[1]) });
    const catalogue = url.pathname.match(/^\/3\/tv\/(\d+)(\/season\/1)?$/);
    const show = catalogue && f.shows.find(show => show.tmdbId === Number(catalogue[1]));
    if (show && !catalogue![2]) return Response.json({ id: show.tmdbId, name: show.title, seasons: [{ season_number: 1 }] });
    if (show) return Response.json({ episodes: (show.episodes || [show.tmdbId * 10]).map((id, index) => ({ id, season_number: 1, episode_number: index + 1, name: `Episode ${id}`, air_date: "2020-01-01" })) });
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
    showScan: (ratingKey = "ratingKey:1") => completed({ ratingKey }),
    /** The TMDB show catalogues this scan read, by show ID. */
    cataloguesRead: () => [...new Set(requests.flatMap(request => request.url.pathname.match(/^\/3\/tv\/(\d+)\/season\/1$/)?.[1] ?? []))].map(Number).sort((a, b) => a - b),
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

/**
 * Three Plex shows for single-show scans of "Target". "Matched" (TMDB show 10) has TMDB episodes
 * 100 and 101 and holds none in Plex; "Holder" holds TVDB episode 201. The first Manual Match
 * (TMDB 101 with TVDB 201) therefore covers Matched's episode 101 from another show only while it
 * is healthy.
 */
const crossShowLibrary = (): PlexShow[] => [
  { ratingKey: "1", title: "Matched", tmdbId: 10, episodes: [100, 101] },
  { ratingKey: "2", title: "Target", tmdbId: 30 },
  { ratingKey: "3", title: "Holder", tmdbId: 40, owns: [201] },
];
type ReportedShow = { ratingKey: string; title: string; missing: unknown[]; catalogueSelection?: unknown; coverageOutcomes?: { provider: string; id: number; status: string }[] };
type Report = { coverageRevision?: number; shows: ReportedShow[] };
const report = (state: Scan) => state.report as unknown as Report;
const row = (state: Scan, ratingKey: string) => report(state).shows.find(show => show.ratingKey === ratingKey);
/** The status of Manual Match member TMDB 101 in Matched's result. */
const episode101 = (state: Scan) => row(state, "ratingKey:1")?.coverageOutcomes?.find(outcome => outcome.provider === "TMDB" && outcome.id === 101)?.status;
const resumePoint = () => ignoreResults.savedScanState("plex").resumePoint.read() as { coverageRevision?: number; shows: { ratingKey: string }[] } | null;
/** The report without each show's catalogue selection, which the report shows from the saved catalogue uses. */
const withoutCatalogueSelection = (state: Scan) => ({ ...report(state), shows: report(state).shows.map(show => { const rest = { ...show }; delete rest.catalogueSelection; return rest; }) });
/** Marks Matched's saved comparison inputs incomplete, so they cannot rebuild its result. */
const incompleteSavedInputs = () => plexInputs.savePlexComparison("ratingKey:1", { ...plexInputs.readPlexInputs().comparisons["ratingKey:1"], complete: false });

/** A full scan whose refused TVDB sign-in leaves both Manual Matches pending, so Matched misses episode 101. */
async function pendingAfterFullScan(f: Awaited<ReturnType<typeof fixture>>) {
  f.signIn = [refused];
  const full = await f.fullScan();
  assert.equal(f.health(f.first.id), "pending");
  assert.equal(episode101(full), "missing", "a pending Manual Match does not cover the episode");
  assert.equal(row(full, "ratingKey:1")?.missing.length, 2);
  return full;
}

test("a single-show scan whose recheck makes pending Manual Matches healthy keeps its own report, with every other show compared again from saved inputs", async (t) => {
  const f = await fixture(t, { shows: crossShowLibrary() });
  const full = await pendingAfterFullScan(f);
  // This scan signs in and the members answer, so both matches become healthy.
  f.signIn = [signedIn("scan-token"), signedIn("second")];
  const state = await f.showScan("ratingKey:2");
  assert.deepEqual(f.tvdbPaths().filter(pathname => pathname === "/v4/login"), ["/v4/login"], "one sign-in");
  assert.equal(f.health(f.first.id), "healthy");
  assert.ok(state.coverage.revision > (full.report?.coverageRevision ?? 0), "the recheck changed Manual Match health");
  assert.equal(state.report?.coverageRevision, state.coverage.revision, "the scan saves its own report at the new revision");
  assert.equal(episode101(state), "manual", "the healthy match now covers Matched's episode from Holder");
  assert.equal(row(state, "ratingKey:1")?.missing.length, 1, "Matched misses only episode 100");
  assert.deepEqual(f.cataloguesRead(), [30], "only the target is downloaded; the others are compared from saved inputs");
  assert.deepEqual(report(state).shows.map(show => show.title), ["Holder", "Matched", "Target"]);
  assert.ok(!resumePoint()?.shows.length, "no Resume point is left");
});

test("a single-show scan whose recheck changes health compares a show with incomplete saved inputs live", async (t) => {
  const f = await fixture(t, { shows: crossShowLibrary() });
  await pendingAfterFullScan(f);
  incompleteSavedInputs();
  f.signIn = [signedIn("scan-token")];
  const state = await f.showScan("ratingKey:2");
  assert.equal(state.report?.coverageRevision, state.coverage.revision);
  assert.deepEqual(f.cataloguesRead(), [10, 30], "Matched is downloaded and compared with the target");
  assert.equal(episode101(state), "manual");
  assert.equal(plexInputs.readPlexInputs().comparisons["ratingKey:1"].complete, true, "its saved inputs are repaired");
});

for (const [which, ratingKey, title] of [["another show can be compared neither from saved inputs nor live", "1", "Matched"], ["the target cannot be compared", "2", "Target"]] as const) {
  test(`a single-show scan whose recheck changes health keeps the earlier report at its revision when ${which}`, async (t) => {
    const f = await fixture(t, { shows: crossShowLibrary() });
    const full = await pendingAfterFullScan(f);
    if (ratingKey === "1") incompleteSavedInputs();
    f.plex = url => url.pathname === `/library/metadata/${ratingKey}` ? Response.json({}, { status: 403 }) : undefined;
    f.signIn = [signedIn("scan-token")];
    const state = await f.scanWith({ ratingKey: "ratingKey:2" });
    assert.equal(state.scan.status, "error");
    assert.match(state.scan.error || "", new RegExp(`changed a match's health, but ${title} could not be compared again`));
    assert.equal(f.health(f.first.id), "healthy", "the recheck's health is kept");
    // Only the catalogue the target downloaded, shown beside the results, is newer.
    assert.deepEqual(withoutCatalogueSelection(state), withoutCatalogueSelection(full), "the earlier report stays, at its earlier revision");
    assert.ok(state.coverage.revision > (state.report?.coverageRevision ?? 0));
    assert.ok(state.coverage.issues.some(issue => issue.id === `inventory-details:ratingKey:${ratingKey}`), "the show's own failure is recorded");
    const point = resumePoint();
    assert.ok(!point?.shows.some(show => show.ratingKey === `ratingKey:${ratingKey}`), "its earlier result enters no Resume point");
    if (point?.shows.length) assert.equal(point.coverageRevision, state.coverage.revision);
  });
}

test("a single-show scan does not take a revision change made during its health preparation for its own", async (t) => {
  const f = await fixture(t, { shows: crossShowLibrary() });
  const full = await pendingAfterFullScan(f);
  const db = (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!;
  let bumped = false;
  // Another change commits while a member request is out.
  f.member = url => {
    if (!bumped && url.pathname.startsWith("/3/tv/10/season/1/episode/")) { bumped = true; db.exec("UPDATE shelfcheck_coverage_state SET revision=revision+1"); }
    return undefined;
  };
  f.signIn = [signedIn("scan-token")];
  const state = await f.scanWith({ ratingKey: "ratingKey:2" });
  assert.ok(bumped);
  assert.equal(state.scan.status, "error");
  assert.match(state.scan.error || "", /full Plex search/);
  assert.deepEqual(state.report, full.report, "the earlier report is kept");
});

test("a single-show scan whose recheck changes no Manual Match's health compares only its show and carries over the rest", async (t) => {
  const f = await fixture(t, { shows: crossShowLibrary() });
  const full = await pendingAfterFullScan(f);
  f.signIn = [refused, signedIn("second")];
  const state = await f.showScan("ratingKey:2");
  assert.deepEqual(f.tvdbPaths(), ["/v4/login"]);
  assert.equal(state.coverage.revision, full.coverage.revision, "the recheck changed nothing");
  assert.equal(state.report?.coverageRevision, state.coverage.revision);
  assert.deepEqual(f.cataloguesRead(), [30], "only the target is compared");
  for (const key of ["ratingKey:1", "ratingKey:3"]) assert.deepEqual(row(state, key), row(full, key), `${key} is carried over unchanged`);
});
