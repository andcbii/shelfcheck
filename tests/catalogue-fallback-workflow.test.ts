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
const catalogues = await import("../lib/plex-catalogues");
const reportData = await import("../app/reports/report-data");
const { ActiveScanTracker } = await import("../lib/scan-concurrency");
const { seriesNotFoundHistory } = await import("../lib/series-not-found-history");
const manualCoverage = await import("../lib/manual-coverage");
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
  sqlite.savedScanState("plex").options.patch({diagnosticsEnabled:false});
  t.mock.timers.enable({apis:["Date"],now:new Date(day(1))});
  const plex = {tmdb:[10] as number[], tvdb:[1] as number[]};
  /** A second, single-ID show, when set. */
  let second: {tmdb:number;tvdb:number} | undefined;
  /** Plex's per-show metadata answer: complete, without provider IDs (an incomplete observation), or a failed request. */
  let metadata: "complete" | "no-guids" | "fail" = "complete";
  /** TMDB series; `reports` is the ID TMDB answers a request for that series with, when it differs. */
  const tmdb: Record<number,{episodes:number;tvdb?:number|null;fail?:boolean;noShow?:boolean;seasonFail?:boolean;reports?:number}> = {10:{episodes:2,tvdb:1},11:{episodes:3,tvdb:1},12:{episodes:1,tvdb:2}};
  const tvdb: Record<number,{episodes:number;fail?:boolean}> = {1:{episodes:1},2:{episodes:1},3:{episodes:1}};
  let tmdbChanges: number[] = [];
  /** When set, TVDB sign-in is refused. */
  let tvdbLoginFails = false;
  const requests: string[] = [];
  /** TMDB's find answer for each TVDB series: the TMDB series it names, or a failed request. Unlisted series name none. */
  const find: Record<number,{tmdb?:number;fail?:boolean}> = {};
  /** Every provider request path and every reported scan phase, in order. */
  const timeline: string[] = [];
  const reportPhase = ActiveScanTracker.prototype.update;
  t.mock.method(ActiveScanTracker.prototype,"update",function(this: InstanceType<typeof ActiveScanTracker>, key: string, show: string, phase: string) { timeline.push(`phase ${phase}`); return reportPhase.call(this,key,show,phase); });
  /** TVDB series whose requests are held until released; a released request fails. */
  const heldTvdb = new Map<number,{started:boolean;release:()=>void}>();
  const guids = (ids: {tmdb:number[];tvdb:number[]}) => [...ids.tmdb.map(id=>({id:`tmdb://${id}`})),...ids.tvdb.map(id=>({id:`tvdb://${id}`}))];
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u.pathname); timeline.push(u.pathname);
    const shows = [{ratingKey:"1",title:"Scooby",Guid:guids(plex),updatedAt:1},...(second ? [{ratingKey:"2",title:"Other",Guid:guids({tmdb:[second.tmdb],tvdb:[second.tvdb]}),updatedAt:1}] : [])];
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname === "/library/sections/1/all") return Response.json({MediaContainer:{Metadata:shows}});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:[{ratingKey:"ep",parentIndex:1,index:1,Guid:[]}]}});
      const key = u.pathname.match(/^\/library\/metadata\/(\d+)$/)?.[1];
      if(metadata === "fail") return Response.json({},{status:404});
      return Response.json({MediaContainer:{Metadata:shows.filter(show=>show.ratingKey === key).map(show=>metadata === "no-guids" ? {...show,Guid:undefined} : show)}});
    }
    if(u.pathname === "/v4/login") return tvdbLoginFails ? Response.json({},{status:401}) : Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:tmdbChanges.map(id=>({id})),total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:[]});
    const tmdbShow = u.pathname.match(/^\/3\/tv\/(\d+)(\/season\/1)?$/);
    if(tmdbShow && tmdb[Number(tmdbShow[1])]) {
      const id = Number(tmdbShow[1]), series = tmdb[id];
      if(series.fail) return Response.json({status_message:"not found"},{status:404});
      if(series.noShow && !tmdbShow[2]) return Response.json(null);
      if(series.seasonFail && tmdbShow[2]) return Response.json({status_message:"not found"},{status:404});
      if(!tmdbShow[2]) return Response.json({id:series.reports ?? id,name:`TMDB ${id}`,seasons:[{season_number:1}],external_ids:{tvdb_id:series.tvdb ?? null}});
      return Response.json({episodes:Array.from({length:series.episodes},(_,n)=>({id:id*100+n+1,season_number:1,episode_number:n+1,name:`Episode ${n+1}`,air_date:"2020-01-01"}))});
    }
    const tvdbSeries = u.pathname.match(/^\/v4\/series\/(\d+)(\/episodes\/default)?$/);
    if(tvdbSeries && tvdb[Number(tvdbSeries[1])]) {
      const id = Number(tvdbSeries[1]), series = tvdb[id];
      const held = heldTvdb.get(id);
      if(held) { held.started = true; await new Promise<void>(release=>{ held.release = release; }); return Response.json({},{status:404}); }
      if(series.fail) return Response.json({},{status:404});
      if(!tvdbSeries[2]) return Response.json({data:{id,name:`TVDB ${id}`,slug:`tvdb-${id}`}});
      return Response.json({data:{episodes:Array.from({length:series.episodes},(_,n)=>({id:id*1000+n+1,seasonNumber:1,number:n+1,name:`Episode ${n+1}`,aired:"2020-01-01"}))}});
    }
    // Manual Match member verification: a TMDB episode answers 404 while its series fails.
    const tmdbEpisode = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1\/episode\/(\d+)$/);
    if(tmdbEpisode) return tmdb[Number(tmdbEpisode[1])]?.fail ? Response.json({},{status:404}) : Response.json({id:Number(tmdbEpisode[1])*100+Number(tmdbEpisode[2])});
    const tvdbEpisode = u.pathname.match(/^\/v4\/episodes\/(\d+)\/extended$/);
    if(tvdbEpisode) return Response.json({data:{id:Number(tvdbEpisode[1])}});
    const findAnswer = find[Number(u.pathname.match(/^\/3\/find\/(\d+)$/)?.[1])];
    if(findAnswer?.fail) return Response.json({status_message:"unavailable"},{status:404});
    if(findAnswer?.tmdb) return Response.json({tv_results:[{id:findAnswer.tmdb,name:`TMDB ${findAnswer.tmdb}`}],tv_episode_results:[]});
    if(u.pathname.includes("/find/")) return Response.json({tv_results:[],tv_episode_results:[]});
    throw new Error("Unexpected HTTP: "+u);
  });
  const identity = "ratingKey:1";
  return {
    plex, tmdb, tvdb, find, timeline, identity, requests, heldTvdb,
    setSecond(value: typeof second) { second = value; },
    failTvdbLogin(value: boolean) { tvdbLoginFails = value; },
    setMetadata(value: typeof metadata) { metadata = value; },
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
/** Simulates the process ending: the next process starts with an empty owner record, and the abandoned run settles later. */
function abandonRunningScan(): Promise<void> {
  const global = globalThis as typeof globalThis & {__shelfcheckScanRun?: {owner?: unknown}};
  const abandoned = global.__shelfcheckScanRun!;
  global.__shelfcheckScanRun = {};
  return (async () => { while (abandoned.owner) await new Promise(r=>setTimeout(r,10)); })();
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
  const entry = reportData.getReportData().multipleIdShows.find(candidate => candidate.identity === f.identity)!;
  assert.deepEqual({using:entry.panels.tmdb.summary.using,preference:entry.panels.tmdb.summary.preference},{using:"Fallback: TMDB 10 (10)",preference:"Override: TMDB 11 (11)"},"the report shows preference B and currently using A");
  assert.match(entry.panels.tmdb.summary.explanation || "",/^Preferred: 11 · Currently using: 10 · 11 unavailable; saved catalogue expired 2026-06-11/);
  assert.deepEqual(entry.panels.tmdb.candidates.map(candidate => [candidate.id,candidate.override,candidate.using,candidate.unavailable]),[[10,false,true,false],[11,true,false,true]]);
  assert.equal(entry.panels.tvdb.summary.using,"TVDB 1 (1)","TVDB is unchanged in the report");
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

test("when no candidate can supply a usable catalogue, the show is compared with the other provider and TMDB keeps its Coverage Issue", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11]; f.tvdb[1].episodes = 2;
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  f.at(day(2)); const good = await f.run();
  assert.deepEqual(missingTmdb(good),[1102,1103]);
  f.tmdb[11].fail = true; f.tmdb[10].fail = true;
  f.at(day(70));
  // Deliberately changed again (SHELFCHECK-120, ADR-0006): with no candidate working or saved within 60 days, the most recently saved catalogue that is not gone (B) is compared at any age.
  let show = await f.run() as Judged;
  assert.deepEqual(missingTmdb(show),[1102,1103],"saved B, the newest catalogue that is not gone, is compared");
  assert.equal(show.missing.length,2,"TVDB's comparison runs too");
  assert.deepEqual(show.providerResolution?.providers?.tmdb,{state:"total-failure",catalogue:"saved",cause:"404 — record not found"});
  assert.equal(show.providerResolution?.status,"partially-matched");
  assert.equal(f.selection().tmdb.current?.state,"saved-unavailable");
  assert.equal(f.selection().tmdb.current?.usingId,11);
  let issues = await f.issues() as {id:string;impacts?:string[];lookup?:{impact:string};candidates?:{id:number;catalogueRefresh?:{gone?:true}}[]}[];
  let root = issues.find(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`);
  assert.match(root?.lookup?.impact || "",/no reported TMDB series has a catalogue from the last 60 days; the newest saved catalogue that is not gone/);
  assert.deepEqual(root?.candidates?.map(candidate=>candidate.id),[11,10],"the entry lists each candidate tried");
  assert.ok(!issues.some(issue=>issue.id === `comparison-inputs:${f.identity}`),"the comparison ran");

  // Every candidate gone: TMDB is gone for the show, and the show is compared with TVDB alone.
  for (const id of [10,11]) for (let n = 0; n < 14; n++) seriesNotFoundHistory().recordNotFound("tmdb",id,day(50 + n));
  f.at(day(71));
  show = await f.run() as Judged;
  assert.ok(show.warning,"TMDB's failure is reported with the result");
  assert.deepEqual(missingTmdb(show),[],"no TMDB catalogue is compared");
  assert.equal(show.missing.length,1,"TVDB's missing episode is reported");
  assert.deepEqual(show.providerResolution?.providers?.tmdb,{state:"total-failure",catalogue:"gone",cause:"404 — record not found"});
  assert.equal(show.providerResolution?.status,"partially-matched");
  assert.equal(f.selection().tmdb.current?.state,"unavailable");
  issues = await f.issues() as typeof issues;
  root = issues.find(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`);
  assert.match(root?.lookup?.impact || "",/Every reported TMDB series \(11, 10\) is a gone provider record/);
  assert.deepEqual(root?.candidates?.map(candidate=>candidate.catalogueRefresh?.gone),[true,true]);
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

test("without a Plex TVDB ID, the derived TVDB series follows the TMDB catalogue actually used", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11]; f.plex.tvdb = [];
  f.tmdb[10].tvdb = null; f.tmdb[11].tvdb = 3;
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  const derived = () => { const current = f.selection().tvdb.current; return current && {usingId:current.usingId,state:current.state,derivedFrom:current.derivedFrom}; };

  f.at(day(2)); let show = await f.run();
  assert.equal(show.tvdbId,3,"B's external IDs supply the TVDB series");
  assert.deepEqual(derived(),{usingId:3,state:"derived",derivedFrom:11});
  assert.deepEqual(f.selection().tvdb.candidates,[],"a derived ID is never a candidate");

  f.tmdb[11].fail = true; f.changes([11]);
  f.at(day(3)); show = await f.run();
  assert.equal(f.selection().tmdb.current?.state,"saved-unavailable");
  assert.equal(show.tvdbId,3,"saved B still supplies the TVDB series");

  f.changes([]);
  f.at(day(63)); show = await f.run();
  assert.equal(f.selection().tmdb.current?.state,"fallback");
  assert.equal(show.tmdbId,10);
  assert.equal(show.tvdbId,undefined,"fallback A has no TVDB link, so B's derived ID is not kept");
  assert.equal(derived(),undefined);

  f.tmdb[11].fail = false;
  f.at(day(64)); show = await f.run();
  assert.equal(show.tmdbId,11);
  assert.equal(show.tvdbId,3,"recovered B supplies the TVDB series again");
  assert.deepEqual(derived(),{usingId:3,state:"derived",derivedFrom:11});

  f.plex.tvdb = [1];
  f.at(day(65)); show = await f.run();
  assert.equal(show.tvdbId,1,"a Plex-reported TVDB ID always wins");
  assert.equal(f.selection().tvdb.current?.state,"preferred");
});

