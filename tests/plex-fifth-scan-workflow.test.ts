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
const matches = await import("../app/api/plex/manual-coverage/route");
hook.deregister();

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"fifth-scan-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  const restart = () => {global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;};
  t.after(() => { restart();
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  sqlite.writePlexSettings({diagnosticsEnabled:false});
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-11-11T12:00:00Z")});
  const state = {feedFailure:false,downloadFailure:false,inventoryFailure:false, ownsTvdb:false, advanceClock:0, today:[10,999], older:[] as number[],
    tvdbFeedFailure:false, failedTvdb:new Set<number>(), failedTmdb:new Set<number>(), failedInventory:new Set<string>(), failedFind:new Set<number>()};
  const requests: URL[] = [];
  const shows = [10,30].map(id=>({ratingKey:String(id),title:`Show ${id}`,Guid:[{id:`tmdb://${id}`},{id:`tvdb://${id+10}`}],updatedAt:1}));
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u);
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections" && state.inventoryFailure) return Response.json({},{status:401});
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname.includes("allLeaves") && state.failedInventory.has(u.pathname.split("/")[3])) return Response.json({},{status:404});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:state.ownsTvdb && u.pathname.includes("/10/") ? [{ratingKey:"owned",parentIndex:2,index:1,Guid:[{id:"tvdb://200"}]}] : []}});
      return Response.json({MediaContainer:{Metadata:u.pathname.includes("/metadata/") ? [shows.find(s=>u.pathname.includes(`/metadata/${s.ratingKey}`))] : shows}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes" && state.feedFailure) return Response.json({},{status:401});
    if(u.pathname === "/3/tv/changes") return Response.json({results:[...state.today,...(u.searchParams.get("start_date") === u.searchParams.get("end_date") ? [] : state.older)].map(id=>({id})),total_pages:1});
    if(u.pathname === "/v4/updates" && state.tvdbFeedFailure) return Response.json({},{status:401});
    if(u.pathname === "/v4/updates") return Response.json({data:[]});
    const tmdb = u.pathname.match(/^\/3\/tv\/(10|30)$/);
    if(tmdb) return Response.json({id:Number(tmdb[1]),name:`Show ${tmdb[1]}`,seasons:[{season_number:1}],external_ids:{tvdb_id:Number(tmdb[1])+10}});
    if(u.pathname === "/3/tv/10/season/1/episode/1") return Response.json({id:100,name:"Pilot",season_number:1,episode_number:1});
    if(u.pathname.endsWith("/external_ids")) return Response.json({});
    if(u.pathname === "/v4/episodes/200/extended") return Response.json({data:{id:200,seriesId:20,seasonNumber:2,number:1,name:"Pilot part",remoteIds:[]}});
    if(u.pathname === "/3/tv/10/season/1" && state.advanceClock) { t.mock.timers.tick(state.advanceClock); state.advanceClock = 0; }
    if(u.pathname === "/3/tv/10/season/1" && state.downloadFailure) return Response.json({});
    if(/^\/3\/tv\/\d+\/season\/1$/.test(u.pathname) && state.failedTmdb.has(Number(u.pathname.split("/")[3]))) return Response.json({},{status:404});
    if(u.pathname.match(/^\/3\/tv\/(10|30)\/season\/1$/)) return Response.json({episodes:[{id:Number(u.pathname.split('/')[3])*10,season_number:1,episode_number:1,name:"Pilot",air_date:"2020-01-01"}]});
    const tvdb = u.pathname.match(/^\/v4\/series\/(20|40)$/);
    if(tvdb) return Response.json({data:{id:Number(tvdb[1]),name:`Show ${Number(tvdb[1])-10}`,slug:`show-${tvdb[1]}`}});
    if(u.pathname.includes("/episodes/default") && state.failedTvdb.has(Number(u.pathname.split("/")[3]))) return Response.json({},{status:404});
    if(u.pathname.includes("/episodes/default")) return Response.json({data:{episodes:[]}});
    if(u.pathname.includes("/find/") && state.failedFind.has(Number(u.pathname.split("/")[3]))) return Response.json({},{status:404});
    if(u.pathname.includes("/find/")) return Response.json({tv_results:[],tv_episode_results:[]});
    throw new Error("Unexpected HTTP: "+u);
  });
  const run = async (ratingKey?:string) => {
    requests.length = 0;
    await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:JSON.stringify(ratingKey ? {ratingKey} : {})}));
    for(let i=0;i<500;i++) { const result = await (await scan.GET()).json(); if(result.scan.status !== "running") return result; await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out");
  };
  const tmdbDownloads = () => requests.filter(u=>/^\/3\/tv\/\d+\/season\/\d+$/.test(u.pathname)).map(u=>u.pathname).sort();
  const downloads = () => requests.filter(u=>/\/season\/\d+$/.test(u.pathname) || u.pathname.includes("/episodes/default")).map(u=>u.pathname).sort();
  return {state,requests,run,downloads,tmdbDownloads,restart};
}

