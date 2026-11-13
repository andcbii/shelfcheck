import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const scan = await import("../app/api/plex/scan/route");
const sqlite = await import("../lib/sqlite");
const config = await import("../lib/server-config");
hook.deregister();

type Issue = {id:string;provider?:string;operation:string;show?:{ratingKey:string}};
const day = (n: number, time = "12:00:00") => new Date(Date.parse(`2026-11-01T${time}Z`) + n * 86400_000).toISOString();
const date = (n: number) => day(n).slice(0, 10);
const tvdbSince = (iso: string) => String(Math.floor(Date.parse(iso) / 1000) - 60);

// Three shows: TMDB 10/30/50 pair with TVDB 20/40/60. Each owns its single pilot by default.
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"provider-isolation-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  const restart = () => {global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;};
  t.after(() => { restart();
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  sqlite.writePlexSettings({diagnosticsEnabled:false});
  t.mock.timers.enable({apis:["Date"],now:new Date(day(0))});
  const state = {
    tmdbFeedFailure:false, tvdbFeedFailure:false,
    tmdbChanges:[] as {id:number;date:string}[], tvdbChanges:[] as {id:number;at:string}[],
    failedTmdb:new Set<number>(), failedTvdb:new Set<number>(), failedInventory:new Set<string>(),
    owned:new Set([10,30,50]),
    // Season downloads that wait until released, to interrupt a scan mid-library.
    heldTmdb:new Map<number,()=>void>(),
    // Shows whose owned pilot Plex numbers S1E2 with TMDB and IMDb GUIDs only, so its TVDB pilot needs an identity lookup.
    misnumberedInventory:new Set<number>(),
    findEpisodes:new Map<number,{id:number;show_id:number;season_number:number;episode_number:number}[]>(),
    tvdbEpisodeImdbIds:new Map<number,string[]>(),
  };
  const requests: URL[] = [];
  const shows = [10,30,50].map(id=>({ratingKey:String(id),title:`Show ${id}`,Guid:[{id:`tmdb://${id}`},{id:`tvdb://${id+10}`}],updatedAt:1}));
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u);
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname === "/library/sections/1/all") return Response.json({MediaContainer:{Metadata:shows}});
      const leaves = u.pathname.match(/^\/library\/metadata\/(\d+)\/allLeaves$/);
      if(leaves && state.failedInventory.has(leaves[1])) return Response.json({},{status:404});
      const id = Number(leaves?.[1]);
      if(leaves) return Response.json({MediaContainer:{Metadata:state.owned.has(id) ? [{ratingKey:`ep${id}`,parentIndex:1,index:state.misnumberedInventory.has(id) ? 2 : 1,Guid:[{id:`tmdb://${id*10}`},...(state.misnumberedInventory.has(id) ? [{id:`imdb://tt${id}`}] : [{id:`tvdb://${(id+10)*10}`}])]}] : []}});
      return Response.json({MediaContainer:{Metadata:[shows.find(s=>u.pathname === `/library/metadata/${s.ratingKey}`)]}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") {
      if(state.tmdbFeedFailure) return Response.json({},{status:401});
      const start = u.searchParams.get("start_date")!, end = u.searchParams.get("end_date")!;
      return Response.json({results:state.tmdbChanges.filter(c=>c.date >= start && c.date <= end).map(c=>({id:c.id})),total_pages:1});
    }
    if(u.pathname === "/v4/updates") {
      if(state.tvdbFeedFailure) return Response.json({},{status:401});
      const since = Number(u.searchParams.get("since"));
      return Response.json({data:state.tvdbChanges.filter(c=>Date.parse(c.at) / 1000 >= since).map(c=>({entityType:"series",recordId:c.id}))});
    }
    const tmdb = u.pathname.match(/^\/3\/tv\/(\d+)(\/season\/1)?$/);
    if(tmdb && tmdb[2] && state.heldTmdb.has(Number(tmdb[1]))) { await new Promise<void>(release=>state.heldTmdb.set(Number(tmdb[1]),release)); return Response.json({},{status:404}); }
    if(tmdb && tmdb[2] && state.failedTmdb.has(Number(tmdb[1]))) return Response.json({},{status:404});
    if(tmdb && tmdb[2]) return Response.json({episodes:[{id:Number(tmdb[1])*10,season_number:1,episode_number:1,name:"Pilot",air_date:"2020-01-01"}]});
    if(tmdb) return Response.json({id:Number(tmdb[1]),name:`Show ${tmdb[1]}`,seasons:[{season_number:1}],external_ids:{tvdb_id:Number(tmdb[1])+10}});
    const tvdb = u.pathname.match(/^\/v4\/series\/(\d+)(\/episodes\/default)?$/);
    if(tvdb && tvdb[2] && state.failedTvdb.has(Number(tvdb[1]))) return Response.json({},{status:404});
    if(tvdb && tvdb[2]) return Response.json({data:{episodes:[{id:Number(tvdb[1])*10,seasonNumber:1,number:1,name:"Pilot",aired:"2020-01-01"}]}});
    if(tvdb) return Response.json({data:{id:Number(tvdb[1]),name:`Show ${Number(tvdb[1])-10}`,slug:`show-${tvdb[1]}`}});
    const extended = u.pathname.match(/^\/v4\/episodes\/(\d+)\/extended$/);
    if(extended) return Response.json({data:{remoteIds:(state.tvdbEpisodeImdbIds.get(Number(extended[1])) || []).map(id=>({id}))}});
    const find = u.pathname.match(/\/find\/(\d+)$/);
    if(find) return Response.json({tv_results:[],tv_episode_results:state.findEpisodes.get(Number(find[1])) || []});
    throw new Error("Unexpected HTTP: "+u);
  });
  const run = async (ratingKey?: string) => {
    requests.length = 0;
    await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:JSON.stringify({ratingKey})}));
    for(let i=0;i<500;i++) { const result = await (await scan.GET()).json(); if(result.scan.status !== "running") { assert.equal(result.scan.status,"completed",result.scan.error); return result; } await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out");
  };
  const downloads = () => requests.filter(u=>/\/season\/\d+$/.test(u.pathname) || u.pathname.endsWith("/episodes/default")).map(u=>u.pathname).sort();
  const feed = (provider: "TMDB" | "TVDB") => {
    const request = requests.find(u=>u.pathname === (provider === "TMDB" ? "/3/tv/changes" : "/v4/updates"));
    return provider === "TMDB" ? request?.searchParams.get("start_date") : request?.searchParams.get("since");
  };
  const at = (n: number, time?: string) => t.mock.timers.setTime(Date.parse(day(n, time)));
  // Rewrite bookkeeping into the pre-isolation layout: one clean-scan baseline row, or none.
  // Saved provider catalogues and their successful-download timestamps are kept.
  const legacy = (startedAt?: string) => {
    global.__shelfcheckDatabase!.exec("DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key IN ('full-scan','completed-full-scan','provider-verification','pending-tvdb')");
    if (startedAt) sqlite.writePlexGeneratedInputs("full-scan",{startedAt,successfulFullScans:{utcDate:startedAt.slice(0,10),count:1}});
    restart();
  };
  return {state,requests,run,downloads,feed,at,restart,legacy};
}