test("a cached recheck replays the catalogue in use without provider downloads", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  f.at(day(2)); await f.run();
  f.tmdb[11].fail = true;
  f.at(day(63)); const show = await f.run();
  assert.equal(show.tmdbId,10);
  f.requests.length = 0;
  await plexScan.requestCoverageRecheck({members:[{provider:"TMDB",id:1001,showId:10,show:"TMDB 10",title:"Episode 1",season:1,episode:1,url:""}]});
  assert.deepEqual(f.requests,[],"no provider or Plex requests");
  const rechecked = (await (await scan.GET()).json()).report.shows[0] as Show;
  assert.equal(rechecked.tmdbId,10,"fallback A is replayed, not preferred B");
  assert.deepEqual(missingTmdb(rechecked),[1002]);
  assert.equal(f.selection().tmdb.current?.state,"fallback");
});

test("a single-ID show keeps comparing its old saved catalogue, unverified, after 60 days", async t => {
  const f = await fixture(t);
  await f.run();
  f.tmdb[10].fail = true;
  f.at(day(100));
  const show = await f.run();
  assert.equal(show.tmdbId,10);
  assert.deepEqual(missingTmdb(show),[1002]);
  assert.ok(show.warning,"the result is marked unverified");
  const current = f.selection().tmdb.current!;
  assert.equal(current.state,"saved-unavailable");
  assert.equal(current.preferredUsableUntil,undefined,"no 60-day deadline applies to a single ID");
});

// Deliberately changed (ADR-0006): an empty show used to leave the show pending with last-good
// results and no Coverage Issue. It is now treated like a 404: a Total Provider Lookup Failure with no
// catalogue, compared with TVDB as Partially matched. It is not a series-request 404, so it is never counted.
for (const [label,tvdbIds] of [["a single-ID show",[1]],["a show with one TMDB ID and several TVDB IDs",[1,3]]] as const) test(`${label} whose TMDB show request answers with no show is compared with TVDB as Partially matched, with a TMDB catalogue Coverage Issue`, async t => {
  const f = await fixture(t);
  f.plex.tvdb = [...tvdbIds];
  await f.run();
  f.tmdb[10].noShow = true; f.changes([10]);
  f.at(day(2));
  const show = await f.run() as Show & {providerResolution?:{status?:string;providers?:Record<string,{state:string;catalogue?:string}>}};
  assert.ok(f.requests.includes("/3/tv/10"),"the changed show was requested");
  assert.equal(show.tmdbId,10);
  assert.deepEqual(missingTmdb(show),[],"TMDB's saved catalogue is not compared");
  assert.equal(show.providerResolution?.status,"partially-matched");
  assert.deepEqual([show.providerResolution?.providers?.tmdb?.state,show.providerResolution?.providers?.tmdb?.catalogue],["total-failure","none"]);
  assert.equal(show.warning,"TMDB returned no show 10.");
  const issues = await f.issues() as {id:string;causedBy?:string[]}[];
  assert.ok(issues.some(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`),"TMDB keeps a Scan Issues entry");
  assert.ok(!issues.some(issue=>issue.id === `comparison-inputs:${f.identity}`),"the comparison ran");
  assert.equal(catalogues.readPlexInputs().comparisons[f.identity]?.refresh?.tmdb,true,"TMDB is retried as after any failed download");
  assert.equal(f.selection().tmdb.current?.state,"unavailable");
  assert.equal(seriesNotFoundHistory().countedDays("tmdb",10),0,"an empty show is not a counted 404 day");
  assert.equal(f.tmdbDownloads(10),0);
});

/** No Plex TMDB ID and TVDB candidates 1 and 3: TMDB is derived from TVDB 1, whose find names TMDB 10. */
async function derivedFromSeveralTvdbIds(f: Awaited<ReturnType<typeof fixture>>) {
  f.plex.tmdb = []; f.plex.tvdb = [1,3]; f.find[1] = {tmdb:10};
  const show = await f.run();
  assert.equal(show.tmdbId,10); assert.deepEqual(missingTmdb(show),[1002]);
}

// Deliberately changed (ADR-0006): an empty show is treated like a 404, so the show is compared with TVDB instead of staying pending.
test("a derived TMDB series TMDB answers with no show is a TMDB catalogue Coverage Issue: the series last compared is not compared, and the show is compared with TVDB", async t => {
  const f = await fixture(t);
  await derivedFromSeveralTvdbIds(f);
  f.tmdb[10].noShow = true; f.changes([10]);
  f.at(day(2));
  const show = await f.run();
  assert.ok(f.requests.includes("/3/find/1") && f.requests.includes("/3/tv/10"),"the association and the changed show were requested");
  assert.equal(f.tmdbDownloads(10),0);
  assert.equal(show.tmdbId,10);
  assert.deepEqual(missingTmdb(show),[],"no TMDB catalogue is compared");
  assert.equal(show.warning,"TMDB returned no show 10.");
  const issues = await f.issues() as {id:string;causedBy?:string[]}[];
  assert.ok(issues.some(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`),"TMDB keeps a Scan Issues entry");
  assert.ok(!issues.some(issue=>issue.id === `comparison-inputs:${f.identity}`),"the comparison ran");
  assert.equal(catalogues.readPlexInputs().comparisons[f.identity]?.refresh?.tmdb,true,"TMDB is retried as after any failed download");
});

