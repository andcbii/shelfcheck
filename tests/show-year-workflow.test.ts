import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const scan = await import("../app/api/plex/scan/route");
const coverage = await import("../app/api/plex/manual-coverage/route");
const ignoreResults = await import("../lib/ignore-results");
const config = await import("../lib/server-config");
hook.deregister();

/**
 * Show year on Manual Matches (SHELFCHECK-201): the year Plex gives a provider show in the latest
 * completed full scan, read back through the Manual Coverage route after real Plex scans against a
 * temporary database, with Plex, TMDB and TVDB faked over HTTP.
 */

/** One Plex show record: `ids` are its provider GUIDs, such as "tmdb://10". */
type PlexRecord = { ratingKey: string; title: string; year?: unknown; guid?: string; ids: string[] };
type Mapping = { id: string; revision: unknown };
type Global = typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanRun?: { owner?: unknown } };

/** A provider show's S01E`number` (S01E01 unless given), numbered from its show ID so IDs never collide. */
const episodeId = (showId: number, number = 1) => showId * 100 + number;

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "show-year-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR, process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as Global;
  const restart = () => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase; };
  t.after(() => {
    restart();
    for (const [i, key] of ["SHELFCHECK_DATA_DIR", "SHELFCHECK_CONFIG_DIR"].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir, { recursive: true, force: true });
  });
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "test", tvdbApiKey: "test" });
  ignoreResults.savedScanState("plex").options.patch({ diagnosticsEnabled: false });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-11T12:00:00Z") });
  const state = {
    /** The Plex libraries, each a list of show records. */
    libraries: [[]] as PlexRecord[][],
    /** TVDB series whose summary request fails. */
    failedTvdbSummaries: new Set<number>(),
    /**
     * Each provider show summary's raw year field, by "TMDB 10" or "TVDB 20": TMDB `first_air_date`
     * or TVDB `year`, absent when undefined. Shows not listed give 1999.
     */
    summaryYears: new Map<string, unknown>(),
    /** Request paths answered with this HTTP status instead. */
    failures: new Map<string, number>(),
    /** Requests, by path, held until released, to stop a scan part-way. */
    held: new Map<string, () => void>(),
    /** Request paths answered once with a 429 asking for a one-second wait, then normally. */
    rateLimitedOnce: new Set<string>(),
  };
  const requests: URL[] = [];
  const records = () => state.libraries.flat();
  const plexShow = (record: PlexRecord) => ({ ratingKey: record.ratingKey, title: record.title, ...(record.year === undefined ? {} : { year: record.year }), ...(record.guid ? { guid: record.guid } : {}), Guid: record.ids.map(id => ({ id })), updatedAt: 1 });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input)); requests.push(u);
    if (state.held.has(u.pathname)) await new Promise<void>(release => state.held.set(u.pathname, release));
    if (state.rateLimitedOnce.delete(u.pathname)) return Response.json({}, { status: 429, headers: { "Retry-After": "1" } });
    const failure = state.failures.get(u.pathname);
    if (failure) return Response.json({}, { status: failure });
    const summaryYear = (key: string, fallback: string) => state.summaryYears.has(key) ? state.summaryYears.get(key) : fallback;
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections") return Response.json({ MediaContainer: { Directory: state.libraries.map((_, index) => ({ key: String(index + 1), type: "show" })) } });
      const section = u.pathname.match(/^\/library\/sections\/(\d+)\/all$/);
      if (section) return Response.json({ MediaContainer: { Metadata: (state.libraries[Number(section[1]) - 1] || []).map(plexShow) } });
      if (u.pathname.endsWith("/allLeaves")) return Response.json({ MediaContainer: { Metadata: [] } });
      const metadata = u.pathname.match(/^\/library\/metadata\/([^/]+)$/);
      const record = metadata && records().find(item => item.ratingKey === metadata[1]);
      if (record) return Response.json({ MediaContainer: { Metadata: [plexShow(record)] } });
      throw new Error("Unexpected Plex HTTP: " + u);
    }
    if (u.pathname === "/v4/login") return Response.json({ data: { token: "test" } });
    if (u.pathname === "/3/tv/changes") return Response.json({ results: [], total_pages: 1 });
    if (u.pathname === "/v4/updates") return Response.json({ data: [] });
    if (u.pathname.includes("/find/")) return Response.json({ tv_results: [], tv_episode_results: [] });
    if (u.pathname.endsWith("/external_ids")) return Response.json({});
    if (/^\/v4\/episodes\/\d+\/translations\/eng$/.test(u.pathname)) return Response.json({}, { status: 403 });
    let match = u.pathname.match(/^\/3\/tv\/(\d+)$/);
    if (match) return Response.json({ id: Number(match[1]), name: `TMDB ${match[1]}`, first_air_date: summaryYear(`TMDB ${match[1]}`, "1999-01-01"), seasons: [{ season_number: 1 }] });
    match = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1$/);
    if (match) return Response.json({ episodes: [{ id: episodeId(Number(match[1])), season_number: 1, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }] });
    match = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1\/episode\/(\d+)$/);
    if (match) return Response.json({ id: episodeId(Number(match[1]), Number(match[2])), season_number: 1, episode_number: Number(match[2]), name: "Pilot" });
    match = u.pathname.match(/^\/v4\/series\/(\d+)$/);
    if (match && state.failedTvdbSummaries.has(Number(match[1]))) return Response.json({}, { status: 404 });
    if (match) return Response.json({ data: { id: Number(match[1]), name: `TVDB ${match[1]}`, slug: `tvdb-${match[1]}`, year: summaryYear(`TVDB ${match[1]}`, "1999") } });
    match = u.pathname.match(/^\/v4\/series\/(\d+)\/episodes\/default$/);
    if (match) return Response.json({ data: { episodes: [{ id: episodeId(Number(match[1])), seasonNumber: 1, number: 1, name: "Pilot", aired: "2020-01-01" }] } });
    match = u.pathname.match(/^\/v4\/episodes\/(\d+)\/extended$/);
    if (match) return Response.json({ data: { id: Number(match[1]), seriesId: Math.floor(Number(match[1]) / 100), seasonNumber: 1, number: Number(match[1]) % 100, name: "Pilot" } });
    throw new Error("Unexpected HTTP: " + u);
  });
  const settled = async () => {
    for (let i = 0; i < 500; i++) { const result = await (await scan.GET()).json(); if (result.scan.status !== "running") return result; await new Promise(r => setTimeout(r, 10)); }
    throw new Error("Scan timed out");
  };
  /** A Plex scan through the scan route: the whole library, or one show by its rating key. */
  const run = async (ratingKey?: string) => {
    await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: JSON.stringify(ratingKey ? { ratingKey } : {}) }));
    return settled();
  };
  const post = (body: unknown) => coverage.POST(new Request("http://localhost/api/plex/manual-coverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  /** Resolve a Manual Match of the S01E`episode` (S01E01 unless given) of TMDB show `tmdb` and of TVDB show `tvdb`; returns its preview. */
  const resolve = async (tmdb: number, tvdb: number, episode = 1) => {
    const resolved = await post({ action: "resolve", urls: [`tmdb:${episodeId(tmdb, episode)} show:${tmdb} season:1 episode:${episode}`, `tvdb:${episodeId(tvdb, episode)}`] });
    assert.equal(resolved.status, 200, JSON.stringify(await resolved.clone().json()));
    return (await resolved.json()).preview as string;
  };
  /** Save a resolved preview as a new Manual Match, or as an edit of `edit`; returns the route's response once any recheck settles. */
  const submit = async (preview: string, edit?: Mapping) => {
    const saved = await post({ action: "save", preview, ...(edit ? { id: edit.id, revision: edit.revision } : {}) });
    await settled();
    return saved;
  };
  /** Resolve, then save, a Manual Match of the S01E`episode` (S01E01 unless given) of TMDB show `tmdb` and of TVDB show `tvdb`. */
  const save = async (tmdb: number, tvdb: number, edit?: Mapping, episode = 1) => {
    const saved = await submit(await resolve(tmdb, tvdb, episode), edit);
    assert.equal(saved.status, edit ? 200 : 201, JSON.stringify(await saved.clone().json()));
    return (await saved.json()).mapping as Mapping;
  };
  /** Each saved Manual Match member's Show year, as "TMDB 10" -> year, read through the route. */
  const years = async () => {
    const body = await (await coverage.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
    return Object.fromEntries(body.mappings.flatMap((mapping: { members: { provider: string; showId: number; showYear?: number }[] }) => mapping.members.map(member => [`${member.provider} ${member.showId}`, member.showYear])));
  };
  return { state, requests, run, post, resolve, submit, save, years, restart, settled };
}

test("a Manual Match show held by one Plex show reads the year of the latest completed full scan", async t => {
  const f = await fixture(t);
  f.state.libraries = [[{ ratingKey: "1", title: "Doctor Who", year: 2005, guid: "plex://show/who-2005", ids: ["tmdb://57243", "tvdb://78804"] }]];
  await f.save(57243, 78804);
  assert.deepEqual(await f.years(), { "TMDB 57243": 1999, "TVDB 78804": 1999 }, "no completed full scan yet: the provider year");
  assert.equal((await f.run()).scan.status, "completed");
  f.requests.length = 0;
  assert.deepEqual(await f.years(), { "TMDB 57243": 2005, "TVDB 78804": 2005 });
  assert.deepEqual(f.requests, [], "reading years makes no network request");
});

const db = () => (globalThis as Global).__shelfcheckDatabase!;
/** Simulates the process ending: the next process starts with an empty owner record, and the abandoned run settles later. */
function abandonRunningScan(): Promise<void> {
  const global = globalThis as Global;
  const abandoned = global.__shelfcheckScanRun!;
  global.__shelfcheckScanRun = {};
  return (async () => { while (abandoned.owner) await new Promise(r => setTimeout(r, 10)); })();
}

test("only a completed full scan publishes a new Plex year, at its report save, and it survives a reopen", async t => {
  const f = await fixture(t);
  const who: PlexRecord = { ratingKey: "1", title: "Doctor Who", year: 2005, guid: "plex://show/who", ids: ["tmdb://57243", "tvdb://78804"] };
  const other: PlexRecord = { ratingKey: "2", title: "Torchwood", year: 2006, guid: "plex://show/torchwood", ids: ["tmdb://1000", "tvdb://2000"] };
  f.state.libraries = [[who, other]];
  await f.save(57243, 78804);
  assert.equal((await f.run()).scan.status, "completed");
  const A = { "TMDB 57243": 2005, "TVDB 78804": 2005 };
  assert.deepEqual(await f.years(), A);

  // Plex now gives year B.
  who.year = 2010;
  const targeted = await f.run("plex://show/who");
  assert.equal(targeted.scan.status, "completed");
  assert.equal(targeted.report.shows.find((show: { ratingKey: string }) => show.ratingKey === "plex://show/who").year, 2010, "the targeted scan saw year B");
  assert.deepEqual(await f.years(), A, "a targeted single-show scan publishes nothing");

  await f.save(1000, 2000); // A Manual Match save runs a cached recheck.
  const revision = (await (await scan.GET()).json()).coverage.revision;
  assert.deepEqual(await f.years(), { ...A, "TMDB 1000": 2006, "TVDB 2000": 2006 }, "a cached recheck publishes nothing");

  // A full scan that fails at its report save publishes nothing.
  db().exec("CREATE TRIGGER fail_report BEFORE UPDATE OF report ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;");
  assert.equal((await f.run()).scan.status, "error");
  db().exec("DROP TRIGGER fail_report;");
  assert.equal((await f.years())["TMDB 57243"], 2005, "a run that fails before its report save publishes nothing");

  // A full scan stopped part-way at Torchwood's Plex details, then the process ends.
  f.state.held.set("/library/metadata/2", () => {});
  f.requests.length = 0;
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  for (let i = 0; i < 500 && !f.requests.some(u => u.pathname === "/library/metadata/2"); i++) await new Promise(r => setTimeout(r, 10));
  const release = f.state.held.get("/library/metadata/2")!;
  f.state.held.clear();
  let interrupted: Promise<void> | undefined;
  try {
    assert.equal((await (await scan.GET()).json()).scan.status, "running");
    assert.equal((await f.years())["TMDB 57243"], 2005, "a running full scan publishes nothing");
    interrupted = abandonRunningScan();
    f.restart();
    t.mock.timers.tick(120_000);
    assert.equal((await (await scan.GET()).json()).scan.status, "error", "the run is an Interrupted scan");
    assert.equal((await f.years())["TMDB 57243"], 2005, "an interrupted run publishes nothing");

    assert.equal((await f.run()).scan.status, "completed");
    assert.deepEqual(await f.years(), { "TMDB 57243": 2010, "TVDB 78804": 2010, "TMDB 1000": 2006, "TVDB 2000": 2006 }, "a completed full scan publishes year B");
    assert.equal((await (await scan.GET()).json()).coverage.revision, revision, "a year change moves no coverage revision");
    f.restart();
    assert.equal((await f.years())["TVDB 78804"], 2010, "published years survive reopening the database");
  } finally {
    release();
    await interrupted;
  }
});

test("a full scan holding the Plex show without a usable year keeps its last known year; one no longer holding it drops it", async t => {
  const f = await fixture(t);
  const who: PlexRecord = { ratingKey: "1", title: "Doctor Who", year: 0, guid: "plex://show/who", ids: ["tmdb://57243", "tvdb://78804"] };
  const other: PlexRecord = { ratingKey: "2", title: "Torchwood", year: 2006, guid: "plex://show/torchwood", ids: ["tmdb://1000", "tvdb://2000"] };
  f.state.libraries = [[who, other]];
  await f.save(57243, 78804);
  await f.save(1000, 2000);
  await f.run();
  assert.deepEqual(await f.years(), { "TMDB 57243": 1999, "TVDB 78804": 1999, "TMDB 1000": 2006, "TVDB 2000": 2006 }, "Plex year 0 with no earlier year: the provider year, never (0)");
  who.year = 2005;
  await f.run();
  assert.equal((await f.years())["TMDB 57243"], 2005);
  // The TMDB and TVDB summaries give 1999; only a usable Plex year replaces the last known one.
  for (const missing of [undefined, 0, "2010", 20050, 2005.5]) {
    who.year = missing;
    const result = await f.run();
    assert.equal(result.scan.status, "completed");
    assert.deepEqual([(await f.years())["TMDB 57243"], (await f.years())["TVDB 78804"]], [2005, 2005], `Plex year ${JSON.stringify(missing)} keeps the last known year`);
    assert.equal(result.report.shows.find((show: { title: string }) => show.title === "Doctor Who")?.year, 2005, `the Plex page shows the kept year for Plex year ${JSON.stringify(missing)}`);
  }
  f.state.libraries = [[other]];
  await f.run();
  assert.deepEqual(await f.years(), { "TMDB 57243": 1999, "TVDB 78804": 1999, "TMDB 1000": 2006, "TVDB 2000": 2006 }, "a show the newest full scan no longer holds falls back to its provider year");
  f.state.libraries = [[who, other]];
  await f.run();
  assert.equal((await f.years())["TMDB 57243"], 1999, "a returning show does not revive the year of its removed identity");
});

test("a completed full scan publishes the Plex inventory's new year even when it keeps a show's last-good comparison", async t => {
  const f = await fixture(t);
  const who: PlexRecord = { ratingKey: "1", title: "Doctor Who", year: 2005, guid: "plex://show/who", ids: ["tmdb://57243", "tvdb://78804"] };
  f.state.libraries = [[who]];
  await f.save(57243, 78804);
  assert.equal((await f.run()).scan.status, "completed");
  who.year = 2010;
  // The show's details fail, so its last-good comparison is kept; the library listing still gives 2010.
  f.state.failures.set("/library/metadata/1", 404);
  const result = await f.run();
  assert.equal(result.scan.status, "completed", result.scan.error || "");
  assert.deepEqual(await f.years(), { "TMDB 57243": 2010, "TVDB 78804": 2010 }, "the fresh Plex inventory year wins over the kept comparison's");
  assert.equal(result.report.shows[0].year, 2010, "the Plex page shows the same year");
});

test("provider shows map to Plex groups by same-provider selected IDs and resolved candidates, one year per group in any order", async t => {
  const f = await fixture(t);
  const show = (ratingKey: string, guid: string, year: unknown, ...ids: string[]): PlexRecord => ({ ratingKey, title: guid, year, guid: `plex://show/${guid}`, ids });
  const first = [
    show("20", "who-1963", 1963, "tmdb://121", "tvdb://78804"),
    show("21", "who-2005", 2005, "tmdb://57243", "tvdb://78804"),
    // Duplicate records under one Plex GUID, with different years, in two libraries.
    show("7", "dup", 2006, "tmdb://400", "tvdb://401"),
    // Three Plex shows hold TVDB 300; the two with a year agree.
    show("30", "agree-1", 2010, "tmdb://310", "tvdb://300"),
    show("31", "agree-2", 2010, "tmdb://311", "tvdb://300"),
    show("32", "agree-3", 0, "tmdb://312", "tvdb://300"),
    // TMDB 555 only: TVDB 555 is another show.
    show("40", "numeric", 2001, "tmdb://555"),
    // Selected TMDB 700 and TVDB 800, a resolved TMDB alias 701 and a TVDB candidate 899 no lookup resolves.
    show("50", "aliases", 1990, "tmdb://700", "tmdb://701", "tvdb://800", "tvdb://899"),
  ];
  const second = [show("12", "dup", 2005, "tmdb://400", "tvdb://401")];
  f.state.libraries = [first, second];
  for (const [tmdb, tvdb] of [[121, 78804], [57243, 300], [400, 401], [555, 555], [701, 899], [700, 800]]) await f.save(tmdb, tvdb);
  f.state.failedTvdbSummaries.add(899);
  const expected = {
    // TVDB 78804 (conflicting groups), TVDB 555 (no Plex group) and TVDB 899 (only an unresolved candidate) take their provider year.
    "TMDB 121": 1963, "TVDB 78804": 1999, "TMDB 57243": 2005, "TVDB 300": 2010, "TMDB 400": 2006, "TVDB 401": 2006,
    "TMDB 555": 2001, "TVDB 555": 1999, "TMDB 701": 1990, "TVDB 899": 1999, "TMDB 700": 1990, "TVDB 800": 1990,
  };
  for (const order of ["listed", "reversed"]) {
    if (order === "reversed") f.state.libraries = [[...second].reverse(), [...first].reverse()];
    const result = await f.run();
    assert.equal(result.scan.status, "completed");
    const aliases = result.report.shows.find((item: { ratingKey: string }) => item.ratingKey === "plex://show/aliases");
    assert.deepEqual([aliases.tmdbId, aliases.tvdbId], [700, 800], "the fixture's selected IDs");
    assert.equal(result.report.shows.find((item: { ratingKey: string }) => item.ratingKey === "plex://show/dup").year, 2006, `${order}: the Plex page reads the group's one year`);
    assert.deepEqual(await f.years(), expected, `${order} libraries and records`);
  }
});

test("a Manual Match show no Plex show holds reads its provider year, captured from the save's own show lookups", async t => {
  const f = await fixture(t);
  f.state.summaryYears.set("TMDB 57243", "2005-03-26");
  f.state.summaryYears.set("TVDB 78804", "2005");
  f.requests.length = 0;
  await f.save(57243, 78804);
  const lookups = (pathname: string) => f.requests.filter(u => u.pathname === pathname).length;
  assert.deepEqual([lookups("/3/tv/57243"), lookups("/v4/series/78804")], [2, 2], "one show lookup at resolve and one at save, and no other year request");
  f.requests.length = 0;
  assert.deepEqual(await f.years(), { "TMDB 57243": 2005, "TVDB 78804": 2005 });
  assert.deepEqual(f.requests, [], "reading years makes no network request");
});

test("a provider show moves between its provider year, a unique Plex year, its provider year for conflicting groups, and name only with neither", async t => {
  const f = await fixture(t);
  const plex = (ratingKey: string, guid: string, year: unknown, ...ids: string[]): PlexRecord => ({ ratingKey, title: guid, year, guid: `plex://show/${guid}`, ids });
  f.state.summaryYears.set("TMDB 10", "1980-06-01");
  f.state.summaryYears.set("TVDB 20", "1981");
  // Neither source: no usable provider year, and a Plex group with year 0.
  f.state.summaryYears.set("TMDB 30", undefined);
  f.state.summaryYears.set("TVDB 40", "");
  // Coinciding numeric IDs: TMDB 555 and TVDB 555 are different shows.
  f.state.summaryYears.set("TMDB 555", "2001-05-05");
  f.state.summaryYears.set("TVDB 555", "1987");
  await f.save(10, 20);
  await f.save(30, 40);
  await f.save(555, 555);
  const provider = { "TMDB 10": 1980, "TVDB 20": 1981, "TMDB 30": undefined, "TVDB 40": undefined, "TMDB 555": 2001, "TVDB 555": 1987 };
  assert.deepEqual(await f.years(), provider, "provider years, each in its own provider namespace; name only with no year");

  const neither = plex("3", "neither", 0, "tmdb://30", "tvdb://40");
  f.state.libraries = [[plex("1", "unique", 2000, "tmdb://10", "tvdb://20"), neither]];
  assert.equal((await f.run()).scan.status, "completed");
  assert.deepEqual(await f.years(), { ...provider, "TMDB 10": 2000, "TVDB 20": 2000 }, "a unique Plex year wins over the provider year");

  // Two more Plex shows with another year: one also holds TMDB 10, the other TVDB 20.
  f.state.libraries[0].push(plex("2", "other-tmdb", 2003, "tmdb://10", "tvdb://21"), plex("4", "other-tvdb", 2003, "tmdb://11", "tvdb://20"));
  assert.equal((await f.run()).scan.status, "completed");
  assert.deepEqual(await f.years(), provider, "Plex groups with different years: the provider year");

  f.state.libraries = [[neither]];
  assert.equal((await f.run()).scan.status, "completed");
  assert.deepEqual(await f.years(), provider, "no Plex group: the provider year");
  f.restart();
  assert.deepEqual(await f.years(), provider, "saved provider years survive reopening the database");
});

test("a save keeps the saved provider year when a show answer has no usable year, a fresh year corrects it, and required lookups still reject", async t => {
  const f = await fixture(t);
  f.state.summaryYears.set("TMDB 57243", "2005-03-26");
  f.state.summaryYears.set("TVDB 78804", "2005");
  let mapping = await f.save(57243, 78804);
  const revision = async () => (await (await scan.GET()).json()).coverage.revision as number;
  const saved = { "TMDB 57243": 2005, "TVDB 78804": 2005 };
  assert.deepEqual(await f.years(), saved);

  for (const [tmdb, tvdb] of [[undefined, undefined], [null, null], ["", ""], ["20x5-01-01", "0"], ["0000-00-00", "05"], [2010, 2010], ["2010", "2010-01-01"]]) {
    f.state.summaryYears.set("TMDB 57243", tmdb);
    f.state.summaryYears.set("TVDB 78804", tvdb);
    const before = await revision();
    mapping = await f.save(57243, 78804, mapping);
    assert.equal(await revision(), before + 1, "the edit moves the coverage revision as any manual save does, and no more");
    assert.deepEqual(await f.years(), saved, `show answers with years ${JSON.stringify([tmdb, tvdb])} save the match and keep the saved year`);
  }

  // Required episode, show and sign-in lookups at save time still reject it, and change no year.
  f.state.summaryYears.set("TMDB 57243", "2006-01-01");
  f.state.summaryYears.set("TVDB 78804", "2007");
  for (const failing of ["/3/tv/57243/season/1/episode/1", "/3/tv/57243", "/v4/episodes/7880401/extended", "/v4/series/78804", "/v4/login"]) {
    const preview = await f.resolve(57243, 78804);
    const before = await revision();
    f.state.failures.set(failing, failing === "/v4/login" ? 401 : 404);
    const rejected = await f.submit(preview, mapping);
    f.state.failures.clear();
    assert.ok(rejected.status >= 400, `${failing} failing rejects the save (${rejected.status})`);
    assert.equal(await revision(), before, `${failing}: nothing saved`);
    assert.deepEqual(await f.years(), saved, `${failing}: the saved year is kept`);
  }

  mapping = await f.save(57243, 78804, mapping);
  assert.deepEqual(await f.years(), { "TMDB 57243": 2006, "TVDB 78804": 2007 }, "a fresh successful answer corrects the saved year");
});

test("a completed full scan looks up each Manual Match show Plex does not hold once; only a fresh year corrects the saved one, moving no coverage", async t => {
  const f = await fixture(t);
  f.state.libraries = [[{ ratingKey: "1", title: "Torchwood", year: 2006, guid: "plex://show/torchwood", ids: ["tmdb://1000", "tvdb://2000"] }]];
  // TMDB 10 and TVDB 20 each appear in two Manual Matches.
  await f.save(10, 20);
  await f.save(10, 21, undefined, 2);
  await f.save(11, 20, undefined, 2);
  assert.deepEqual(await f.years(), { "TMDB 10": 1999, "TVDB 20": 1999, "TVDB 21": 1999, "TMDB 11": 1999 }, "provider years from the saves");
  assert.equal((await f.run()).scan.status, "completed");

  // A year-only change: the shows' years change and nothing else does.
  f.state.summaryYears.set("TMDB 10", "1990-01-01");
  f.state.summaryYears.set("TVDB 20", "1991");
  f.state.summaryYears.set("TMDB 11", undefined);
  f.state.failures.set("/v4/series/21", 404);
  const before = (await (await scan.GET()).json()).coverage;
  f.requests.length = 0;
  const result = await f.run();
  assert.equal(result.scan.status, "completed", "a failed year lookup does not fail the scan");
  const lookups = (pathname: string) => f.requests.filter(u => u.pathname === pathname).length;
  assert.deepEqual([lookups("/3/tv/10"), lookups("/v4/series/20"), lookups("/3/tv/11"), lookups("/v4/series/21")], [1, 1, 1, 1], "one lookup per show per scan");
  assert.deepEqual(await f.years(), { "TMDB 10": 1990, "TVDB 20": 1991, "TVDB 21": 1999, "TMDB 11": 1999 }, "fresh years correct the saved ones; a missing year or a failed lookup keeps it");
  await new Promise(r => setTimeout(r, 50));
  const after = await (await scan.GET()).json();
  assert.deepEqual(after.coverage, before, "a year-only correction moves no coverage revision and leaves nothing pending");
  assert.deepEqual(after.scan, result.scan, "and starts no cached recheck");
});

test("a completed full scan corrects provider years from show details it fetches and never from answers it reuses", async t => {
  const f = await fixture(t);
  // One Plex show with no year holds TMDB 10, its selected TVDB 20 and a second TVDB candidate 23, so all three read their provider year.
  f.state.libraries = [[{ ratingKey: "1", title: "Doctor Who", year: 0, guid: "plex://show/who", ids: ["tmdb://10", "tvdb://20", "tvdb://23"] }]];
  const setYears = (tmdb10: string, tvdb20: string, tvdb23: string) => {
    f.state.summaryYears.set("TMDB 10", tmdb10);
    f.state.summaryYears.set("TVDB 20", tvdb20);
    f.state.summaryYears.set("TVDB 23", tvdb23);
  };
  setYears("1980-06-01", "1981", "1982");
  await f.save(10, 20);
  const mapping = await f.save(10, 23, undefined, 2);
  // The first full scan downloads the show's catalogues and fetches its series details itself.
  setYears("1985-01-01", "1986", "1987");
  f.requests.length = 0;
  const result = await f.run();
  assert.equal(result.scan.status, "completed");
  assert.equal(result.report.shows[0].tvdbId, 20, "the fixture selects TVDB 20");
  assert.deepEqual(await f.years(), { "TMDB 10": 1985, "TVDB 20": 1986, "TVDB 23": 1987 }, "the scan's own show details correct the saved years");
  const requested = () => f.requests.filter(u => /^\/(3\/tv|v4\/series)\/\d+$/.test(u.pathname)).map(u => u.pathname + u.search).sort();
  assert.deepEqual(requested(), ["/3/tv/10?append_to_response=external_ids", "/v4/series/20", "/v4/series/20", "/v4/series/23"], "the scan's own show-details requests (catalogues, then evidence), and no separate year lookup");

  // A later save gives TVDB 23 a newer year. The next scan downloads the show's catalogues again,
  // but answers TVDB 23 from the older answer it saved, which writes nothing; it looks up no show it holds.
  t.mock.timers.tick(60_000);
  setYears("1990-01-01", "1991", "1992");
  await f.save(10, 23, mapping, 2);
  assert.deepEqual(await f.years(), { "TMDB 10": 1990, "TVDB 20": 1986, "TVDB 23": 1992 });
  t.mock.timers.tick(60_000);
  setYears("1995-01-01", "1995", "1995");
  f.requests.length = 0;
  assert.equal((await f.run()).scan.status, "completed");
  assert.deepEqual(requested(), ["/3/tv/10?append_to_response=external_ids", "/v4/series/20"], "the scan's catalogue downloads only: TVDB 23's saved answer is reused");
  assert.deepEqual(await f.years(), { "TMDB 10": 1995, "TVDB 20": 1995, "TVDB 23": 1992 }, "fresh catalogue answers correct the years; a reused answer keeps the newer saved year");
});

test("targeted scans, cached rechecks and full scans that fail before their report save write no provider year", async t => {
  const f = await fixture(t);
  // A Plex show with no year holds TMDB 10 and TVDB 20; no Plex show holds TMDB 11 or TVDB 21.
  f.state.libraries = [[{ ratingKey: "1", title: "Doctor Who", year: 0, guid: "plex://show/who", ids: ["tmdb://10", "tvdb://20"] }]];
  await f.save(10, 20);
  const unowned = await f.save(11, 21);
  assert.equal((await f.run()).scan.status, "completed");
  const saved = { "TMDB 10": 1999, "TVDB 20": 1999, "TMDB 11": 1999, "TVDB 21": 1999 };
  assert.deepEqual(await f.years(), saved);

  for (const show of ["TMDB 10", "TMDB 11"]) f.state.summaryYears.set(show, "2001-01-01");
  for (const show of ["TVDB 20", "TVDB 21"]) f.state.summaryYears.set(show, "2001");
  const unownedLookups = () => f.requests.filter(u => u.pathname === "/3/tv/11" || u.pathname === "/v4/series/21").length;
  f.requests.length = 0;
  assert.equal((await f.run("plex://show/who")).scan.status, "completed");
  assert.deepEqual(await f.years(), saved, "a targeted single-show scan writes no provider year");
  const showDetails = () => f.requests.filter(u => /^\/(3\/tv|v4\/series)\/\d+$/.test(u.pathname)).map(u => u.pathname).sort();
  assert.deepEqual(showDetails(), ["/3/tv/10", "/v4/series/20", "/v4/series/20"], "it fetched the Plex show's details afresh, and looked up no Manual Match show");

  // A Report Missing-only edit runs a cached recheck and makes no provider lookup.
  const flagged = await f.post({ action: "save", id: unowned.id, revision: unowned.revision, reportMissing: [{ provider: "TMDB", id: episodeId(11) }] });
  assert.equal(flagged.status, 200, JSON.stringify(await flagged.clone().json()));
  await f.settled();
  assert.deepEqual(await f.years(), saved, "a cached recheck writes no provider year");

  const db = (globalThis as Global).__shelfcheckDatabase!;
  db.exec("CREATE TRIGGER fail_report BEFORE UPDATE OF report ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'report store unavailable'); END;");
  f.requests.length = 0;
  assert.equal((await f.run()).scan.status, "error");
  db.exec("DROP TRIGGER fail_report;");
  assert.ok(unownedLookups() > 0, "the failed scan looked up the shows Plex does not hold");
  assert.deepEqual(await f.years(), saved, "a full scan that fails at its report save writes no provider year");

  f.requests.length = 0;
  assert.equal((await f.run()).scan.status, "completed");
  assert.deepEqual(showDetails(), ["/3/tv/11", "/v4/series/21"], "the completed full scan reuses the Plex show's answers and looks up the others");
  assert.deepEqual(await f.years(), { "TMDB 10": 1999, "TVDB 20": 1999, "TMDB 11": 2001, "TVDB 21": 2001 }, "a completed full scan writes the years of its fresh answers");
});

test("Manual Matches saved before provider years existed gain them from the next completed full scan", async t => {
  const f = await fixture(t);
  // A Plex show with no year holds TMDB 12 and TVDB 22; no Plex show holds TMDB 10 or TVDB 20.
  f.state.libraries = [[{ ratingKey: "1", title: "Doctor Who", year: 0, guid: "plex://show/who", ids: ["tmdb://12", "tvdb://22"] }]];
  await f.save(10, 20);
  await f.save(12, 22);
  // A database from before provider years were saved: the matches exist, with no provider year.
  (globalThis as Global).__shelfcheckDatabase!.prepare("DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key=?").run("provider-show-years");
  assert.deepEqual(await f.years(), { "TMDB 10": undefined, "TVDB 20": undefined, "TMDB 12": undefined, "TVDB 22": undefined }, "name only");
  assert.equal((await f.run()).scan.status, "completed");
  f.restart();
  assert.deepEqual(await f.years(), { "TMDB 10": 1999, "TVDB 20": 1999, "TMDB 12": 1999, "TVDB 22": 1999 });
});

test("a full scan paused by a provider cooldown publishes nothing until it completes", async t => {
  const f = await fixture(t);
  const who: PlexRecord = { ratingKey: "1", title: "Doctor Who", year: 2005, guid: "plex://show/who", ids: ["tmdb://57243", "tvdb://78804"] };
  f.state.libraries = [[who]];
  await f.save(57243, 78804);
  assert.equal((await f.run()).scan.status, "completed");
  who.year = 2010;
  f.state.rateLimitedOnce.add("/3/tv/changes");
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  let paused = false;
  for (let i = 0; i < 500 && !paused; i++) { paused = Boolean((await (await scan.GET()).json()).scan.rateLimitPaused); if (!paused) await new Promise(r => setTimeout(r, 5)); }
  assert.ok(paused, "the scan paused for the provider cooldown");
  assert.deepEqual(await f.years(), { "TMDB 57243": 2005, "TVDB 78804": 2005 }, "a paused full scan publishes nothing");
  assert.equal((await f.settled()).scan.status, "completed");
  assert.deepEqual(await f.years(), { "TMDB 57243": 2010, "TVDB 78804": 2010 }, "it publishes its years once it completes");
});

test("a full scan whose year save fails still saves its report", async t => {
  const f = await fixture(t);
  const who: PlexRecord = { ratingKey: "1", title: "Doctor Who", year: 2005, guid: "plex://show/who", ids: ["tmdb://57243", "tvdb://78804"] };
  f.state.libraries = [[who]];
  await f.save(57243, 78804);
  assert.equal((await f.run()).scan.status, "completed");
  who.year = 2010;
  f.state.summaryYears.set("TMDB 57243", "2001-01-01");
  for (const event of ["INSERT", "UPDATE"])
    db().exec(`CREATE TRIGGER fail_years_${event} BEFORE ${event} ON shelfcheck_plex_generated_inputs WHEN NEW.cache_key IN ('plex-show-years', 'provider-show-years') BEGIN SELECT RAISE(ABORT, 'year store unavailable'); END;`);
  const result = await f.run();
  for (const event of ["INSERT", "UPDATE"]) db().exec(`DROP TRIGGER fail_years_${event};`);
  assert.equal(result.scan.status, "completed", result.scan.error || "");
  assert.equal(result.report.shows[0].year, 2010, "the report of the scan is saved");
  assert.deepEqual(await f.years(), { "TMDB 57243": 2005, "TVDB 78804": 2005 }, "the saved years are kept");
});

test("an ignored Plex show keeps giving its Manual Match shows its Plex year", async t => {
  const f = await fixture(t);
  const who: PlexRecord = { ratingKey: "1", title: "Doctor Who", year: 2005, guid: "plex://show/who", ids: ["tmdb://57243", "tvdb://78804"] };
  f.state.libraries = [[who]];
  await f.save(57243, 78804);
  ignoreResults.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "plex://show/who", title: "Doctor Who" }] });
  assert.equal((await f.run()).scan.status, "completed");
  assert.deepEqual(await f.years(), { "TMDB 57243": 2005, "TVDB 78804": 2005 }, "an Ignore excludes missing episodes, not the show's Plex year");
  who.year = 2010;
  assert.equal((await f.run()).scan.status, "completed");
  assert.deepEqual(await f.years(), { "TMDB 57243": 2010, "TVDB 78804": 2010 }, "a completed full scan publishes the ignored show's new Plex year");
});