const missing = (result: {report:{shows:{title:string;missing:unknown[]}[]}}, id: number) => result.report.shows.find(s=>s.title === `Show ${id}`)!.missing.length;

test("a persistent isolated TVDB failure lets each provider verify and reuse catalogues day after day", async t => {
  const f = await fixture(t);
  f.state.failedTvdb.add(40);
  await f.run();
  for (let n = 1; n <= 16; n++) {
    f.at(n);
    if (n === 3) f.state.owned.delete(50);
    const result = await f.run();
    assert.deepEqual(f.downloads(),["/v4/series/40/episodes/default"],`day ${n}: only the failed TVDB catalogue is retried`);
    assert.equal(f.feed("TMDB"),date(n-1),`day ${n}: TMDB verifies from its previous position, not the last clean scan`);
    assert.equal(f.feed("TVDB"),tvdbSince(day(n-1)),`day ${n}: TVDB verifies from its previous position`);
    assert.ok(f.requests.some(u=>u.pathname === "/library/metadata/50/allLeaves"),"full scans still read current inventory");
    assert.equal(missing(result,50),n >= 3 ? 1 : 0,"current ownership is compared against reused catalogues");
    assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "catalogue-refresh:TVDB:ratingKey:30"),"the isolated failure stays visible");
    assert.ok(!result.coverage.issues.some((issue:Issue)=>issue.operation === "provider-verification"),"both providers verified their change feeds");
  }
});