test("a show with several TVDB IDs and no Plex TMDB ID reports the TMDB phase before TMDB's find request, also when the find names no series", async t => {
  const f = await fixture(t);
  f.plex.tmdb = []; f.plex.tvdb = [1,3];
  const phaseBefore = (path: string) => { const at = f.timeline.indexOf(path); assert.ok(at >= 0,`${path} was requested`); return f.timeline.slice(0,at).filter(entry=>entry.startsWith("phase ")).at(-1); };
  f.timeline.length = 0;
  await f.run();
  assert.equal(phaseBefore("/v4/series/1/episodes/default"),"phase tvdb-series-and-episodes");
  assert.equal(phaseBefore("/3/find/1"),"phase tmdb-show-and-seasons","the find naming no series runs in the TMDB phase");

  f.find[1] = {tmdb:10};
  f.at(day(2)); f.timeline.length = 0;
  await f.run();
  assert.equal(phaseBefore("/3/find/1"),"phase tmdb-show-and-seasons");
  assert.equal(phaseBefore("/3/tv/10"),"phase tmdb-show-and-seasons");
});

test("TVDB applies the same saved-catalogue limit and fallback independently of TMDB", async t => {
  const f = await fixture(t);
  f.plex.tvdb = [1,3];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tvdb",3);
  f.at(day(2)); let show = await f.run();
  assert.equal(show.tvdbId,3);
  f.tvdb[3].fail = true;
  f.at(day(30)); show = await f.run();
  assert.equal(show.tvdbId,3);
  assert.equal(f.selection().tvdb.current?.state,"saved-unavailable");
  f.at(day(63)); show = await f.run();
  assert.equal(show.tvdbId,1,"TVDB falls back once saved B is older than 60 days");
  assert.equal(f.selection().tvdb.current?.state,"fallback");
  assert.equal(f.selection().tvdb.override,3);
  assert.equal(f.selection().tmdb.current?.state,"preferred","TMDB is unaffected");
});

test("an outstanding preferred requirement retries the preferred series every scan, while the fallback in use downloads only under its own freshness rules", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  f.at(day(2)); await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",null);
  f.at(day(50)); await f.run();
  assert.equal(f.tmdbDownloads(10),1,"A is downloaded on day 50 and young afterwards");
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  f.tmdb[11].fail = true;
  const obligation = () => catalogues.readPlexInputs().comparisons[f.identity]?.refresh;

  f.at(day(63)); let show = await f.run();
  assert.equal(show.tmdbId,10); assert.equal(f.selection().tmdb.current?.state,"fallback");
  assert.equal(f.tmdbDownloads(10),0,"without an obligation, young A is reused");
  assert.equal(obligation()?.tmdb,true,"B's failure leaves a refresh obligation");

  // Deliberately changed (SHELFCHECK-97): the open obligation used to download young A on every scan.
  for (const n of [64,65,70]) {
    f.at(day(n)); show = await f.run();
    assert.ok(f.requests.includes("/3/tv/11"),"B is retried");
    assert.equal(f.tmdbDownloads(10),0,`A, ${n - 50} days old, is reused on day ${n}: B's requirement never forces the fallback`);
    assert.equal(show.tmdbId,10);
    assert.equal(obligation()?.tmdb,true,"B's requirement stays open");
    assert.equal(obligation()?.tvdb,undefined,"TVDB has no obligation of its own");
    assert.equal(f.selection().tmdb.current?.usingDownloadedAt,day(50));
  }
  assert.equal(f.selection().tmdb.current?.preferredDownloadedAt,day(2),"B's download time is unchanged");

  // Day 71: A is older than 20 days, so it is downloaded again; that download fails.
  f.tmdb[10].fail = true;
  f.at(day(71)); show = await f.run();
  assert.equal(show.tmdbId,10,"saved A, within 60 days, is still compared");
  assert.deepEqual(missingTmdb(show),[1002]);
  assert.equal(show.warning,undefined,"no duplicate generic warning for a complete saved comparison");
  let current = f.selection().tmdb.current!;
  assert.equal(current.state,"fallback"); assert.equal(current.usingDownloadedAt,day(50),"A's failed refresh renews nothing");
  assert.equal(current.usingFailedAt,day(71),"A's failed refresh is recorded with the catalogue in use");
  assert.equal(obligation()?.tmdb,true);
  type Issue = {id:string;operation:string;show?:{tmdbId?:number};lookup?:{impact:string};candidates?:{id:number;cause:string}[]};
  const fallbackIssue = (issues: Issue[]) => issues.find(issue=>issue.id === `catalogue-fallback-refresh:TMDB:${f.identity}`);
  const refreshIssue = (issues: Issue[]) => issues.find(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`);
  let issues = await f.issues() as Issue[];
  // Deliberately changed (SHELFCHECK-27): a failing provider has one entry listing each candidate tried, so A's failure is no longer a second entry.
  assert.ok(refreshIssue(issues),"B's failure stays a Coverage Issue");
  assert.deepEqual(refreshIssue(issues)?.candidates?.map(candidate=>candidate.id),[11,10],"the entry lists B and A");
  assert.equal(fallbackIssue(issues),undefined);
  assert.match(refreshIssue(issues)?.lookup?.impact || "",/saved catalogue, downloaded 2026-02-20/);

  f.restart();
  await plexScan.requestCoverageRecheck({members:[{provider:"TMDB",id:1001,showId:10,show:"TMDB 10",title:"Episode 1",season:1,episode:1,url:""}]});
  issues = await f.issues() as Issue[];
  assert.deepEqual(refreshIssue(issues)?.candidates?.map(candidate=>candidate.id),[11,10],"a cached recheck preserves A's and B's failures");
  assert.equal(f.selection().tmdb.current?.usingFailedAt,day(71));

  f.tmdb[10].fail = false;
  f.at(day(72)); show = await f.run();
  assert.equal(f.tmdbDownloads(10),1,"A, still older than 20 days, downloads once it loads again");
  assert.equal(f.selection().tmdb.current?.usingDownloadedAt,day(72));
  assert.equal(obligation()?.tmdb,true,"a fallback download does not satisfy B's requirement");
  issues = await f.issues() as Issue[];
  assert.equal(fallbackIssue(issues),undefined);
  assert.deepEqual(refreshIssue(issues)?.candidates?.map(candidate=>candidate.id),[11],"A's refresh failure is resolved: TMDB works again through A, and only B's failure remains");

  f.tmdb[11].fail = false;
  f.at(day(73)); show = await f.run();
  assert.equal(show.tmdbId,11,"B recovers");
  assert.equal(f.tmdbDownloads(10),0,"A is no longer loaded");
  assert.equal(obligation()?.tmdb,undefined,"a successful B download clears only TMDB's obligation");
  current = f.selection().tmdb.current!;
  assert.equal(current.state,"preferred"); assert.equal(current.usingFailedAt,undefined);
  issues = await f.issues() as Issue[];
  assert.ok(!issues.some(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`));
  assert.equal(fallbackIssue(issues),undefined,"A's refresh failure no longer affects the comparison");
});

