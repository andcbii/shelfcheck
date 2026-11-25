import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { TVDB_AUTHENTICATION_ISSUE } from "../lib/coverage-issue-ids";
import { episode } from "./manual-match-members";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const scan = await import("../app/api/plex/scan/route");
const ignoreResults = await import("../lib/ignore-results");
const config = await import("../lib/server-config");
const store = await import("../lib/manual-coverage");
const savedIssues = await import("../lib/coverage-issues");
const { scanProviderClient } = await import("../lib/scan-provider-client");
hook.deregister();

// The Plex scan signs in to TVDB once, after reading Plex, and its later TVDB work shares
// that one sign-in result. Manual Matches have no health (ADR-0008), so the scan makes no
// request for their members and a failed sign-in never stops a Manual Match covering.

type Scan = { scan: { status: string; error?: string }; report: { coverageRevision?: number; shows: { ratingKey: string }[] } | null; coverage: { revision: number; issues: { id: string; impacts?: string[]; causedBy?: string[] }[] } };
type Answer = Response | (() => Response);
/**
 * A Plex show and its TMDB catalogue of season 1 `episodes` (one, `tmdbId * 10`, by default); `owns`
 * and `ownsTmdb` list the TVDB and TMDB episodes it holds in Plex. A show with a `tvdbId` also has a
 * TVDB catalogue of season 1 `tvdbEpisodes`.
 */
type PlexShow = { ratingKey: string; title: string; tmdbId: number; episodes?: number[]; owns?: number[]; ownsTmdb?: number[]; tvdbId?: number; tvdbEpisodes?: number[] };

/**
 * One Plex show (TMDB 10, whose catalogue lists both TMDB members, so no member is a removal
 * candidate) and two saved Manual Matches, TMDB 101 with TVDB 201 and TMDB 102 with TVDB 202, behind a mocked fetch that records every request.
 * `signIn` answers each TVDB login attempt in turn; `plex` may answer a Plex
 * request. A Manual Match member request is unexpected. `shows` lists
 * the Plex library, each show with its own TMDB catalogue of one episode; it may
 * change between scans.
 */
async function fixture(t: TestContext, { matches = true, shows = [{ ratingKey: "1", title: "Target", tmdbId: 10, episodes: [100, 101, 102] }] as PlexShow[] } = {}) {
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
      const holder = leaves && f.shows.find(show => show.ratingKey === leaves[1]);
      if (leaves) return Response.json({ MediaContainer: { Metadata: [...(holder?.owns || []).map(id => `tvdb://${id}`), ...(holder?.ownsTmdb || []).map(id => `tmdb://${id}`)].map((guid, index) => ({ ratingKey: `${leaves[1]}-${guid}`, parentIndex: 1, index: index + 1, Guid: [{ id: guid }] })) } });
      const metadata = f.shows.map(show => ({ ratingKey: show.ratingKey, title: show.title, Guid: [{ id: `tmdb://${show.tmdbId}` }, ...(show.tvdbId ? [{ id: `tvdb://${show.tvdbId}` }] : [])] }));
      const one = url.pathname.match(/^\/library\/metadata\/([^/]+)$/);
      return Response.json({ MediaContainer: { Metadata: one ? metadata.filter(show => show.ratingKey === one[1]) : metadata } });
    }
    if (url.pathname === "/v4/login") return answer(f.signIn[signInAttempts++] ?? Response.json({ data: { token: "unexpected-sign-in" } }));
    const catalogue = url.pathname.match(/^\/3\/tv\/(\d+)(\/season\/1)?$/);
    const show = catalogue && f.shows.find(show => show.tmdbId === Number(catalogue[1]));
    if (show && !catalogue![2]) return Response.json({ id: show.tmdbId, name: show.title, seasons: [{ season_number: 1 }] });
    if (show) return Response.json({ episodes: (show.episodes || [show.tmdbId * 10]).map((id, index) => ({ id, season_number: 1, episode_number: index + 1, name: `Episode ${id}`, air_date: "2020-01-01" })) });
    const series = url.pathname.match(/^\/v4\/series\/(\d+)(\/episodes\/default)?$/);
    const tvdbShow = series && f.shows.find(show => show.tvdbId === Number(series[1]));
    if (tvdbShow && !series![2]) return Response.json({ data: { id: tvdbShow.tvdbId, name: tvdbShow.title, slug: `show-${tvdbShow.tvdbId}` } });
    if (tvdbShow) return Response.json({ data: { episodes: (tvdbShow.tvdbEpisodes || []).map((id, index) => ({ id, seasonNumber: 1, number: index + 1, name: `Episode ${id}`, aired: "2020-01-01" })) } });
    // A completed full scan looks up the Show year of each Manual Match show no Plex show holds.
    if (series && !series[2]) return Response.json({ data: { id: Number(series[1]), name: `TVDB ${series[1]}`, year: "1999" } });
    const found = url.pathname.match(/^\/3\/find\/(\d+)$/);
    const foundShow = found && f.shows.find(show => show.tvdbId === Number(found[1]));
    if (foundShow) return Response.json({ tv_results: [{ id: foundShow.tmdbId, name: foundShow.title }], tv_episode_results: [] });
    // An uncovered TVDB episode's TMDB crosswalk finds nothing.
    if (found) return Response.json({ tv_results: [], tv_episode_results: [] });
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
    /** The Scan Issues report as read from a reopened database. */
    reloadedIssues: async () => { reopen(); return (await (await scan.GET()).json() as Scan).coverage.issues; },
  });
}

