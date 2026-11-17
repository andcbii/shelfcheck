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
const selections = await import("../lib/catalogue-selection-store");
const plexScan = await import("../lib/plex-scan");
hook.deregister();

const DAY = 86400_000;
const ORIGIN = Date.parse("2026-01-01T12:00:00Z");
const day = (n: number) => new Date(ORIGIN + n * DAY).toISOString();
type Show = {ratingKey:string;tmdbId?:number;tvdbId?:number;missing:{tmdbEpisodeId?:number}[];warning?:string};

/**
 * One Plex show (two when `second` is set) against fake TMDB and TVDB catalogues. TMDB series
 * `id` has `episodes` episodes with IDs id*100+n; the Plex library owns only S1E1.
 */
async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"catalogue-fallback-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  t.after(() => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  sqlite.writePlexSettings({diagnosticsEnabled:false});
  t.mock.timers.enable({apis:["Date"],now:new Date(day(1))});
  const plex = {tmdb:[10] as number[], tvdb:[1] as number[]};
  /** A second, single-ID show, when set. */
  let second: {tmdb:number;tvdb:number} | undefined;
  const tmdb: Record<number,{episodes:number;tvdb?:number|null;fail?:boolean}> = {10:{episodes:2,tvdb:1},11:{episodes:3,tvdb:1},12:{episodes:1,tvdb:2}};
  const tvdb: Record<number,{episodes:number;fail?:boolean}> = {1:{episodes:1},2:{episodes:1},3:{episodes:1}};
  let tmdbChanges: number[] = [];
  const requests: string[] = [];
  const guids = (ids: {tmdb:number[];tvdb:number[]}) => [...ids.tmdb.map(id=>({id:`tmdb://${id}`})),...ids.tvdb.map(id=>({id:`tvdb://${id}`}))];
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u.pathname);
    const shows = [{ratingKey:"1",title:"Scooby",Guid:guids(plex),updatedAt:1},...(second ? [{ratingKey:"2",title:"Other",Guid:guids({tmdb:[second.tmdb],tvdb:[second.tvdb]}),updatedAt:1}] : [])];
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname === "/library/sections/1/all") return Response.json({MediaContainer:{Metadata:shows}});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:[{ratingKey:"ep",parentIndex:1,index:1,Guid:[]}]}});
      const key = u.pathname.match(/^\/library\/metadata\/(\d+)$/)?.[1];
      return Response.json({MediaContainer:{Metadata:shows.filter(show=>show.ratingKey === key)}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:tmdbChanges.map(id=>({id})),total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:[]});
    const tmdbShow = u.pathname.match(/^\/3\/tv\/(\d+)(\/season\/1)?$/);
    if(tmdbShow && tmdb[Number(tmdbShow[1])]) {
      const id = Number(tmdbShow[1]), series = tmdb[id];
      if(series.fail) return Response.json({status_message:"not found"},{status:404});
      if(!tmdbShow[2]) return Response.json({id,name:`TMDB ${id}`,seasons:[{season_number:1}],external_ids:{tvdb_id:series.tvdb ?? null}});
      return Response.json({episodes:Array.from({length:series.episodes},(_,n)=>({id:id*100+n+1,season_number:1,episode_number:n+1,name:`Episode ${n+1}`,air_date:"2020-01-01"}))});
    }
    const tvdbSeries = u.pathname.match(/^\/v4\/series\/(\d+)(\/episodes\/default)?$/);
    if(tvdbSeries && tvdb[Number(tvdbSeries[1])]) {
      const id = Number(tvdbSeries[1]), series = tvdb[id];
      if(series.fail) return Response.json({},{status:404});
      if(!tvdbSeries[2]) return Response.json({data:{id,name:`TVDB ${id}`,slug:`tvdb-${id}`}});
      return Response.json({data:{episodes:Array.from({length:series.episodes},(_,n)=>({id:id*1000+n+1,seasonNumber:1,number:n+1,name:`Episode ${n+1}`,aired:"2020-01-01"}))}});
    }
    if(u.pathname.includes("/find/")) return Response.json({tv_results:[],tv_episode_results:[]});
    throw new Error("Unexpected HTTP: "+u);
  });
  const identity = "ratingKey:1";
  return {
    plex, tmdb, tvdb, identity, requests,
    setSecond(value: typeof second) { second = value; },
    changes(ids: number[]) { tmdbChanges = ids; },
    at(value: string) { t.mock.timers.setTime(Date.parse(value)); },
    restart() { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase; },
    /** Full scan; returns the first show's result. */
    async run(key = "1"): Promise<Show> {
      requests.length = 0;
      await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
      for(let i=0;i<500;i++) { const state = await (await scan.GET()).json(); if(state.scan.status !== "running") { assert.equal(state.scan.status,"completed",state.scan.error); return state.report.shows.find((show:Show)=>show.ratingKey === `ratingKey:${key}`); } await new Promise(r=>setTimeout(r,10)); }
      throw new Error("Scan timed out");
    },
    async issues(): Promise<{id:string}[]> { return (await (await scan.GET()).json()).coverage.issues; },
    tmdbDownloads(id: number) { return requests.filter(p=>p === `/3/tv/${id}/season/1`).length; },
    tvdbDownloads(id: number) { return requests.filter(p=>p === `/v4/series/${id}/episodes/default`).length; },
    selection(key = identity) { return selections.readCatalogueSelections()[key]; },
  };
}
const missingTmdb = (show: Show) => show.missing.flatMap(episode => episode.tmdbEpisodeId ? [episode.tmdbEpisodeId] : []).sort((a,b)=>a-b);