test("a scan interrupted after a show's preferred TMDB download keeps that progress, so the restarted scan does only the unfinished TVDB work", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  f.at(day(2)); await f.run();
  const saved = () => catalogues.readPlexInputs();
  catalogues.savePlexComparison(f.identity,{...saved().comparisons[f.identity],refresh:{tmdb:true,tvdb:true}});

  f.at(day(3));
  const held = {started:false,release:()=>{}};
  f.heldTvdb.set(1,held);
  t.after(() => held.release());
  f.requests.length = 0;
  await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
  for (let i=0; i<500 && !held.started; i++) await new Promise(r=>setTimeout(r,10));
  assert.ok(held.started,"the TVDB request is in flight");
  assert.equal(f.tmdbDownloads(11),1,"the obligation downloads the preferred TMDB catalogue although it is young");
  assert.deepEqual(saved().comparisons[f.identity].refresh,{tvdb:true},"TMDB's satisfied obligation is saved before TVDB's work finishes");
  assert.equal(saved().tmdb["11"].downloadedAt,day(3),"the download is saved as soon as it succeeds");

  const interrupted = abandonRunningScan();
  f.heldTvdb.delete(1);
  f.restart();
  f.at(day(3).replace("12:00","13:00"));
  const show = await f.run();
  assert.deepEqual([f.tmdbDownloads(10),f.tmdbDownloads(11),f.tvdbDownloads(1)],[0,0,1],"only the unfinished mandatory TVDB download is repeated");
  assert.equal(show.tmdbId,11); assert.deepEqual(missingTmdb(show),[1102,1103]);
  assert.deepEqual(saved().comparisons[f.identity].refresh,{},"no obligation remains");
  held.release();
  await interrupted;
});

/**
 * TMDB candidates A (10) and B (11): B is preferred by override and failing with no saved copy within
 * 60 days, so A, downloaded on day 50, is the fallback in use from day 63. B's failure leaves the
 * preferred requirement open; `clearObligation` then removes it, so a writer can be observed alone.
 */
async function youngFallbackA(f: Awaited<ReturnType<typeof fixture>>) {
  f.plex.tmdb = [10,11];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  f.at(day(2)); await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",null);
  f.at(day(50)); await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",11);
  f.tmdb[11].fail = true;
  f.at(day(63)); await f.run();
  assert.equal(f.selection().tmdb.current?.state,"fallback");
  assert.equal(f.selection().tmdb.current?.usingDownloadedAt,day(50));
  return {
    refresh: () => catalogues.readPlexInputs().comparisons[f.identity]?.refresh,
    /** Replace the saved obligation: no requirement, or a specific requirement for an uncompared catalogue (12) a writer must keep. */
    clearObligation() { catalogues.savePlexComparison(f.identity,{...catalogues.readPlexInputs().comparisons[f.identity],refresh:{specificIds:{tmdb:[12]}}}); },
  };
}

for (const [writer,write] of [
  ["a Manual Match change",() => plexScan.requestCoverageRecheck({members:[{provider:"TMDB",id:1001,showId:10,show:"TMDB 10",title:"Episode 1",season:1,episode:1,url:""}]})],
  ["a catalogue override change",(f: Awaited<ReturnType<typeof fixture>>) => plexScan.requestCatalogueRecheck(f.identity,"tmdb")],
] as const) {
  test(`${writer} adds the preferred requirement without replacing other parts, and the next scan does not download the young fallback again`, async t => {
    const f = await fixture(t);
    const show = await youngFallbackA(f);
    show.clearObligation();
    f.at(day(64));
    await write(f);
    const refresh = show.refresh();
    assert.equal(refresh?.tmdb,true,"the preferred requirement is added");
    assert.deepEqual(refresh?.specificIds,{tmdb:[12]},"the other requirement is kept");

    f.at(day(65)); await f.run();
    assert.ok(f.requests.includes("/3/tv/11"),"B is retried");
    assert.equal(f.tmdbDownloads(10),0,"young A is reused");
    assert.equal(show.refresh()?.tmdb,true,"B's requirement stays open");
  });
}

test("after a single-show Clear cache, a failing preferred series still downloads its young fallback until the preferred series downloads again", async t => {
  const f = await fixture(t);
  const show = await youngFallbackA(f);
  // Open safeguard work: a specific requirement for an uncompared catalogue (12) the clear must keep.
  show.clearObligation();
  f.at(day(64));
  plexScan.clearPlexScanCache(f.identity);
  assert.deepEqual(show.refresh(),{specificIds:{tmdb:[12]},everyAttempted:{tmdb:true,tvdb:true}},"the clear adds every-attempted without replacing other parts");
  assert.ok(catalogues.readPlexInputs().tmdb["10"],"the shared catalogue A is not deleted");

  for (const n of [65,66]) {
    f.at(day(n)); const result = await f.run();
    assert.ok(f.requests.includes("/3/tv/11"),"B is retried");
    assert.equal(f.tmdbDownloads(10),1,`young A is downloaded on day ${n}`);
    assert.equal(result.tmdbId,10);
    assert.equal(f.selection().tmdb.current?.usingDownloadedAt,day(n));
    assert.deepEqual(show.refresh(),{tmdb:true,specificIds:{tmdb:[12]},everyAttempted:{tmdb:true}},"a fallback download satisfies nothing; TVDB's single catalogue download satisfies TVDB");
  }

  f.tmdb[11].fail = false;
  f.at(day(67)); const result = await f.run();
  assert.equal(result.tmdbId,11,"B recovers");
  assert.deepEqual(show.refresh(),{specificIds:{tmdb:[12]}},"B's download satisfies the preferred and every-attempted requirements, and keeps the safeguard's");
  f.at(day(68)); await f.run();
  assert.equal(f.tmdbDownloads(11),0,"young B is reused once every requirement it satisfies is closed");
});

test("a fallback in use is downloaded again once older than 20 days while the preferred requirement is open", async t => {
  const f = await fixture(t);
  const show = await youngFallbackA(f);
  f.at(day(70)); await f.run();
  assert.equal(f.tmdbDownloads(10),0,"A is reusable at exactly 20 days");
  f.at(new Date(Date.parse(day(70)) + 1).toISOString()); await f.run();
  assert.equal(f.tmdbDownloads(10),1,"A older than 20 days is downloaded");
  assert.equal(show.refresh()?.tmdb,true,"and satisfies nothing");
});

test("an obligation saved before requirements existed reads as preferred-only, so its fallback part is lost once", async t => {
  const f = await fixture(t);
  const show = await youngFallbackA(f);
  // Day 71: A, older than 20 days, is downloaded; TMDB then reports A changed the same UTC day.
  f.at(day(71)); await f.run();
  assert.equal(f.tmdbDownloads(10),1);
  // A pre-upgrade fifth-scan safeguard for A stored only the provider flag.
  catalogues.savePlexComparison(f.identity,{...catalogues.readPlexInputs().comparisons[f.identity],refresh:{tmdb:true}});
  f.changes([10]);
  f.at(day(71).replace("12:00","13:00")); await f.run();
  assert.ok(f.requests.includes("/3/tv/11"),"the flag still requires preferred B");
  assert.equal(f.tmdbDownloads(10),0,"the accepted loss: A, changed but downloaded earlier today, is reused instead of downloaded");
  assert.deepEqual(show.refresh(),{tmdb:true});
});

/**
 * With B's preferred requirement open, day 71's first scan downloads A (older than 20 days), and TMDB
 * then reports A changed the same UTC day, so scans two to four reuse it. The fifth completed scan's
 * safeguard targets A, the compared catalogue.
 */
async function safeguardedFallbackA(f: Awaited<ReturnType<typeof fixture>>) {
  const show = await youngFallbackA(f);
  f.at(day(71)); await f.run();
  assert.equal(f.tmdbDownloads(10),1);
  f.changes([10]);
  for (const hour of [13,14,15]) {
    f.at(day(71).replace("12:00",`${hour}:00`)); await f.run();
    assert.equal(f.tmdbDownloads(10),0,"A, changed but downloaded earlier today, is reused under TMDB's same-day reuse");
  }
  assert.deepEqual(show.refresh(),{tmdb:true},"B's preferred requirement is the open work");
  f.at(day(71).replace("12:00","16:00"));
  return show;
}

