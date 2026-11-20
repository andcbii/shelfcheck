import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const scan = await import("../app/api/plex/scan/route");
const sqlite = await import("../lib/sqlite");
const config = await import("../lib/server-config");
const plexScan = await import("../lib/plex-scan");
const { seriesNotFoundHistory } = await import("../lib/series-not-found-history");
hook.deregister();

const DAY = 86400_000;
const ORIGIN = Date.parse("2026-01-01T12:00:00Z");
const day = (n: number, hour = 12) => new Date(ORIGIN + n * DAY + (hour - 12) * 3600_000).toISOString();
type Issue = {id:string;cause:string;catalogueRefresh?:{checkedAt:string;downloadedAt?:string;seriesNotFoundDays?:number}};
/** How a fake provider answers a series: working, 404 on its series request, 404 on a season/episode page only, a 503 asking for a 20-minute cooldown, or a refused sign-in (401). */
type Answer = "ok" | "series-404" | "season-404" | "503" | "401";

/**
 * Plex shows against fake TMDB and TVDB providers. Show `n` reports the IDs in `shows[n]`; every
 * series has one episode, S1E1, which the library owns.
 */
async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"series-not-found-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  t.after(() => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  sqlite.savedScanState("plex").options.patch({diagnosticsEnabled:false});
  t.mock.timers.enable({apis:["Date"],now:new Date(day(1))});
  const shows: Record<string,{tmdb?:number;tvdb?:number}> = {1:{tmdb:10,tvdb:1}};
  const tmdb: Record<number,Answer> = {10:"ok"};
  const tvdb: Record<number,Answer> = {1:"ok"};
  const fail = (answer: Answer, seriesRequest: boolean) => answer === "503" ? new Response(null,{status:503,headers:{"Retry-After":"1200"}}) : answer === "401" ? Response.json({},{status:401}) : (answer === "series-404" && seriesRequest) || (answer === "season-404" && !seriesRequest) ? Response.json({},{status:404}) : undefined;
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input));
    const metadata = Object.entries(shows).map(([ratingKey,ids]) => ({ratingKey,title:`Show ${ratingKey}`,updatedAt:1,Guid:[...(ids.tmdb ? [{id:`tmdb://${ids.tmdb}`}] : []),...(ids.tvdb ? [{id:`tvdb://${ids.tvdb}`}] : [])]}));
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname === "/library/sections/1/all") return Response.json({MediaContainer:{Metadata:metadata}});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:[{ratingKey:"ep",parentIndex:1,index:1,Guid:[]}]}});
      const key = u.pathname.match(/^\/library\/metadata\/(\d+)$/)?.[1];
      return Response.json({MediaContainer:{Metadata:metadata.filter(show=>show.ratingKey === key)}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:[],total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:[]});
    const tmdbShow = u.pathname.match(/^\/3\/tv\/(\d+)(\/season\/1)?$/);
    if(tmdbShow && tmdb[Number(tmdbShow[1])]) {
      const id = Number(tmdbShow[1]);
      const failed = fail(tmdb[id], !tmdbShow[2]);
      if(failed) return failed;
      if(!tmdbShow[2]) return Response.json({id,name:`TMDB ${id}`,seasons:[{season_number:1}],external_ids:{tvdb_id:null}});
      return Response.json({episodes:[{id:id*100+1,season_number:1,episode_number:1,name:"Episode 1",air_date:"2020-01-01"}]});
    }
    const tvdbSeries = u.pathname.match(/^\/v4\/series\/(\d+)(\/episodes\/default)?$/);
    if(tvdbSeries && tvdb[Number(tvdbSeries[1])]) {
      const id = Number(tvdbSeries[1]);
      const failed = fail(tvdb[id], !tvdbSeries[2]);
      if(failed) return failed;
      if(!tvdbSeries[2]) return Response.json({data:{id,name:`TVDB ${id}`,slug:`tvdb-${id}`}});
      return Response.json({data:{episodes:[{id:id*1000+1,seasonNumber:1,number:1,name:"Episode 1",aired:"2020-01-01"}]}});
    }
    if(u.pathname.includes("/find/")) return Response.json({tv_results:[],tv_episode_results:[]});
    throw new Error("Unexpected HTTP: "+u);
  });
  return {
    shows, tmdb, tvdb,
    at(value: string) { t.mock.timers.setTime(Date.parse(value)); },
    restart() { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase; },
    /** A full scan, or a single-show scan of `ratingKey`. */
    async run(ratingKey?: string) {
      await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:JSON.stringify(ratingKey ? {ratingKey:`ratingKey:${ratingKey}`} : {})}));
      for(let i=0;i<500;i++) { const state = await (await scan.GET()).json(); if(state.scan.status !== "running") { assert.equal(state.scan.status,"completed",state.scan.error); return; } await new Promise(r=>setTimeout(r,10)); }
      throw new Error("Scan timed out");
    },
    async issue(id: string): Promise<Issue | undefined> { return ((await (await scan.GET()).json()).coverage.issues as Issue[]).find(issue => issue.id === id); },
    days: (provider: "tmdb" | "tvdb", id: number) => seriesNotFoundHistory().countedDays(provider, id),
  };
}