test("the product-owner timeline keeps the B preference through saved data and fallback, then reconciles Plex removing B", async t => {
  const f = await fixture(t);
  let show = await f.run();
  assert.equal(show.tmdbId,10); assert.equal(show.tvdbId,1);
  assert.deepEqual(f.selection().tmdb.current && {usingId:f.selection().tmdb.current?.usingId,state:f.selection().tmdb.current?.state},{usingId:10,state:"preferred"});

  f.at(day(100)); f.plex.tmdb = [10,11];
  show = await f.run();
  assert.equal(show.tmdbId,10,"A is the lower ID");
  assert.equal(f.tmdbDownloads(11),0,"an unused candidate is not downloaded");

  f.at(day(101)); selections.saveCatalogueOverride(f.identity,"tmdb",11);
  show = await f.run();
  assert.equal(show.tmdbId,11); assert.deepEqual(missingTmdb(show),[1102,1103]);
  assert.equal(f.selection().tmdb.current?.state,"preferred");

  f.at(day(102)); f.tmdb[11].fail = true; f.changes([11]);
  show = await f.run();
  assert.ok(f.requests.includes("/3/tv/11"),"B was looked up");
  assert.equal(show.tmdbId,11,"saved B is still compared"); assert.deepEqual(missingTmdb(show),[1102,1103]);
  let current = f.selection().tmdb.current!;
  assert.equal(current.state,"saved-unavailable"); assert.equal(current.usingId,11); assert.equal(current.preferredId,11);
  assert.equal(current.preferredDownloadedAt,day(101)); assert.equal(current.preferredUsableUntil,day(161));
  assert.ok((await f.issues()).some(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`),"B being unavailable stays a Coverage Issue");

  f.at(day(163)); f.changes([]);
  show = await f.run();
  assert.ok(f.requests.includes("/3/tv/11"),"B is retried every scan");
  assert.equal(show.tmdbId,10,"A is used once saved B is older than 60 days"); assert.deepEqual(missingTmdb(show),[1002]);
  assert.equal(show.warning,undefined,"a usable fallback is a successful comparison");
  current = f.selection().tmdb.current!;
  assert.equal(current.state,"fallback"); assert.equal(current.usingId,10); assert.equal(current.preferredId,11);
  assert.equal(current.preferredDownloadedAt,day(101),"failures never renew B's download time");
  f.restart();
  assert.equal(f.selection().tmdb.override,11,"the preference survives fallback and restart");
  assert.equal(f.selection().tmdb.current?.usingId,10);

  f.at(day(200)); f.plex.tmdb = [10];
  show = await f.run();
  assert.equal(show.tmdbId,10);
  assert.equal(f.selection().tmdb.override,undefined,"Plex removing B clears the override");
  assert.equal(f.selection().tmdb.current?.state,"preferred");
  assert.equal(show.tvdbId,1,"TVDB is unchanged throughout");
  assert.equal(f.selection().tvdb.current?.usingId,1);
});

test("an unavailable preferred catalogue stays in use through exactly 60 days, then falls back until B recovers", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  const downloaded = Date.parse(day(2));
  f.at(day(2)); await f.run();
  assert.equal(f.tmdbDownloads(11),1);

  f.at(new Date(downloaded + 10 * DAY).toISOString());
  let show = await f.run();
  assert.equal(f.tmdbDownloads(11),0,"B is reused within its freshness window");
  assert.equal(f.selection().tmdb.current?.preferredDownloadedAt,day(2),"reuse never renews the download time");

  f.tmdb[11].fail = true;
  for (const [offset,label] of [[-1,"just before"],[0,"exactly at"]] as const) {
    f.at(new Date(downloaded + 60 * DAY + offset).toISOString());
    show = await f.run();
    assert.ok(f.requests.includes("/3/tv/11"),`B is looked up ${label} 60 days`);
    assert.equal(show.tmdbId,11,`saved B is still compared ${label} 60 days`);
    assert.equal(f.selection().tmdb.current?.state,"saved-unavailable");
  }
  assert.equal(f.selection().tmdb.current?.preferredUsableUntil,new Date(downloaded + 60 * DAY).toISOString());

  f.at(new Date(downloaded + 60 * DAY + 1).toISOString());
  show = await f.run();
  assert.equal(show.tmdbId,10,"saved B is unusable once older than 60 days");
  assert.equal(f.selection().tmdb.current?.state,"fallback");
  assert.equal(f.selection().tmdb.override,11);

  f.tmdb[11].fail = false;
  f.at(new Date(downloaded + 61 * DAY).toISOString());
  show = await f.run();
  assert.equal(show.tmdbId,11,"B loading again restores it without reselecting it");
  assert.deepEqual(missingTmdb(show),[1102,1103]);
  const current = f.selection().tmdb.current!;
  assert.equal(current.state,"preferred"); assert.equal(current.usingId,11);
  assert.equal(current.preferredDownloadedAt,new Date(downloaded + 61 * DAY).toISOString(),"only a successful download renews the clock");
  assert.equal(current.preferredFailedAt,undefined);
  assert.ok(!(await f.issues()).some(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`));
});