test("a failed change feed keeps its own missed interval while the other provider advances", async t => {
  const f = await fixture(t);
  await f.run();
  f.at(1);
  f.state.tmdbFeedFailure = true;
  f.state.tmdbChanges.push({id:30,date:date(1)});
  f.state.tvdbChanges.push({id:20,at:day(1,"08:00:00")});
  let result = await f.run();
  assert.deepEqual(f.downloads(),["/v4/series/20/episodes/default"],"TVDB verifies independently while TMDB reuses last-good data");
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TMDB"),"TMDB freshness is visibly unverified");
  f.restart();
  f.at(2);
  f.state.tmdbFeedFailure = false;
  result = await f.run();
  assert.equal(f.feed("TMDB"),date(0),"TMDB retries its whole missed interval");
  assert.equal(f.feed("TVDB"),tvdbSince(day(1)),"TVDB advanced despite the TMDB failure");
  assert.deepEqual(f.downloads(),["/3/tv/30/season/1"],"the missed TMDB change is refreshed and the handled TVDB change is not repeated");
  assert.deepEqual(result.coverage.issues,[]);
  f.at(3);
  f.state.tvdbFeedFailure = true;
  f.state.tvdbChanges.push({id:60,at:day(3,"08:00:00")});
  result = await f.run();
  assert.deepEqual(f.downloads(),[]);
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TVDB"));
  assert.ok(!result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TMDB"));
  f.restart();
  f.at(4);
  f.state.tvdbFeedFailure = false;
  result = await f.run();
  assert.equal(f.feed("TVDB"),tvdbSince(day(2)),"TVDB retries its whole missed interval");
  assert.equal(f.feed("TMDB"),date(3),"TMDB advanced despite the TVDB failure");
  assert.deepEqual(f.downloads(),["/v4/series/60/episodes/default"]);
  assert.deepEqual(result.coverage.issues,[]);
});

test("pre-isolation databases keep valid verification history without fabricating absent history", async t => {
  const f = await fixture(t);
  await f.run();
  const legacy = f.legacy;
  legacy(day(0));
  f.at(1);
  f.state.tvdbChanges.push({id:20,at:day(0,"18:00:00")});
  await f.run();
  assert.equal(f.feed("TMDB"),date(0),"the legacy baseline seeds TMDB verification");
  assert.equal(f.feed("TVDB"),tvdbSince(day(0)),"the legacy baseline seeds TVDB verification");
  assert.deepEqual(f.downloads(),["/v4/series/20/episodes/default"]);
  legacy();
  f.at(2);
  await f.run();
  assert.equal(f.feed("TMDB"),date(0),"absent TMDB history is recovered from its catalogues' own successful downloads, not fabricated");
  assert.equal(f.feed("TVDB"),tvdbSince(day(0)),"absent TVDB history is verified from its catalogues' own successful downloads, not fabricated");
  // The update feed is checked from the earliest catalogue download, so the already-handled day 0 change
  // reappears and is conservatively rechecked once; no other catalogue is downloaded.
  assert.deepEqual(f.downloads(),["/v4/series/20/episodes/default"],"usable catalogues downloaded before the fix stay reusable");
  f.at(2,"13:00:00");
  await f.run();
  assert.equal(f.feed("TMDB"),date(2));
  assert.equal(f.feed("TVDB"),tvdbSince(day(2)));
  assert.deepEqual(f.downloads(),[]);
});

test("identified changes stay due after verification advances, an empty later feed and restart", async t => {
  const f = await fixture(t);
  await f.run();
  // Incomplete inventory blocks every comparison, so the identified change cannot be handled yet.
  f.at(1);
  f.state.failedInventory.add("30");
  f.state.tvdbChanges.push({id:40,at:day(1,"08:00:00")});
  let result = await f.run();
  assert.deepEqual(f.downloads(),[]);
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.operation === "inventory"));
  f.restart();
  f.at(2);
  f.state.failedInventory.clear();
  f.state.tmdbChanges.push({id:10,date:date(2)});
  f.state.tvdbChanges.push({id:60,at:day(2,"08:00:00")});
  f.state.failedTmdb.add(10);
  f.state.failedTvdb.add(60);
  result = await f.run();
  assert.equal(f.feed("TVDB"),tvdbSince(day(1)),"verification advanced past the unhandled change");
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1","/v4/series/40/episodes/default","/v4/series/60/episodes/default"],"the retained change is handled although the feed no longer reports it");
  assert.equal(missing(result,10),0,"last-good TMDB results remain available");
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "catalogue-refresh:TMDB:ratingKey:10"));
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "catalogue-refresh:TVDB:ratingKey:50"));
  f.restart();
  f.at(3);
  f.state.tmdbChanges.length = 0;
  f.state.tvdbChanges.length = 0;
  f.state.failedTmdb.clear();
  f.state.failedTvdb.clear();
  result = await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1","/v4/series/60/episodes/default"],"failed changed-show downloads retry after an empty feed without repeating successful peers");
  assert.deepEqual(result.coverage.issues,[]);
  f.at(3,"13:00:00");
  await f.run();
  assert.deepEqual(f.downloads(),[],"successful retries consume only their own obligations");
});