test("five 404 scans on one UTC day and one the next count 2, and the Scan Issue shows the progress of a never-downloaded series", async t => {
  const f = await fixture(t);
  f.tmdb[10] = "series-404";
  for (const hour of [0, 6, 12, 18, 23]) { f.at(day(1, hour)); await f.run(); }
  assert.equal(f.days("tmdb", 10), 1);
  f.at(day(2, 1));
  await f.run();
  assert.equal(f.days("tmdb", 10), 2);
  const issue = await f.issue("catalogue-refresh:TMDB:ratingKey:1");
  assert.deepEqual(issue?.catalogueRefresh, { checkedAt: day(2, 1), seriesNotFoundDays: 2 }, "no catalogue was ever downloaded, so there is no age");
});

test("a 404 on a season request of a working series never counts, a partial download never resets, and a complete download resets", async t => {
  const f = await fixture(t);
  f.tvdb[1] = "series-404";
  await f.run();
  assert.equal(f.days("tvdb", 1), 1);
  f.at(day(2));
  f.tvdb[1] = "season-404";
  await f.run();
  assert.equal(f.days("tvdb", 1), 1, "the episode page 404 neither counts nor resets");
  const issue = await f.issue("catalogue-refresh:TVDB:ratingKey:1");
  assert.equal(issue?.catalogueRefresh?.seriesNotFoundDays, undefined, "only a series-request 404 shows 404 progress");
  f.at(day(3));
  f.tvdb[1] = "ok";
  await f.run();
  assert.equal(f.days("tvdb", 1), 0);
});

test("TMDB: a 404 on a season page never counts and a failed season download never resets", async t => {
  const f = await fixture(t);
  f.tmdb[10] = "series-404";
  await f.run();
  f.at(day(2));
  f.tmdb[10] = "season-404";
  await f.run();
  assert.equal(f.days("tmdb", 10), 1);
});

test("the count is shared by two shows reporting the same ID and survives a restart and Clear cache", async t => {
  const f = await fixture(t);
  f.shows[2] = {tmdb:10};
  f.tmdb[10] = "series-404";
  await f.run();
  assert.equal(f.days("tmdb", 10), 1, "two shows on one day count one day");
  f.restart();
  plexScan.clearPlexScanCache("ratingKey:1");
  plexScan.clearPlexScanCache();
  f.at(day(2));
  await f.run();
  assert.equal(f.days("tmdb", 10), 2);
  assert.equal((await f.issue("catalogue-refresh:TMDB:ratingKey:2"))?.catalogueRefresh?.seriesNotFoundDays, 2);
});

// Last: the 20-minute TMDB cooldown stays on the shared scan provider client after this test.
test("other failures neither count nor reset, and the Scan Issue shows the age of the saved catalogue", async t => {
  const f = await fixture(t);
  await f.run();
  f.at(day(10));
  f.tmdb[10] = "series-404";
  await f.run("1");
  assert.equal(f.days("tmdb", 10), 1);
  const notFound = await f.issue("catalogue-refresh:TMDB:ratingKey:1");
  assert.deepEqual(notFound?.catalogueRefresh, { checkedAt: day(10), downloadedAt: day(1), seriesNotFoundDays: 1 });
  f.at(day(75));
  f.tmdb[10] = "503";
  await f.run("1");
  assert.equal(f.days("tmdb", 10), 1, "a 503 neither counts nor resets");
  const outage = await f.issue("catalogue-refresh:TMDB:ratingKey:1");
  assert.deepEqual(outage?.catalogueRefresh, { checkedAt: day(75), downloadedAt: day(1) });
  f.at(day(76));
  f.tmdb[10] = "401";
  await f.run("1");
  assert.equal(f.days("tmdb", 10), 1, "a refused request neither counts nor resets");
});