test("when no candidate can supply a usable catalogue, last-good results stay with a Coverage Issue", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  f.at(day(2)); const good = await f.run();
  assert.deepEqual(missingTmdb(good),[1102,1103]);
  f.tmdb[11].fail = true; f.tmdb[10].fail = true;
  f.at(day(70));
  const show = await f.run();
  assert.ok(show.warning,"no current successful comparison is claimed");
  assert.deepEqual(missingTmdb(show),[1102,1103],"last-good results are kept, never an empty missing list");
  assert.equal(f.selection().tmdb.current?.state,"unavailable");
  assert.equal(f.selection().tmdb.current?.usingId,undefined);
  const root = (await f.issues() as {id:string;impacts?:string[];lookup?:{impact:string}}[]).find(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`);
  assert.match(root?.lookup?.impact || "",/No TMDB series reported by Plex could supply a usable catalogue/);
  assert.ok(root?.impacts?.some(impact=>impact.includes("Episode comparison could not be checked")),"the comparison issue is folded into its cause");
});

test("the catalogue in use for a provider with several IDs is downloaded again once older than 20 days", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11]; f.setSecond({tmdb:12,tvdb:2});
  const downloaded = Date.parse(day(1));
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11); await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",null);
  let show = await f.run();
  assert.equal(show.tmdbId,10,"A is in use; B is a saved but unused candidate");
  for (const days of [7,14]) { f.at(new Date(downloaded + days * DAY).toISOString()); await f.run(); }
  const downloads = () => [f.tmdbDownloads(10),f.tmdbDownloads(11),f.tmdbDownloads(12),f.tvdbDownloads(1),f.tvdbDownloads(2)];
  for (const [offset,label] of [[-1,"just before"],[0,"exactly at"]] as const) {
    f.at(new Date(downloaded + 20 * DAY + offset).toISOString());
    show = await f.run();
    assert.deepEqual(downloads(),[0,0,0,0,0],`nothing is downloaded ${label} 20 days`);
  }
  f.at(new Date(downloaded + 20 * DAY + 1).toISOString());
  show = await f.run();
  assert.deepEqual(downloads(),[1,0,0,0,0],"only the multiple-ID provider's catalogue in use is refreshed after 20 days");
  assert.equal(f.selection().tmdb.current?.usingDownloadedAt,new Date(downloaded + 20 * DAY + 1).toISOString());
});

test("a failed 20-day refresh keeps saved B in use, retries next scan and renews no clock", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  const downloaded = Date.parse(day(2));
  f.at(day(2)); await f.run();
  f.tmdb[11].fail = true;
  f.at(new Date(downloaded + 20 * DAY + 1).toISOString());
  let show = await f.run();
  assert.ok(f.requests.includes("/3/tv/11"),"the refresh was attempted");
  assert.equal(show.tmdbId,11,"saved B stays in use");
  assert.deepEqual(missingTmdb(show),[1102,1103]);
  assert.equal(f.selection().tmdb.current?.state,"saved-unavailable");
  assert.equal(f.selection().tmdb.current?.preferredDownloadedAt,day(2),"a failed refresh restarts neither clock");
  f.at(new Date(downloaded + 21 * DAY).toISOString());
  show = await f.run();
  assert.ok(f.requests.includes("/3/tv/11"),"the refresh is retried on the next scan");
  assert.equal(f.selection().tmdb.current?.usingDownloadedAt,day(2));
  f.tmdb[11].fail = false;
  f.at(new Date(downloaded + 22 * DAY).toISOString());
  show = await f.run();
  assert.equal(f.tmdbDownloads(11),1);
  assert.equal(f.selection().tmdb.current?.state,"preferred");
  assert.equal(f.selection().tmdb.current?.preferredDownloadedAt,new Date(downloaded + 22 * DAY).toISOString());
});