const tmdbCatalogueRequests = (f: {requests: URL[]}) => f.requests.filter(u=>/^\/3\/tv\/\d+(\/season\/\d+)?$/.test(u.pathname)).map(u=>u.pathname).sort();

test("upgrading with today's catalogues and no verification history reuses them while a persistent TVDB 404 retries", async t => {
  const f = await fixture(t);
  f.state.failedTvdb.add(40);
  await f.run();
  // The observed upgrade state: usable catalogues downloaded today, but no saved scan baseline.
  f.legacy();
  for (const time of ["12:10:00","12:20:00"]) {
    f.at(0,time);
    f.restart();
    const result = await f.run();
    assert.deepEqual(tmdbCatalogueRequests(f),[],`${time}: successful TMDB show and season catalogues are not downloaded again`);
    assert.deepEqual(f.downloads(),["/v4/series/40/episodes/default"],`${time}: the failed TVDB lookup is retried`);
    assert.equal(f.feed("TMDB"),date(0),`${time}: TMDB verifies changes since its catalogues were downloaded`);
    assert.ok(f.requests.some(u=>u.pathname === "/library/metadata/50/allLeaves"),"full scans still read current inventory");
    assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "catalogue-refresh:TVDB:ratingKey:30"),"the isolated failure stays visible");
    assert.ok(!result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TMDB"),"the TMDB gap is covered by its change feed");
  }
});