const refused = () => Response.json({ status: "failure" }, { status: 401 });
const signedIn = (token: string) => () => Response.json({ data: { token } });
const SIGN_IN = TVDB_AUTHENTICATION_ISSUE;

/** The sign-in issue is recorded, no Manual Match member was requested and no member issue exists. */
function assertSignInIssueOnly(f: Awaited<ReturnType<typeof fixture>>) {
  assert.ok(!f.requests.some(request => /^\/v4\/episodes\/|^\/3\/tv\/\d+\/season\/\d+\/episode\//.test(request.url.pathname)), "no Manual Match member is requested");
  assert.ok(savedIssues.getCoverageIssue(SIGN_IN), "the sign-in issue is recorded");
  assert.ok(!savedIssues.listCoverageIssues().some(issue => issue.operation === "member-verification"), "no member issue is recorded");
}

/** The report, read from a reopened database, still shows the sign-in issue and no member issue. */
async function assertSignInIssueAfterReload(f: Awaited<ReturnType<typeof fixture>>) {
  const reloaded = await f.reloadedIssues();
  assert.ok(reloaded.some(issue => issue.id === SIGN_IN), "the sign-in issue is recorded");
  assert.ok(!reloaded.some(issue => issue.id.startsWith("member-verification:")), "no member issue shows");
}

/**
 * Three Plex shows. "Matched" (TMDB show 10, TVDB series 20) has TVDB episodes 201 and 202 and
 * holds none in Plex; "Holder" holds TMDB episode 101. The first Manual Match (TMDB 101 with
 * TVDB 201) therefore covers Matched's TVDB episode 201 from another show, one way (ADR-0008).
 * Matched lists both Manual Matches' members, so its fresh downloads remove none.
 */
const crossShowLibrary = (): PlexShow[] => [
  { ratingKey: "1", title: "Matched", tmdbId: 10, episodes: [100, 101, 102], tvdbId: 20, tvdbEpisodes: [201, 202] },
  { ratingKey: "2", title: "Target", tmdbId: 30 },
  { ratingKey: "3", title: "Holder", tmdbId: 40, ownsTmdb: [101] },
];
type ReportedShow = { ratingKey: string; title: string; missing: unknown[]; coverageOutcomes?: { provider: string; id: number; status: string }[] };
const row = (state: Scan, ratingKey: string) => (state.report as unknown as { shows: ReportedShow[] }).shows.find(show => show.ratingKey === ratingKey);
/** The status of Manual Match member TVDB 201 in Matched's result. */
const episode201 = (state: Scan) => row(state, "ratingKey:1")?.coverageOutcomes?.find(outcome => outcome.provider === "TVDB" && outcome.id === 201)?.status;

test("a refused TVDB sign-in is the scan's one sign-in, requests no Manual Match member and stops no Manual Match covering", async (t) => {
  const f = await fixture(t, { shows: crossShowLibrary() });
  const revision = store.coverageState().revision;
  // A good scan first saves Matched's TVDB catalogue.
  f.signIn = [signedIn("good")];
  assert.equal(episode201(await f.fullScan()), "manual", "the Manual Match covers Matched's episode from Holder");
  // A second sign-in would succeed and clear the issue: it must never be sent.
  f.signIn = [refused, signedIn("second")];
  const state = await f.fullScan();
  assert.deepEqual(f.tvdbPaths(), ["/v4/login"], "one sign-in request and no other TVDB request");
  assertSignInIssueOnly(f);
  assert.equal(episode201(state), "manual", "the Manual Match still covers Matched's episode from Holder");
  assert.equal(state.coverage.revision, revision, "the scan changes no Manual Match");
  assert.equal(state.report?.coverageRevision, revision);
  await assertSignInIssueAfterReload(f);
});

test("every kind of failed TVDB sign-in is one sign-in, within the provider client's own attempts", async (t) => {
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
    // A good scan first: its sign-in clears the earlier sign-in issue.
    f.signIn = [signedIn("good")];
    await f.fullScan();
    assert.equal(savedIssues.getCoverageIssue(SIGN_IN), undefined, `a successful sign-in clears the earlier sign-in issue (before ${kind})`);
    f.signIn = [...Array(attempts).fill(attempt), signedIn("second")];
    await f.fullScan();
    assert.deepEqual(f.tvdbPaths(), Array(attempts).fill("/v4/login"), `${kind}: one sign-in within the client's bounded attempts, and no second sign-in`);
    assertSignInIssueOnly(f);
    // TVDB asked for a day: a restart would forget it; so does the next case.
    scanProviderClient.forgetProviderDeadlines();
  }
});

test("a successful TVDB sign-in clears the earlier sign-in issue, and the scan's TVDB requests use its token", async (t) => {
  const f = await fixture(t);
  f.signIn = [refused];
  await f.fullScan();
  assert.ok(savedIssues.getCoverageIssue(SIGN_IN));
  f.signIn = [signedIn("scan-token"), signedIn("second")];
  await f.fullScan();
  assert.equal(f.tvdbPaths().filter(pathname => pathname === "/v4/login").length, 1, "one sign-in");
  const tvdbRequests = f.requests.filter(request => request.url.hostname.includes("thetvdb") && request.url.pathname !== "/v4/login");
  assert.ok(tvdbRequests.every(request => request.authorization === "Bearer scan-token"), "with the scan's sign-in token");
  assert.equal(savedIssues.getCoverageIssue(SIGN_IN), undefined, "the earlier sign-in issue is cleared");
});

test("a scan that fails reading Plex, or whose single show is gone from Plex, sends no TVDB sign-in and leaves earlier issues as they were", async (t) => {
  const f = await fixture(t);
  f.signIn = [refused];
  await f.fullScan();
  const before = JSON.stringify(savedIssues.getCoverageIssue(SIGN_IN));
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
    assert.deepEqual(f.tvdbPaths(), [], `${failure}: no TVDB sign-in`);
    assert.equal(JSON.stringify(savedIssues.getCoverageIssue(SIGN_IN)), before, `${failure}: the earlier sign-in issue is left as it was`);
  }
  await assertSignInIssueAfterReload(f);
});