test("a fifth-scan safeguard forces the fallback downloaded earlier the same UTC day while preferred work is open, satisfying only its own requirement", async t => {
  const f = await fixture(t);
  const show = await safeguardedFallbackA(f);
  await f.run();
  assert.ok(f.requests.includes("/3/tv/11"),"B is retried");
  assert.equal(f.tmdbDownloads(10),1,"the safeguard downloads A again");
  f.restart();
  assert.deepEqual(show.refresh(),{tmdb:true},"after a restart only B's requirement remains");

  f.at(day(71).replace("12:00","17:00")); await f.run();
  assert.equal(f.tmdbDownloads(10),0,"the next ordinary scan reuses A");
  assert.ok(f.requests.includes("/3/tv/11"),"B is still retried");
  assert.deepEqual(show.refresh(),{tmdb:true});
});

test("a failed or incomplete safeguarded fallback download keeps its requirement until a later download succeeds", async t => {
  const f = await fixture(t);
  const show = await safeguardedFallbackA(f);
  f.tmdb[10].seasonFail = true;
  await f.run();
  assert.ok(f.requests.includes("/3/tv/10"),"A's series is fetched, but its episodes are not");
  assert.deepEqual(show.refresh(),{tmdb:true,specificIds:{tmdb:[10]}},"an incomplete download satisfies nothing");
  f.tmdb[10].seasonFail = false;
  f.tmdb[10].fail = true;
  f.at(day(71).replace("12:00","16:30")); await f.run();
  assert.equal(f.tmdbDownloads(10),0,"A's download fails");
  assert.deepEqual(show.refresh(),{tmdb:true,specificIds:{tmdb:[10]}},"the safeguard's requirement for A is kept beside B's");

  f.tmdb[10].fail = false;
  f.at(day(71).replace("12:00","17:00")); await f.run();
  assert.equal(f.tmdbDownloads(10),1,"the next ordinary scan downloads A, though it was downloaded earlier today");
  assert.deepEqual(show.refresh(),{tmdb:true},"only B's requirement remains");
});

test("preferred, specific and every-attempted requirements coexist, a cached recheck consumes none, and each provider's downloads satisfy only their own", async t => {
  const f = await fixture(t);
  const show = await youngFallbackA(f);
  const all = {tmdb:true,specificIds:{tmdb:[10]},everyAttempted:{tvdb:true as const}};
  catalogues.savePlexComparison(f.identity,{...catalogues.readPlexInputs().comparisons[f.identity],refresh:all});
  f.at(day(64)); f.requests.length = 0;
  await plexScan.requestCatalogueRecheck(f.identity,"tmdb");
  assert.equal(f.requests.length,0,"the cached recheck makes no request");
  assert.deepEqual(show.refresh(),all,"and consumes no requirement");

  await f.run();
  assert.ok(f.requests.includes("/3/tv/11"),"B, still failing, is retried");
  assert.deepEqual([f.tmdbDownloads(10),f.tvdbDownloads(1)],[1,1],"A's specific requirement forces young A; TVDB's every-attempted requirement forces TVDB 1");
  assert.deepEqual(show.refresh(),{tmdb:true},"A's download satisfies only its own requirement, TVDB's only TVDB's");

  f.tmdb[11].fail = false;
  f.at(day(65)); await f.run();
  assert.deepEqual([f.tmdbDownloads(11),f.tmdbDownloads(10),f.tvdbDownloads(1)],[1,0,0]);
  assert.deepEqual(show.refresh(),{},"B's download satisfies the preferred requirement");
});

const catalogueIssueIds = (identity: string) => ["TMDB","TVDB"].flatMap(name => [`catalogue-refresh:${name}:${identity}`,`catalogue-fallback-refresh:${name}:${identity}`]);

test("a safeguard requirement on hold forces nothing and survives restarts and incomplete or failed Plex observations, until a complete one removes its candidate", async t => {
  const f = await fixture(t);
  const show = await safeguardedFallbackA(f);
  f.tmdb[10].fail = true;
  await f.run();
  assert.deepEqual(show.refresh(),{tmdb:true,specificIds:{tmdb:[10]}},"the safeguard's download of A failed");

  f.tmdb[10].fail = false; f.tmdb[11].fail = false;
  f.at(day(71).replace("12:00","17:00"));
  let result = await f.run();
  assert.equal(result.tmdbId,11,"B recovers, so A is no longer compared");
  assert.equal(f.tmdbDownloads(10),0,"A, not compared, is not downloaded");
  assert.deepEqual(show.refresh(),{specificIds:{tmdb:[10]}},"A's requirement is on hold");
  assert.equal(result.warning,undefined,"the comparison is healthy");
  const active = async () => (await f.issues()).map(issue=>issue.id).filter(id=>[...catalogueIssueIds(f.identity),`comparison-inputs:${f.identity}`].includes(id));
  assert.deepEqual(await active(),[],"a requirement on hold is no active failure");

  f.restart();
  f.at(day(71).replace("12:00","18:00"));
  result = await f.run();
  assert.deepEqual([f.tmdbDownloads(10),f.tmdbDownloads(11),f.tvdbDownloads(1)],[0,0,0],"on hold, it forces no catalogue");
  assert.equal(result.warning,undefined);
  assert.deepEqual(show.refresh(),{specificIds:{tmdb:[10]}},"it is kept across a restart");

  f.plex.tmdb = [11];
  for (const [answer,label] of [["no-guids","an incomplete"],["fail","a failed"]] as const) {
    f.setMetadata(answer); await f.run();
    assert.deepEqual(show.refresh(),{specificIds:{tmdb:[10]}},`${label} observation without A is no removal`);
  }
  f.setMetadata("complete");
  result = await f.run();
  assert.equal(result.tmdbId,11);
  assert.deepEqual(show.refresh(),{},"a complete observation removing A from the candidates drops its requirement");
  assert.equal(f.tmdbDownloads(10),0);
});

test("a complete observation removing a candidate also drops a safeguard requirement naming the ID that candidate's catalogue reported, even after comparison switched away and a restart", async t => {
  const f = await fixture(t);
  const refresh = () => catalogues.readPlexInputs().comparisons[f.identity].refresh;
  // TMDB answers a request for series 13 with series 14's ID.
  f.tmdb[13] = {episodes:1,tvdb:1,reports:14}; f.tmdb[14] = {episodes:1,tvdb:1};
  f.plex.tmdb = [10,13];
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tmdb",13);
  f.at(day(2));
  let result = await f.run();
  assert.equal(result.tmdbId,14,"candidate 13 is compared under the ID its catalogue reports");

  // The fifth completed scan's safeguard names the reported ID; its download fails, so it stays open.
  f.changes([14]);
  for (const hour of [13,14,15]) { f.at(day(2).replace("12:00",`${hour}:00`)); await f.run(); }
  // The request for 13 is answered under 14, so its episodes are requested as 14's.
  f.tmdb[14].seasonFail = true;
  f.at(day(2).replace("12:00","16:00")); await f.run();
  assert.deepEqual([refresh()?.specificIds,refresh()?.requestedIds],[{tmdb:[14]},{tmdb:{14:13}}],"the safeguard requires 14 and records 13, the Plex candidate requested for it");

  // Comparison switches to candidate 10, so the requirement for 14 is on hold, across a restart.
  f.tmdb[14].seasonFail = false; f.changes([]);
  selections.saveCatalogueOverride(f.identity,"tmdb",10);
  f.at(day(3));
  result = await f.run();
  assert.equal(result.tmdbId,10);
  assert.deepEqual(refresh(),{specificIds:{tmdb:[14]},requestedIds:{tmdb:{14:13}}},"the requirement for 14 is on hold");
  f.restart();

  f.plex.tmdb = [10];
  f.at(day(4));
  result = await f.run();
  assert.equal(result.tmdbId,10);
  assert.deepEqual(refresh(),{},"removing candidate 13 drops the requirement for 14, its catalogue's reported ID");
});

test("a fallback's safeguard requirement on hold applies when that catalogue is compared again", async t => {
  const f = await fixture(t);
  const show = await safeguardedFallbackA(f);
  f.tmdb[10].fail = true; await f.run();
  f.tmdb[10].fail = false; f.tmdb[11].fail = false;
  f.at(day(71).replace("12:00","17:00")); await f.run();
  assert.deepEqual(show.refresh(),{specificIds:{tmdb:[10]}},"A's requirement is on hold while B is compared");

  // Overriding the preference to A directly in the store raises no preferred requirement.
  selections.saveCatalogueOverride(f.identity,"tmdb",10);
  f.at(day(71).replace("12:00","18:00"));
  const result = await f.run();
  assert.equal(result.tmdbId,10,"A is compared again");
  assert.equal(f.tmdbDownloads(10),1,"its requirement forces A, downloaded earlier today, to download");
  assert.deepEqual(show.refresh(),{},"A's download satisfies its requirement");
});