test("absent TMDB history uses available feed history and stays visibly unverified while the feed fails", async t => {
  const f = await fixture(t);
  await f.run();
  f.legacy();
  f.at(1);
  f.state.tmdbChanges.push({id:30,date:date(1)});
  f.state.tmdbFeedFailure = true;
  let result = await f.run();
  assert.deepEqual(f.downloads(),[],"last-good catalogues are kept while the feed is unavailable, and TVDB is not forced");
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TMDB"),"TMDB freshness is visibly unverified");
  f.restart();
  f.at(2);
  f.state.tmdbFeedFailure = false;
  result = await f.run();
  assert.equal(f.feed("TMDB"),date(0),"the failed attempt did not fabricate a verification position");
  assert.deepEqual(f.downloads(),["/3/tv/30/season/1"],"only the change found in the available history is refreshed");
  assert.ok(!result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TMDB"));
});

test("out-of-window TMDB history recovers only uncovered catalogues and keeps successful recovery downloads", async t => {
  const f = await fixture(t);
  await f.run();
  f.at(15);
  await f.run("ratingKey:10");
  f.at(15,"13:00:00");
  f.state.failedTmdb.add(50);
  let result = await f.run();
  assert.equal(f.feed("TMDB"),date(15),"the feed verifies the catalogue downloaded within its window");
  assert.equal(f.feed("TVDB"),tvdbSince(day(0)),"TVDB keeps verifying from its own position");
  assert.deepEqual(f.downloads(),["/3/tv/30/season/1","/3/tv/50/season/1"],"the targeted check advanced no position; only uncovered TMDB catalogues are refreshed and TVDB is not forced");
  assert.equal(missing(result,50),0,"last-good results survive the failed recovery download");
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "catalogue-refresh:TMDB:ratingKey:50"),"the failed recovery download stays visible");
  assert.ok(!result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TMDB"),"the remaining recovery work is durably retained");
  for (const [n,from] of [[16,15],[29,16]]) {
    f.restart();
    f.at(n);
    result = await f.run();
    assert.equal(f.feed("TMDB"),date(from),`day ${n}: verification advanced past the retained recovery work`);
    assert.deepEqual(f.downloads(),["/3/tv/50/season/1"],`day ${n}: only the permanently failing show retries; successful recovery downloads are not repeated`);
    assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "catalogue-refresh:TMDB:ratingKey:50"));
  }
  f.state.failedTmdb.clear();
  f.at(29,"13:00:00");
  await f.run();
  f.at(29,"14:00:00");
  result = await f.run();
  assert.deepEqual(f.downloads(),[],"a successful retry fulfils the last recovery obligation");
  assert.deepEqual(result.coverage.issues,[]);
});

test("interrupted TMDB verification recovery resumes after restart without repeating its successful downloads", async t => {
  const f = await fixture(t);
  await f.run();
  f.at(20);
  f.state.heldTmdb.set(50,()=>{});
  f.requests.length = 0;
  await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
  for (let i=0; i<500 && (await (await scan.GET()).json()).scan.processed < 2; i++) await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1","/3/tv/30/season/1","/3/tv/50/season/1"],"recovery started for every uncovered catalogue");
  // Simulate a process restart while the scan is stuck on its last show.
  const global = globalThis as typeof globalThis & {__shelfcheckPlexScan?: Promise<void>};
  const interrupted = global.__shelfcheckPlexScan!;
  delete global.__shelfcheckPlexScan;
  const release = f.state.heldTmdb.get(50)!;
  f.state.heldTmdb.delete(50);
  f.restart();
  f.at(20,"13:00:00");
  const result = await f.run();
  assert.equal(f.feed("TMDB"),date(20),"downloads saved before the interruption are verified from their own download");
  assert.deepEqual(f.downloads(),["/3/tv/50/season/1"],"only the unfinished recovery download is repeated");
  assert.equal(missing(result,50),0);
  assert.deepEqual(result.coverage.issues,[]);
  release();
  await interrupted;
});