test("a scan that fails at its report keeps its sign-in issue after a reload", async (t) => {
  const f = await fixture(t);
  // The report store fails at the final commit.
  (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!.exec("CREATE TRIGGER fail_report BEFORE UPDATE OF report ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;");
  f.signIn = [refused, signedIn("second")];
  const state = await f.scanWith({});
  assert.equal(state.scan.status, "error");
  assert.equal(state.scan.error, "report store unavailable");
  assertSignInIssueOnly(f);
  await assertSignInIssueAfterReload(f);
});

test("a single-show scan signs in once, compares only its show and carries over the rest", async (t) => {
  const f = await fixture(t, { shows: crossShowLibrary() });
  f.signIn = [signedIn("good")];
  const full = await f.fullScan();
  f.signIn = [refused, signedIn("second")];
  const state = await f.showScan("ratingKey:2");
  assert.deepEqual(f.tvdbPaths(), ["/v4/login"]);
  assertSignInIssueOnly(f);
  assert.equal(state.coverage.revision, full.coverage.revision);
  assert.equal(state.report?.coverageRevision, state.coverage.revision);
  assert.deepEqual(f.cataloguesRead(), [30], "only the target is compared");
  for (const key of ["ratingKey:1", "ratingKey:3"]) assert.deepEqual(row(state, key), row(full, key), `${key} is carried over unchanged`);
  assert.equal(episode201(state), "manual");
});

test("a single-show scan after a successful TVDB sign-in clears the earlier sign-in issue", async (t) => {
  const f = await fixture(t);
  f.signIn = [refused];
  await f.fullScan();
  assert.ok(savedIssues.getCoverageIssue(SIGN_IN));
  f.signIn = [signedIn("scan-token"), signedIn("second")];
  await f.showScan();
  assert.equal(f.tvdbPaths().filter(pathname => pathname === "/v4/login").length, 1, "one sign-in");
  assert.equal(savedIssues.getCoverageIssue(SIGN_IN), undefined, "the earlier sign-in issue is cleared");
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