test("with no Plex TMDB candidate, a safeguard for the derived TMDB catalogue stays on hold while the derivation moves away, and forces its same-day download when derived again", async t => {
  const f = await fixture(t);
  f.plex.tmdb = []; f.find[1] = {tmdb:10}; f.find[2] = {tmdb:12};
  const refresh = () => catalogues.readPlexInputs().comparisons[f.identity]?.refresh;
  f.at(day(5));
  let result = await f.run();
  assert.equal(result.tmdbId,10,"TMDB 10 is derived from TVDB 1");
  assert.equal(f.tmdbDownloads(10),1);
  f.changes([10]);
  for (const hour of [13,14,15]) {
    f.at(day(5).replace("12:00",`${hour}:00`)); await f.run();
    assert.equal(f.tmdbDownloads(10),0,"changed but downloaded earlier today, derived 10 is reused");
  }

  // Before the fifth scan, Plex reports TVDB 2 instead, which fails to load and whose TMDB association names 12.
  f.plex.tvdb = [2]; f.tvdb[2].fail = true;
  f.at(day(5).replace("12:00","16:00"));
  await f.run();
  assert.ok(f.requests.includes("/3/find/2"),"TMDB is derived from TVDB 2");
  assert.equal(f.tmdbDownloads(10),0,"derived 10 is no longer compared, so it is not downloaded");
  assert.deepEqual(refresh(),{tvdb:true,specificIds:{tmdb:[10]}},"the safeguard's requirement for derived 10 is on hold, an empty TMDB candidate set being no removal, beside TVDB 2's failure");
  assert.equal(f.selection().tmdb.candidates.length,0);

  f.restart();
  f.plex.tvdb = [1]; f.tvdb[2].fail = false;
  f.at(day(5).replace("12:00","17:00"));
  result = await f.run();
  // Changed (SHELFCHECK-27): the 16:00 scan compared TMDB 12 with TVDB 2 failing, now a complete comparison
  // that replaced the saved association for TVDB 1, so it is requested again; the safeguard forces only the download.
  assert.ok(f.requests.includes("/3/find/1"),"saved evidence no longer answers the association for TVDB 1");
  assert.equal(result.tmdbId,10,"10 is derived again");
  assert.equal(f.tmdbDownloads(10),1,"its requirement forces 10, downloaded earlier today, to download");
  assert.deepEqual(refresh(),{},"that download satisfies it");
});

/**
 * Prepare `provider` with candidates A (lower) and B: B is preferred by override and failing, its saved
 * catalogue downloaded on day 2; A's saved catalogue was downloaded on day 40. Day 41's scan compares saved B.
 */
async function savedBWithYoungA(f: Awaited<ReturnType<typeof fixture>>, provider: "tmdb" | "tvdb", a: number, b: number) {
  f.plex[provider] = [a,b];
  await f.run();
  selections.saveCatalogueOverride(f.identity,provider,b);
  f.at(day(2)); await f.run();
  selections.saveCatalogueOverride(f.identity,provider,null);
  f.at(day(40)); await f.run();
  selections.saveCatalogueOverride(f.identity,provider,b);
  (provider === "tmdb" ? f.tmdb : f.tvdb)[b].fail = true;
  f.at(day(41)); const show = await f.run();
  assert.equal(f.selection()[provider].current?.state,"saved-unavailable");
  return show;
}
type Member = {provider:"TMDB"|"TVDB";id:number;showId:number;show:string;title:string;season:number;episode:number;url:string};
const member = (provider: "TMDB" | "TVDB", showId: number, id: number): Member => ({provider,id,showId,show:`${provider} ${showId}`,title:"Episode 1",season:1,episode:1,url:""});
async function offlineRecheck(f: Awaited<ReturnType<typeof fixture>>, at: string, members: readonly Member[]) {
  f.at(at); f.requests.length = 0;
  await plexScan.requestCoverageRecheck({members:[...members]});
  assert.deepEqual(f.requests,[],"an offline recheck makes no HTTP or Plex request");
  return (await (await scan.GET()).json()).report.shows.find((show: Show) => show.ratingKey === f.identity) as Show;
}

for (const [provider,a,b,members] of [["tmdb",10,11,[member("TMDB",11,1101),member("TMDB",10,1001)]],["tvdb",1,3,[member("TVDB",3,3001),member("TVDB",1,1001)]]] as const) {
  test(`an offline recheck applies the 60-day limit to the ${provider.toUpperCase()} catalogue in use, then falls back to saved A`, async t => {
    const f = await fixture(t);
    f.setSecond({tmdb:12,tvdb:2});
    await savedBWithYoungA(f,provider,a,b);
    const other = (await (await scan.GET()).json()).report.shows.find((show: Show) => show.ratingKey === "ratingKey:2");
    const id = (show: Show) => provider === "tmdb" ? show.tmdbId : show.tvdbId;
    const label = provider.toUpperCase();
    const downloaded = Date.parse(day(2));
    for (const [offset,when] of [[-1,"just before"],[0,"exactly at"]] as const) {
      const show = await offlineRecheck(f,new Date(downloaded + 60 * DAY + offset).toISOString(),members);
      assert.equal(id(show),b,`saved B is compared ${when} 60 days`);
      assert.equal(f.selection()[provider].current?.state,"saved-unavailable");
    }
    f.restart();
    let show = await offlineRecheck(f,new Date(downloaded + 60 * DAY + 1).toISOString(),members);
    assert.equal(id(show),a,"saved A is compared once saved B is older than 60 days");
    if (provider === "tmdb") assert.deepEqual(missingTmdb(show),[1002]);
    let current = f.selection()[provider].current!;
    assert.deepEqual({state:current.state,usingId:current.usingId,preferredId:current.preferredId,preferredDownloadedAt:current.preferredDownloadedAt,preferredFailedAt:current.preferredFailedAt,usingDownloadedAt:current.usingDownloadedAt},
      {state:"fallback",usingId:a,preferredId:b,preferredDownloadedAt:day(2),preferredFailedAt:day(41),usingDownloadedAt:day(40)});
    assert.equal(f.selection()[provider].override,b,"the preference is kept");
    let issues = await f.issues();
    assert.ok(issues.some(issue=>issue.id === `catalogue-refresh:${label}:${f.identity}`),"B's failure is preserved");
    assert.ok(!issues.some(issue=>issue.id === `comparison-inputs:${f.identity}`));
    const saved = catalogues.readPlexInputs();
    assert.equal(saved.comparisons[f.identity].refresh?.[provider],true,"the refresh obligation is retained");
    assert.deepEqual([saved[provider][String(b)].downloadedAt,saved[provider][String(a)].downloadedAt],[day(2),day(40)],"no download time is renewed");

    // Deliberately changed (SHELFCHECK-120, ADR-0006): once A is expired too, the most recently saved catalogue that is not gone (A) is still compared; only gone copies leave the recheck pending.
    const bothExpired = new Date(Date.parse(day(40)) + 60 * DAY + 1).toISOString();
    show = await offlineRecheck(f,bothExpired,members);
    assert.equal(id(show),a,"saved A, the newest catalogue that is not gone, is compared once it is expired too");
    assert.ok(!(await f.issues()).some(issue=>issue.id === `comparison-inputs:${f.identity}`),"the recheck compared");
    for (const series of [a,b]) for (let n = 0; n < 15; n++) seriesNotFoundHistory().recordNotFound(provider,series,day(41 + n));
    show = await offlineRecheck(f,bothExpired,members);
    assert.equal(id(show),a,"last-good results are kept once every candidate is gone");
    issues = await f.issues();
    const pending = issues.find(issue=>issue.id === `comparison-inputs:${f.identity}`) as {cause?:string} | undefined;
    assert.match(pending?.cause || "",new RegExp(`No reported ${label} series has a saved catalogue from the last 60 days`));
    current = f.selection()[provider].current!;
    assert.equal(current.usingDownloadedAt,day(40),"the last comparison's selection is unchanged");
    assert.deepEqual((await (await scan.GET()).json()).report.shows.find((entry: Show) => entry.ratingKey === "ratingKey:2"),other,"an unrelated show is untouched");
  });
}