test("absent TVDB history verifies from its catalogues' own successful downloads and stays visibly unverified while the feed fails", async t => {
  const f = await fixture(t);
  await f.run();
  f.legacy();
  // A TVDB correction after the catalogues were downloaded, before verification history was lost.
  f.state.tvdbChanges.push({id:40,at:day(0,"18:00:00")});
  f.at(1);
  f.state.tvdbFeedFailure = true;
  let result = await f.run();
  assert.deepEqual(f.downloads(),[],"last-good catalogues are kept while the feed is unavailable, and TMDB is not forced");
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TVDB"),"TVDB freshness is visibly unverified");
  f.restart();
  f.at(2);
  f.state.tvdbFeedFailure = false;
  result = await f.run();
  assert.equal(f.feed("TVDB"),tvdbSince(day(0)),"neither the failed attempt nor the completed scan fabricated a verification position");
  assert.deepEqual(f.downloads(),["/v4/series/40/episodes/default"],"the change since the catalogue's own download is refreshed");
  assert.ok(!result.coverage.issues.some((issue:Issue)=>issue.id === "provider-verification:TVDB"));
  f.at(2,"13:00:00");
  await f.run();
  assert.equal(f.feed("TVDB"),tvdbSince(day(2)),"verified history continues from the successful check");
  assert.deepEqual(f.downloads(),[]);
});

test("a retained primary TMDB change refreshes its episode identity lookups once inventory is restored", async t => {
  const f = await fixture(t);
  // Plex owns TMDB episode 100 only; TMDB's /find maps TVDB pilot 200 to it.
  f.state.misnumberedInventory.add(10);
  f.state.findEpisodes.set(200,[{id:100,show_id:10,season_number:1,episode_number:1}]);
  let result = await f.run();
  assert.equal(missing(result,10),0,"the TVDB pilot is satisfied through the /find mapping");
  // Upstream corrects the mapping and reports the primary TMDB show as changed.
  f.state.findEpisodes.set(200,[]);
  f.state.tmdbChanges.push({id:10,date:date(1)});
  f.state.failedInventory.add("10");
  for (const n of [1,2]) {
    f.at(n);
    result = await f.run();
    assert.ok(result.coverage.issues.some((issue:Issue)=>issue.operation === "inventory"),`day ${n}: incomplete inventory blocks processing`);
  }
  f.at(3);
  f.state.failedInventory.clear();
  f.state.tmdbChanges.length = 0;
  result = await f.run();
  assert.deepEqual(tmdbCatalogueRequests(f).filter(p=>p.startsWith("/3/tv/10")),["/3/tv/10","/3/tv/10/season/1"],"the retained change downloads the TMDB catalogue");
  assert.equal(missing(result,10),1,"the corrected mapping leaves the TVDB pilot missing");
  assert.ok(f.requests.some(u=>u.pathname === "/3/find/200"),"the retained change re-requests the primary show's identity lookup");
});

test("a retained primary TVDB change refreshes its episode identity lookups once inventory is restored", async t => {
  const f = await fixture(t);
  // Plex owns IMDb episode tt10; TVDB lists it as the remote ID of TVDB pilot 200.
  f.state.misnumberedInventory.add(10);
  f.state.tvdbEpisodeImdbIds.set(200,["tt10"]);
  let result = await f.run();
  assert.equal(missing(result,10),0,"the TVDB pilot is satisfied through its IMDb remote ID");
  // Upstream corrects the remote ID and reports the primary TVDB series as changed.
  f.state.tvdbEpisodeImdbIds.set(200,[]);
  f.state.tvdbChanges.push({id:20,at:day(1,"08:00:00")});
  f.state.failedInventory.add("10");
  for (const n of [1,2]) {
    f.at(n);
    result = await f.run();
    assert.ok(result.coverage.issues.some((issue:Issue)=>issue.operation === "inventory"),`day ${n}: incomplete inventory blocks processing`);
  }
  f.at(3);
  f.state.failedInventory.clear();
  f.state.tvdbChanges.length = 0;
  result = await f.run();
  assert.deepEqual(f.downloads(),["/v4/series/20/episodes/default"],"the retained change downloads the TVDB catalogue");
  assert.equal(missing(result,10),1,"the corrected remote ID leaves the TVDB pilot missing");
  assert.ok(f.requests.some(u=>u.pathname === "/v4/episodes/200/extended"),"the retained change re-requests the primary series' identity lookup");
});
