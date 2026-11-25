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
type Global = typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanRun?: { owner?: unknown } };

/** Every provider show's one episode: S01E01, numbered from its show ID so IDs never collide. */
const episodeId = (showId: number) => showId * 100 + 1;

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
    /** Requests, by path, held until released, to stop a scan part-way. */
    held: new Map<string, () => void>(),
  };
  const requests: URL[] = [];
  const records = () => state.libraries.flat();
  const plexShow = (record: PlexRecord) => ({ ratingKey: record.ratingKey, title: record.title, ...(record.year === undefined ? {} : { year: record.year }), ...(record.guid ? { guid: record.guid } : {}), Guid: record.ids.map(id => ({ id })), updatedAt: 1 });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input)); requests.push(u);
    if (state.held.has(u.pathname)) await new Promise<void>(release => state.held.set(u.pathname, release));
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
    if (match) return Response.json({ id: Number(match[1]), name: `TMDB ${match[1]}`, first_air_date: "1999-01-01", seasons: [{ season_number: 1 }] });
    match = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1$/);
    if (match) return Response.json({ episodes: [{ id: episodeId(Number(match[1])), season_number: 1, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }] });
    match = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1\/episode\/1$/);
    if (match) return Response.json({ id: episodeId(Number(match[1])), season_number: 1, episode_number: 1, name: "Pilot" });
    match = u.pathname.match(/^\/v4\/series\/(\d+)$/);
    if (match && state.failedTvdbSummaries.has(Number(match[1]))) return Response.json({}, { status: 404 });
    if (match) return Response.json({ data: { id: Number(match[1]), name: `TVDB ${match[1]}`, slug: `tvdb-${match[1]}`, year: "1999" } });
    match = u.pathname.match(/^\/v4\/series\/(\d+)\/episodes\/default$/);
    if (match) return Response.json({ data: { episodes: [{ id: episodeId(Number(match[1])), seasonNumber: 1, number: 1, name: "Pilot", aired: "2020-01-01" }] } });
    match = u.pathname.match(/^\/v4\/episodes\/(\d+)\/extended$/);
    if (match) return Response.json({ data: { id: Number(match[1]), seriesId: Math.floor(Number(match[1]) / 100), seasonNumber: 1, number: 1, name: "Pilot" } });
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
  /** Resolve, then save, a Manual Match of the S01E01 of TMDB show `tmdb` and of TVDB show `tvdb`. */
  const save = async (tmdb: number, tvdb: number) => {
    const resolved = await post({ action: "resolve", urls: [`tmdb:${episodeId(tmdb)} show:${tmdb} season:1 episode:1`, `tvdb:${episodeId(tvdb)}`] });
    assert.equal(resolved.status, 200, JSON.stringify(await resolved.clone().json()));
    const saved = await post({ action: "save", preview: (await resolved.json()).preview });
    assert.equal(saved.status, 201, JSON.stringify(await saved.clone().json()));
    await settled();
    return (await saved.json()).mapping as { id: string };
  };
  /** Each saved Manual Match member's Show year, as "TMDB 10" -> year, read through the route. */
  const years = async () => {
    const body = await (await coverage.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
    return Object.fromEntries(body.mappings.flatMap((mapping: { members: { provider: string; showId: number; showYear?: number }[] }) => mapping.members.map(member => [`${member.provider} ${member.showId}`, member.showYear])));
  };
  return { state, requests, run, save, years, restart, settled };
}

test("a Manual Match show held by one Plex show reads the year of the latest completed full scan", async t => {
  const f = await fixture(t);
  f.state.libraries = [[{ ratingKey: "1", title: "Doctor Who", year: 2005, guid: "plex://show/who-2005", ids: ["tmdb://57243", "tvdb://78804"] }]];
  await f.save(57243, 78804);
  assert.deepEqual(await f.years(), { "TMDB 57243": undefined, "TVDB 78804": undefined }, "no completed full scan yet: name only");
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
  assert.deepEqual(await f.years(), { "TMDB 57243": undefined, "TVDB 78804": undefined, "TMDB 1000": 2006, "TVDB 2000": 2006 }, "year 0 with no earlier year: name only, never (0)");
  who.year = 2005;
  await f.run();
  assert.equal((await f.years())["TMDB 57243"], 2005);
  // The TMDB and TVDB summaries give 1999; only a usable Plex year replaces the last known one.
  for (const missing of [undefined, 0, "2010", 20050, 2005.5]) {
    who.year = missing;
    assert.equal((await f.run()).scan.status, "completed");
    assert.deepEqual([(await f.years())["TMDB 57243"], (await f.years())["TVDB 78804"]], [2005, 2005], `Plex year ${JSON.stringify(missing)} keeps the last known year`);
  }
  f.state.libraries = [[other]];
  await f.run();
  assert.deepEqual(await f.years(), { "TMDB 57243": undefined, "TVDB 78804": undefined, "TMDB 1000": 2006, "TVDB 2000": 2006 }, "a show the newest full scan no longer holds has no Plex year");
  f.state.libraries = [[who, other]];
  await f.run();
  assert.equal((await f.years())["TMDB 57243"], undefined, "a returning show does not revive the year of its removed identity");
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
    "TMDB 121": 1963, "TVDB 78804": undefined, "TMDB 57243": 2005, "TVDB 300": 2010, "TMDB 400": 2006, "TVDB 401": 2006,
    "TMDB 555": 2001, "TVDB 555": undefined, "TMDB 701": 1990, "TVDB 899": undefined, "TMDB 700": 1990, "TVDB 800": 1990,
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