test("an offline recheck that falls back re-derives TVDB from the TMDB catalogue actually compared", async t => {
  const f = await fixture(t);
  f.plex.tvdb = []; f.tmdb[10].tvdb = null; f.tmdb[11].tvdb = 3;
  await savedBWithYoungA(f,"tmdb",10,11);
  assert.equal(f.selection().tvdb.current?.usingId,3,"saved B supplies the derived TVDB series");
  const show = await offlineRecheck(f,new Date(Date.parse(day(2)) + 60 * DAY + 1).toISOString(),[member("TMDB",11,1101),member("TMDB",10,1001)]);
  assert.equal(show.tmdbId,10);
  assert.equal(show.tvdbId,undefined,"A has no TVDB link, so B's derived ID is not kept");
  assert.equal(f.selection().tvdb.current,undefined);
});

test("the TVDB catalogue in use for a provider with several IDs is downloaded again once older than 20 days", async t => {
  const f = await fixture(t);
  f.plex.tvdb = [1,3]; f.setSecond({tmdb:12,tvdb:2});
  const downloaded = Date.parse(day(1));
  await f.run();
  selections.saveCatalogueOverride(f.identity,"tvdb",3); await f.run();
  selections.saveCatalogueOverride(f.identity,"tvdb",null);
  const show = await f.run();
  assert.equal(show.tvdbId,1,"A is in use; B is a saved but unused candidate");
  for (const days of [7,14]) { f.at(new Date(downloaded + days * DAY).toISOString()); await f.run(); }
  const downloads = () => [f.tvdbDownloads(1),f.tvdbDownloads(3),f.tvdbDownloads(2),f.tmdbDownloads(10),f.tmdbDownloads(12)];
  for (const [offset,label] of [[-1,"just before"],[0,"exactly at"]] as const) {
    f.at(new Date(downloaded + 20 * DAY + offset).toISOString());
    await f.run();
    assert.deepEqual(downloads(),[0,0,0,0,0],`nothing is downloaded ${label} 20 days`);
  }
  f.at(new Date(downloaded + 20 * DAY + 1).toISOString());
  await f.run();
  assert.deepEqual(downloads(),[1,0,0,0,0],"only the multiple-ID provider's TVDB catalogue in use is refreshed after 20 days");
  assert.equal(f.selection().tvdb.current?.usingDownloadedAt,new Date(downloaded + 20 * DAY + 1).toISOString());
  assert.equal(f.selection().tmdb.current?.usingDownloadedAt,day(1),"TMDB of the same show keeps its own rules");
});

// SHELFCHECK-27 (ADR-0006): each provider is judged separately, and one provider's failure never blocks the other's comparison.
type Judged = Show & {providerResolution?: {status?: string; providers?: Record<"tmdb"|"tvdb",{state:string;catalogue?:string;cause?:string}>}};
const unmatchedKeys = () => reportData.getReportData().unmatchedShows.map(show=>show.ratingKey);

test("a show whose TMDB record 404s and whose TVDB catalogue works leaves Unmatched Shows, is compared with TVDB and is Partially matched with a TMDB Scan Issue", async t => {
  const f = await fixture(t);
  f.tmdb[10].fail = true; f.tvdb[1].fail = true; f.tvdb[1].episodes = 2;
  let show = await f.run() as Judged;
  assert.deepEqual(unmatchedKeys(),[f.identity],"both providers failing with no saved data is Unmatched");
  assert.equal(show.providerResolution?.status,"unmatched");
  assert.deepEqual(show.providerResolution?.providers,{
    tmdb:{state:"total-failure",catalogue:"none",cause:"404 — record not found"},
    tvdb:{state:"total-failure",catalogue:"none",cause:"404 — record not found"},
  },"the row gives each provider's cause");

  f.tvdb[1].fail = false;
  f.at(day(2)); show = await f.run() as Judged;
  assert.deepEqual(unmatchedKeys(),[],"the show leaves Unmatched Shows once TVDB downloads");
  assert.equal(show.providerResolution?.status,"partially-matched");
  assert.deepEqual(show.providerResolution?.providers?.tvdb,{state:"working"});
  assert.equal(show.providerResolution?.providers?.tmdb?.state,"total-failure");
  assert.equal(show.missing.length,1,"TVDB's missing episode is reported");
  const issues = await f.issues();
  assert.ok(issues.some(issue=>issue.id === `catalogue-refresh:TMDB:${f.identity}`),"TMDB keeps its Scan Issues entry");
  assert.ok(!issues.some(issue=>issue.id === `comparison-inputs:${f.identity}`),"the comparison ran");
});

for (const failing of ["TMDB","TVDB"] as const) test(`a Partially matched show's comparison is complete for a Manual Match cached recheck, while ${failing} is still retried and keeps its Scan Issue`, async t => {
  const f = await fixture(t);
  if (failing === "TMDB") { f.tmdb[10].fail = true; f.tvdb[1].episodes = 2; } else f.tvdb[1].fail = true;
  let show = await f.run() as Judged;
  assert.equal(show.providerResolution?.status,"partially-matched");
  assert.equal(show.missing.length,1,"the working provider's missing episode is reported");
  assert.equal(catalogues.readPlexInputs().comparisons[f.identity]?.complete,true,"a comparison made from every usable catalogue is complete");

  const member = failing === "TMDB" ? {provider:"TVDB" as const,id:1002,showId:1,show:"TVDB 1"} : {provider:"TMDB" as const,id:1002,showId:10,show:"TMDB 10"};
  await plexScan.requestCoverageRecheck({members:[{...member,title:"Episode 2",season:1,episode:2,url:""}]});
  show = (await (await scan.GET()).json()).report.shows[0] as Judged;
  const refreshIssue = `catalogue-refresh:${failing}:${f.identity}`;
  const recheckIssues = await f.issues() as {id:string;cause?:string}[];
  assert.equal(recheckIssues.find(issue=>issue.id === `comparison-inputs:${f.identity}`)?.cause,undefined,"the cached recheck compares the saved inputs");
  assert.equal(show.missing.length,1);
  assert.equal(show.providerResolution?.status,"partially-matched","the recheck keeps each provider's status");
  assert.ok(recheckIssues.some(issue=>issue.id === refreshIssue),`${failing} keeps its Scan Issue`);

  f.at(day(2)); show = await f.run() as Judged;
  assert.ok(f.requests.includes(failing === "TMDB" ? "/3/tv/10" : "/v4/series/1"),`the next scan retries ${failing}`);
  assert.ok((await f.issues()).some(issue=>issue.id === refreshIssue));
});

test("an Unmatched show's own entries are hidden from Scan Issues while a TVDB sign-in failure it shares with a Partially matched show stays visible with both impacts", async t => {
  const f = await fixture(t);
  f.setSecond({tmdb:12,tvdb:2});
  f.tmdb[10].fail = true; f.failTvdbLogin(true);
  await f.run();
  const unmatched = f.identity;
  assert.deepEqual(unmatchedKeys(),[unmatched],"Scooby has no usable catalogue; Other compares TMDB");
  assert.ok((await f.issues()).some(issue=>issue.id === `catalogue-refresh:TMDB:${unmatched}`),"hiding deletes no Coverage Issue");

  const { issues, counts } = reportData.getReportData();
  const shown = issues.map(issue=>issue.id);
  for (const id of shown) assert.ok(!id.endsWith(`:${unmatched}`),`${id} is the Unmatched show's own entry`);
  const signIn = issues.find(issue=>issue.id === "provider-authentication:TVDB");
  assert.ok(signIn,"the shared sign-in failure stays visible");
  assert.ok(signIn.impacts?.some(impact=>impact.startsWith("Scooby: ")),"with the Unmatched show's impact");
  assert.ok(signIn.impacts?.some(impact=>impact.startsWith("Other: ")),"and the Partially matched show's impact");
  assert.equal(counts.issueCount,issues.length,"the Scan Issues count matches what is shown");
});

test("a scan never republishes an earlier result's provider status", async t => {
  const f = await fixture(t);
  let show = await f.run() as Judged;
  assert.equal(show.providerResolution?.status,"matched");
  f.tmdb[10].fail = true; f.changes([10]);
  f.at(day(2)); show = await f.run() as Judged;
  assert.equal(show.providerResolution?.status,"partially-matched","TMDB compares its saved catalogue after a failed attempt");
  assert.deepEqual(show.providerResolution?.providers?.tmdb,{state:"total-failure",catalogue:"saved",cause:"404 — record not found"});
  f.tmdb[10].fail = false;
  f.at(day(3)); show = await f.run() as Judged;
  assert.equal(show.providerResolution?.status,"matched");
});