type Issue = {id:string;provider?:string;operation:string};
const hasIssue = (result:{coverage:{issues:Issue[]}}, id:string) => result.coverage.issues.some(issue=>issue.id === id);

test("every fifth completed full scan refreshes only today's included changed TMDB catalogues across restart", async t => {
  const f = await fixture(t);
  for(let i=1;i<=4;i++) { assert.equal((await f.run()).scan.status,"completed"); if(i>1) assert.deepEqual(f.downloads(),[]); }
  f.restart();
  await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1"]);
  assert.ok(f.requests.some(u=>u.pathname === "/3/tv/changes" && u.searchParams.get("start_date") === "2026-11-11" && u.searchParams.get("end_date") === "2026-11-11"));
  for(let i=6;i<=9;i++) { await f.run(); assert.deepEqual(f.downloads(),[]); }
  await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1"]);
  assert.ok(f.requests.some(u=>u.pathname === "/library/metadata/30/allLeaves"));
  await f.run(); // Ordinary same-day reuse leaves a deferred change after scan ten.
  t.mock.timers.tick(86400_000);
  f.state.today = [];
  await f.run(); // Deferred changes are refreshed after midnight independently.
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1"]);
  f.state.today = [10];
  for(let i=2;i<=4;i++) { await f.run(); assert.deepEqual(f.downloads(),[]); }
  await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1"]);
});

test("a failed fifth-scan feed counts the completed scan and leaves a pending safeguard fulfilled by a later same-day scan", async t => {
  const f = await fixture(t);
  f.state.today = [10,30,999];
  for(let i=1;i<=4;i++) await f.run();
  await f.run("ratingKey:30");
  assert.deepEqual(f.downloads(),["/3/tv/30/season/1","/v4/series/40/episodes/default"]);
  f.state.feedFailure = true;
  let result = await f.run();
  assert.equal(result.scan.status,"completed","the fifth completed scan still completes");
  assert.deepEqual(f.downloads(),[]);
  assert.ok(hasIssue(result,"provider-verification:TMDB"),"the unfinished safeguard is visible");
  f.restart();
  result = await f.run(); // Completed scan six: the safeguard remains due while its feed is unavailable.
  assert.deepEqual(f.downloads(),[]);
  assert.ok(hasIssue(result,"provider-verification:TMDB"));
  f.state.feedFailure = false;
  f.state.inventoryFailure = true;
  assert.equal((await f.run()).scan.status,"error");
  f.state.inventoryFailure = false;
  // Model a process ending before completion: only persisted running status remains.
  sqlite.writePlexScanStatus({status:"running",processed:0,total:2,startedAt:"2026-11-11T11:00:00.000Z"});
  const interrupted = await (await scan.GET()).json();
  assert.equal(interrupted.scan.status,"error");
  assert.ok(hasIssue(interrupted,"scan-failure"));
  f.restart();
  f.state.failedTmdb.add(10);
  result = await f.run(); // Completed scan seven fulfills the pending safeguard.
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1","/3/tv/30/season/1"],"same-day reuse is bypassed for changed library shows only, without TVDB downloads");
  assert.ok(f.requests.some(u=>u.pathname === "/3/tv/changes" && u.searchParams.get("start_date") === "2026-11-11" && u.searchParams.get("end_date") === "2026-11-11"));
  assert.equal(result.report.shows.find((s:{title:string})=>s.title === "Show 10").missing.length,1,"last-good results survive the failed download");
  assert.ok(hasIssue(result,"catalogue-refresh:TMDB:ratingKey:10"));
  assert.ok(!hasIssue(result,"provider-verification:TMDB"),"the safeguard feed was verified");
  f.restart();
  f.state.today = [];
  f.state.failedTmdb.clear();
  result = await f.run(); // Completed scan eight.
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1"],"the failed safeguard download retries after an empty feed without repeating the successful one");
  assert.deepEqual(result.coverage.issues,[]);
  await f.run(); // Completed scan nine: the fulfilled safeguard was consumed.
  assert.deepEqual(f.downloads(),[]);
  f.state.today = [10,30,999];
  await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1","/3/tv/30/season/1"],"failed feeds still consumed ordinals; failed, interrupted and single-show scans did not");
});

test("explicit catalogue clearing preserves today's completed full-scan count", async t => {
  const f = await fixture(t);
  for(let i=1;i<=3;i++) await f.run();
  await scan.DELETE(new Request("http://localhost/api/plex/scan",{method:"DELETE"}));
  await f.run(); // Fresh downloads, successful scan four.
  await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1"]);
});

test("Manual Match cached rechecks do not count and affected refreshes combine with the independent fifth-scan policy", async t => {
  const f = await fixture(t);
  f.state.ownsTvdb = true;
  f.state.today = [30];
  const initial = await f.run();
  assert.equal(initial.report.shows.find((s:{title:string})=>s.title === "Show 10").missing.length,1);
  const post = (body:unknown) => matches.POST(new Request("http://localhost/api/plex/manual-coverage",{method:"POST",body:JSON.stringify(body)}));
  const preview = await (await post({action:"resolve",urls:["tmdb:100 show:10 season:1 episode:1","tvdb:200"]})).json();
  f.requests.length = 0;
  const savedResponse = await post({action:"save",preview:preview.preview});
  assert.equal(savedResponse.status,201);
  const saved = await savedResponse.json();
  let result = await (await scan.GET()).json();
  assert.equal(result.report.shows.find((s:{title:string})=>s.title === "Show 10").missing.length,0);
  assert.equal(result.report.shows.find((s:{title:string})=>s.title === "Show 30").missing.length,1);
  assert.deepEqual(f.downloads(),[],"saving recomputes from catalogues without downloading seasons");
  assert.ok(!f.requests.some(u=>u.hostname === "plex"));
  await f.run(); // Full scan two refreshes only the affected provider catalogues.
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1","/v4/series/20/episodes/default"]);
  for(let i=3;i<=4;i++) { await f.run(); assert.deepEqual(f.downloads(),[]); }
  f.requests.length = 0;
  const edited = await post({action:"save",id:saved.mapping.id,revision:saved.mapping.revision,preview:preview.preview});
  assert.equal(edited.status,200);
  assert.deepEqual(f.downloads(),[]);
  f.restart();
  result = await f.run();
  assert.deepEqual(result.coverage.issues,[]);
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1","/3/tv/30/season/1","/v4/series/20/episodes/default"]);
  for(let i=6;i<=9;i++) { await f.run(); assert.deepEqual(f.downloads(),[]); }
  await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/30/season/1"],"Manual Match refreshes do not disturb completed-full-scan bookkeeping");
});

test("a scan crossing midnight commits its planned UTC day's ordinal", async t => {
  const f = await fixture(t);
  for(let i=1;i<=4;i++) await f.run();
  t.mock.timers.tick(12 * 3600_000 - 1000);
  f.state.advanceClock = 2000;
  await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1"]);
  assert.ok(f.requests.filter(u=>u.pathname === "/3/tv/changes").every(u=>u.searchParams.get("start_date") === "2026-11-11" && u.searchParams.get("end_date") === "2026-11-11"));
  for(let i=1;i<=4;i++) { await f.run(); assert.deepEqual(f.downloads(),[]); }
  await f.run();
  assert.deepEqual(f.downloads(),["/3/tv/10/season/1"],"the next day starts at one even though the fifth scan finished after midnight");
});

test("completed full scans with isolated issues count toward the fifth-scan safeguard while incomplete scans do not", async t => {
  const f = await fixture(t);
  // A permanent TVDB 404 leaves a catalogue issue on every scan.
  f.state.failedTvdb.add(40);
  f.state.failedFind.add(20);
  let result = await f.run();
  assert.equal(result.scan.status,"completed");
  assert.ok(hasIssue(result,"catalogue-refresh:TVDB:ratingKey:30"));
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.provider === "TMDB" && issue.operation === "provider-association"),JSON.stringify(result.coverage.issues));
  f.state.failedFind.clear();
  f.state.tvdbFeedFailure = true;
  result = await f.run();
  assert.ok(hasIssue(result,"provider-verification:TVDB"),"isolated feed issue");
  f.state.tvdbFeedFailure = false;
  f.state.failedInventory.add("30");
  result = await f.run();
  assert.equal(result.scan.status,"completed");
  assert.ok(result.coverage.issues.some((issue:Issue)=>issue.operation === "inventory"),"incomplete inventory does not count");
  f.state.failedInventory.clear();
  f.state.inventoryFailure = true;
  assert.equal((await f.run()).scan.status,"error","a fatal inventory failure does not count");
  f.state.inventoryFailure = false;
  await f.run("ratingKey:10"); // Single-show scans do not count.
  f.restart();
  await f.run(); // Completed scan three.
  assert.deepEqual(f.tmdbDownloads(),[]);
  await f.run(); // Completed scan four.
  assert.deepEqual(f.tmdbDownloads(),[]);
  result = await f.run();
  assert.deepEqual(f.tmdbDownloads(),["/3/tv/10/season/1"],"the fifth completed scan refreshes today's changed TMDB library show despite unresolved issues");
  assert.ok(f.downloads().includes("/v4/series/40/episodes/default"),"the isolated failure is still retried");
  assert.ok(hasIssue(result,"catalogue-refresh:TVDB:ratingKey:30"),"the unrelated issue remains visible");
  for(let i=6;i<=9;i++) { await f.run(); assert.deepEqual(f.tmdbDownloads(),[]); }
  await f.run();
  assert.deepEqual(f.tmdbDownloads(),["/3/tv/10/season/1"],"the tenth completed scan");
});