test("a show with only a Plex TMDB ID whose TVDB catalogue loads through TMDB's external IDs is not a TVDB failure", async t => {
  const f = await fixture(t);
  f.plex.tvdb = [];
  const show = await f.run() as Judged;
  assert.deepEqual(show.providerResolution?.providers?.tvdb,{state:"working"});
  assert.equal(show.providerResolution?.status,"matched");
});

test("a show with only a TMDB ID that fails with no saved data, and no TVDB found, is Unmatched", async t => {
  const f = await fixture(t);
  f.plex.tvdb = []; f.tmdb[10].fail = true;
  const show = await f.run() as Judged;
  assert.equal(show.providerResolution?.status,"unmatched");
  // TVDB was never asked: its ID could only come from the TMDB catalogue, so it is not counted as failing.
  assert.deepEqual(show.providerResolution?.providers?.tvdb,{state:"not-looked-up",cause:"Not looked up: the TMDB catalogue, which names the TVDB series, could not be loaded"});
  assert.ok(!(await f.issues()).some(issue=>issue.id === `catalogue-refresh:TVDB:${f.identity}`),"no missing-ID Scan Issue for TVDB");
  assert.deepEqual(unmatchedKeys(),[f.identity]);
});

test("a show with only a Plex TMDB ID and no TVDB found through TMDB is Partially matched, with one TVDB Scan Issues entry", async t => {
  const f = await fixture(t);
  f.plex.tvdb = []; f.tmdb[10].tvdb = null;
  const show = await f.run() as Judged;
  assert.deepEqual(missingTmdb(show),[1002],"TMDB is compared");
  assert.equal(show.providerResolution?.status,"partially-matched");
  assert.deepEqual(show.providerResolution?.providers?.tvdb,{state:"total-failure",catalogue:"none",cause:"No TVDB series ID from Plex or TMDB"});
  assert.equal(show.warning,undefined,"a missing ID adds no result warning");
  const entries = (await f.issues() as {id:string;show?:{ratingKey?:string}}[]).filter(issue=>issue.show?.ratingKey === f.identity);
  assert.deepEqual(entries.map(issue=>issue.id),[`catalogue-refresh:TVDB:${f.identity}`]);
  assert.deepEqual(unmatchedKeys(),[]);
});

test("a TMDB record gone after 15 counted 404 days and 60 days stops being compared in scans and cached rechecks, keeps its Manual Match, and one download restores it", async t => {
  const f = await fixture(t);
  let show = await f.run() as Judged;
  assert.deepEqual(missingTmdb(show),[1002]);
  const member = (provider: "TMDB"|"TVDB", id: number, showId: number, episode: number) => ({provider,id,showId,show:`${provider} ${showId}`,title:`Episode ${episode}`,season:1,episode,url:""});
  manualCoverage.saveCoverageMapping([member("TMDB",1002,10,2),member("TVDB",3001,3,1)]);
  // 14 earlier 404 days on TMDB series 10's series request.
  for (let n = 40; n < 54; n++) seriesNotFoundHistory().recordNotFound("tmdb",10,day(n));
  const recheck = async () => {
    await plexScan.requestCoverageRecheck({members:[{provider:"TVDB",id:1001,showId:1,show:"TVDB 1",title:"Episode 1",season:1,episode:1,url:""}]});
    return (await (await scan.GET()).json()).report.shows[0] as Judged;
  };
  f.tmdb[10].fail = true; f.changes([10]);

  f.at(day(61)); show = await f.run() as Judged;
  assert.equal(seriesNotFoundHistory().countedDays("tmdb",10),15);
  assert.deepEqual(show.providerResolution?.providers?.tmdb,{state:"total-failure",catalogue:"saved",cause:"404 — record not found"},"15 days with a catalogue exactly 60 days old is not gone");
  assert.deepEqual(missingTmdb(show),[1002]);

  f.at(day(62)); show = await recheck();
  assert.deepEqual(missingTmdb(show),[1002],"a copy gone since the last scan is not compared: last-good results stay until the next scan");
  assert.equal(seriesNotFoundHistory().countedDays("tmdb",10),15,"a cached recheck never counts");

  show = await f.run() as Judged;
  assert.deepEqual(missingTmdb(show),[],"the gone catalogue is not compared");
  assert.equal(show.missing.length,0,"TVDB is still compared");
  assert.deepEqual(show.providerResolution?.providers?.tmdb,{state:"total-failure",catalogue:"gone",cause:"404 — record not found"});
  assert.equal(show.providerResolution?.status,"partially-matched");
  const issue = (await f.issues() as {id:string;catalogueRefresh?:object}[]).find(item=>item.id === `catalogue-refresh:TMDB:${f.identity}`);
  assert.deepEqual(issue?.catalogueRefresh,{checkedAt:day(62),downloadedAt:day(1),seriesNotFoundDays:16,gone:true});
  assert.ok(catalogues.readPlexInputs().tmdb["10"],"the saved catalogue is kept");

  f.at(day(63)); show = await recheck();
  assert.deepEqual(missingTmdb(show),[],"a cached recheck never compares a gone record");
  assert.equal(show.providerResolution?.providers?.tmdb?.catalogue,"gone");
  assert.equal(manualCoverage.listCoverageMappings().length,1,"the Manual Match on the gone record stays saved");

  f.tmdb[10].fail = false;
  f.at(day(64)); show = await f.run() as Judged;
  assert.deepEqual(missingTmdb(show),[1002],"one complete download makes it usable again");
  assert.equal(show.providerResolution?.status,"matched");
  assert.equal(seriesNotFoundHistory().countedDays("tmdb",10),0);
});

// A cached recheck never changes a show's status by itself: a shared catalogue another show downloads
// after the last scan recorded this show's provider with no catalogue, or gone, waits for the next scan.
for (const recorded of ["none","gone"] as const) test(`a Manual Match cached recheck keeps an Unmatched show Unmatched when another show downloads a shared TMDB candidate the last scan recorded as ${recorded}`, async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11]; f.tvdb[1].fail = true;
  // Series 10 is saved on day 1 (and series 11 too for gone), then 404s for 15 counted days until its copy is more than 60 days old.
  // Gone with a never-downloaded candidate beside it is no catalogue; every candidate gone is gone.
  await f.run();
  if (recorded === "gone") { selections.saveCatalogueOverride(f.identity,"tmdb",11); await f.run(); selections.saveCatalogueOverride(f.identity,"tmdb",null); }
  for (const id of recorded === "gone" ? [10,11] : [10]) for (let n = 40; n < 54; n++) seriesNotFoundHistory().recordNotFound("tmdb",id,day(n));
  f.tmdb[10].fail = true; f.tmdb[11].fail = true; f.changes([10,11]);
  f.at(day(62));
  let show = await f.run() as Judged;
  assert.equal(show.providerResolution?.status,"unmatched");
  assert.equal(show.providerResolution?.providers?.tmdb?.catalogue,recorded);

  // Another show with TMDB series 11 downloads it in the next scan; Scooby asks for series 11 first and still gets a 404.
  f.at(day(63)); f.setSecond({tmdb:11,tvdb:2});
  Object.defineProperty(f.tmdb[11],"fail",{get: () => f.requests.filter(p=>p === "/3/tv/11").length < 2,configurable:true});
  show = await f.run() as Judged;
  assert.equal(show.providerResolution?.status,"unmatched","Scooby's scan judged TMDB before Other downloaded series 11");
  assert.equal(show.providerResolution?.providers?.tmdb?.catalogue,recorded);
  assert.equal(catalogues.readPlexInputs().tmdb["11"]?.downloadedAt,day(63),"the shared catalogue is saved");
  const lastGood = show.missing;

  await plexScan.requestCoverageRecheck({members:[{provider:"TVDB",id:1001,showId:1,show:"TVDB 1",title:"Episode 1",season:1,episode:1,url:""}]});
  show = (await (await scan.GET()).json()).report.shows.find((item: Show) => item.ratingKey === f.identity) as Judged;
  const inputs = (await f.issues() as {id:string;cause?:string}[]).find(issue=>issue.id === `comparison-inputs:${f.identity}`);
  assert.match(inputs?.cause || "",/^No provider has a usable saved catalogue/,"the recheck compares neither provider and keeps last-good results");
  assert.deepEqual(show.missing,lastGood,"the shared catalogue is not compared until the next scan");
  assert.equal(show.providerResolution?.status,"unmatched","the recheck never changes the show's status by itself");
  assert.equal(show.providerResolution?.providers?.tmdb?.catalogue,recorded);
});
