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
const catalogues = await import("../lib/plex-catalogues");
const config = await import("../lib/server-config");
hook.deregister();

test("full scans reuse catalogues while comparing current holdings across database reloads", async t => {
  const dir = mkdtempSync(path.join(tmpdir(),"catalogues-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  t.after(() => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  sqlite.writePlexSettings({diagnosticsEnabled:false});
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-11-11T12:00:00Z")});
  let owned = true;
  let malformedTmdb = false;
  let malformedTvdb = false;
  let tmdbChanged: number[] = [];
  let tvdbChanged: number[] = [];
  const requests: string[] = [];
  const show = {ratingKey:"1",title:"Example",Guid:[{id:"tmdb://10"},{id:"tvdb://20"}],updatedAt:1};
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u.pathname);
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:owned ? [{ratingKey:"ep",parentIndex:1,index:1,Guid:[{id:"tmdb://100"},{id:"tvdb://200"}]}] : []}});
      return Response.json({MediaContainer:{Metadata:[show]}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:tmdbChanged.map(id=>({id})),total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:tvdbChanged.map(id=>({entityType:"series",recordId:id}))});
    if(u.pathname === "/3/tv/10") return Response.json({id:10,name:"Example",seasons:[{season_number:1},{season_number:2}],external_ids:{tvdb_id:20}});
    if(u.pathname === "/3/tv/10/season/2") return Response.json({episodes:[]});
    if(u.pathname === "/3/tv/10/season/1" && malformedTmdb) return Response.json({});
    if(u.pathname === "/3/tv/10/season/1") return Response.json({episodes:[{id:100,season_number:1,episode_number:1,name:"Pilot",air_date:"2020-01-01"}]});
    if(u.pathname === "/v4/series/20") return Response.json({data:{id:20,name:"Example",slug:"example"}});
    if(u.pathname === "/v4/series/20/episodes/default" && u.searchParams.get("page") === "1") return Response.json(malformedTvdb ? {data:{}} : {data:{episodes:[]}});
    if(u.pathname === "/v4/series/20/episodes/default") return Response.json({links:{next:"page1"},data:{episodes:[{id:200,seasonNumber:1,number:1,name:"Pilot",aired:"2020-01-01"}]}});
    if(u.pathname.includes("/find/")) return Response.json({tv_results:[],tv_episode_results:[]});
    throw new Error("Unexpected HTTP: "+u);
  });
  const run = async () => {
    await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
    for(let i=0;i<500;i++) { const state = await (await scan.GET()).json(); if(state.scan.status !== "running") { assert.equal(state.scan.status,"completed",state.scan.error); return state.report; } await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out");
  };
  assert.deepEqual((await run()).shows[0].missing,[]);
  const initialTimes = [catalogues.readPlexInputs().tmdb["10"].downloadedAt,catalogues.readPlexInputs().tvdb["20"].downloadedAt];
  t.mock.timers.tick(60_000);
  owned = false;
  requests.length = 0;
  const second = await run();
  assert.equal(second.shows[0].missing[0].tmdbEpisodeId,100);
  assert.equal(second.shows[0].missing[0].tvdbEpisodeId,200);
  assert.ok(requests.includes("/library/metadata/1/allLeaves"));
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1" || p === "/v4/series/20/episodes/default").length,0);
  global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
  requests.length = 0;
  assert.equal((await run()).shows[0].missing.length,1);
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1" || p === "/v4/series/20/episodes/default").length,0);
  assert.deepEqual([catalogues.readPlexInputs().tmdb["10"].downloadedAt,catalogues.readPlexInputs().tvdb["20"].downloadedAt],initialTimes);
  // Provider change feeds refresh their own catalogue independently.
  tmdbChanged = [10];
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,1);
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,0);
  assert.notEqual(catalogues.readPlexInputs().tmdb["10"].downloadedAt,initialTimes[0]);
  assert.equal(catalogues.readPlexInputs().tvdb["20"].downloadedAt,initialTimes[1]);
  tmdbChanged = []; tvdbChanged = [20];
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,0);
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,2);
  assert.notEqual(catalogues.readPlexInputs().tvdb["20"].downloadedAt,initialTimes[1]);
  tvdbChanged = [];
  tmdbChanged = [10];
  malformedTmdb = true;
  tvdbChanged = [20];
  const beforePartial = catalogues.readPlexInputs().tmdb["10"].downloadedAt;
  t.mock.timers.tick(60_000);
  await run();
  assert.equal(catalogues.readPlexInputs().tmdb["10"].downloadedAt,beforePartial,"failed TMDB download preserves its previous success timestamp");
  assert.equal(catalogues.readPlexInputs().tvdb["20"].downloadedAt,"2026-11-11T12:02:00.000Z","TVDB succeeds independently of the TMDB failure");
  tvdbChanged = [];
  tmdbChanged = [];
  malformedTmdb = false;
  requests.length = 0;
  await run();
  assert.ok(requests.includes("/3/tv/10/season/1"), "an incomplete response must not replace the last complete catalogue or count as a successful refresh");
  const beforeTvdbFailure = catalogues.readPlexInputs().tvdb["20"].downloadedAt;
  tvdbChanged = [20]; malformedTvdb = true;
  await run();
  assert.equal(catalogues.readPlexInputs().tvdb["20"].downloadedAt,beforeTvdbFailure,"a malformed later page cannot replace a complete TVDB catalogue");
  assert.equal(catalogues.readPlexInputs().tvdb["20"].episodes.length,1);
  tvdbChanged = []; malformedTvdb = false; requests.length=0;
  await run();
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,2,"a failed page is retried independently");
  await scan.DELETE(new Request("http://localhost/api/plex/scan?ratingKey=ratingKey:1",{method:"DELETE"}));
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,1);
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,2);
  await scan.DELETE(new Request("http://localhost/api/plex/scan",{method:"DELETE"}));
  // A legacy report alone contains no complete provider catalogues.
  sqlite.writePlexReport(second);
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,1);
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,2);
});

test("saved identity relationships revalidate ownership and retain aliases and ignored-source inventory", async t => {
  const dir = mkdtempSync(path.join(tmpdir(),"catalogue-aliases-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  t.after(() => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-11-11T12:00:00Z")});
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  sqlite.writePlexSettings({diagnosticsEnabled:false,ignoredShows:[{ratingKey:"ratingKey:ignored",title:"Ignored source"}]});
  const a = {ratingKey:"a",guid:"plex://show/target",title:"Target",Guid:[{id:"tmdb://10"},{id:"tvdb://20"}]};
  const b = {ratingKey:"b",guid:"plex://show/target",title:"Target",Guid:[{id:"tmdb://11"},{id:"tvdb://21"}]};
  const other = {ratingKey:"other",title:"Other",Guid:[{id:"tmdb://30"}]};
  const ignored = {ratingKey:"ignored",title:"Ignored source",Guid:[{id:"tvdb://50"}]};
  let owned: number|undefined = 999;
  let aliasChanged = false;
  const requests: string[] = [];
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u.pathname);
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"},{key:"2",type:"show"}]}});
      if(u.pathname.includes("/sections/")) return Response.json({MediaContainer:{Metadata:u.pathname.includes("/1/") ? [a,b,other] : [ignored]}});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:u.pathname.includes("/other/") && owned ? [{ratingKey:"owned",parentIndex:99,index:99,Guid:[{id:`tmdb://${owned}`}]}] : u.pathname.includes("/ignored/") ? [{ratingKey:"ignored-item",parentIndex:8,index:8,Guid:[{id:"tvdb://555"}]}] : []}});
      return Response.json({MediaContainer:{Metadata:[u.pathname.includes("/other") ? other : u.pathname.includes("/b") ? b : a]}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:aliasChanged ? [{id:13}] : [],total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:[]});
    const tmdbShow = u.pathname.match(/^\/3\/tv\/(\d+)$/);
    if(tmdbShow) { const id = Number(tmdbShow[1]); return Response.json({id,name:id===13 && aliasChanged ? "Changed alias" : `TMDB ${id}`,seasons:[{season_number:1}],external_ids:id===13 ? {tvdb_id:21} : {}}); }
    const season = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1$/);
    if(season) return Response.json({episodes:[{id:Number(season[1])*10,season_number:1,episode_number:1,name:"TMDB episode",air_date:"2020-01-01"}]});
    const tvdbShow = u.pathname.match(/^\/v4\/series\/(\d+)$/);
    if(tvdbShow) return Response.json({data:{id:Number(tvdbShow[1]),name:`TVDB ${tvdbShow[1]}`,slug:`tvdb-${tvdbShow[1]}`}});
    if(u.pathname === "/v4/series/21/episodes/default") return Response.json({data:{episodes:[{id:210,seasonNumber:2,number:1,name:"TVDB episode",aired:"2020-01-01"}]}});
    if(u.pathname === "/3/find/21") return Response.json({tv_results:[{id:12,name:"Linked summary"}]});
    if(u.pathname === "/3/find/210") return Response.json({tv_episode_results:[{id:999,show_id:13,season_number:9,episode_number:1,name:"Alternative one"},{id:998,show_id:13,season_number:9,episode_number:2,name:"Alternative two"}]});
    throw new Error("Unexpected HTTP: "+u);
  });
  const run = async () => {
    await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
    for(let i=0;i<500;i++) { const state=await (await scan.GET()).json(); if(state.scan.status!=="running") { assert.equal(state.scan.status,"completed",state.scan.error); return state.report; } await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out");
  };
  const initial = await run();
  const target = initial.shows.find((s:{title:string})=>s.title==="Target");
  assert.equal(initial.shows.length,2);
  assert.deepEqual(target.plexRatingKeys,["a","b"]);
  assert.equal(target.autoMatches[0].tmdb.id,999);
  assert.deepEqual(target.providerMatches.tmdb.map((s:{id:number})=>s.id).sort((a:number,b:number)=>a-b),[10,11,12,13]);
  assert.deepEqual(target.providerMatches.tvdb.map((s:{id:number})=>s.id).sort((a:number,b:number)=>a-b),[20,21]);
  assert.ok(requests.includes("/library/metadata/ignored/allLeaves"),"ignored source inventory is collected before any Manual Matches exist");
  assert.equal(catalogues.readPlexInputs().inventory?.evidence.find(e=>e.ratingKey==="ignored-item")?.identities[0].id,555);
  global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
  owned=998; requests.length=0;
  const second = await run();
  assert.equal(second.shows.find((s:{title:string})=>s.title==="Target").autoMatches[0].tmdb.id,998,"all saved identity alternatives are rechecked against current holdings");
  assert.equal(requests.filter(p=>p.startsWith("/3/") && !p.includes("changes")).length,0);
  assert.equal(requests.filter(p=>p.includes("/episodes/default")).length,0);
  owned=undefined; requests.length=0;
  const removed = await run();
  const missing = removed.shows.find((s:{title:string})=>s.title==="Target");
  assert.equal(missing.autoMatches,undefined);
  assert.ok(missing.missing.some((e:{tvdbEpisodeId?:number})=>e.tvdbEpisodeId===210));
  aliasChanged = true; requests.length=0;
  const changed = await run();
  assert.equal(changed.shows.find((s:{title:string})=>s.title==="Target").providerMatches.tmdb.find((s:{id:number})=>s.id===13).name,"Changed alias");
  assert.equal(requests.filter(p=>p.includes("/season/") || p.includes("/episodes/default")).length,0,"a changed enrichment alias does not redownload unrelated primary catalogues");
  aliasChanged = false;
  // Even a hidden comparison report can be cleared without invalidating another show.
  sqlite.writePlexReport({...changed,coverageRevision:999});
  await scan.DELETE(new Request("http://localhost/api/plex/scan?ratingKey=plex://show/target",{method:"DELETE"}));
  requests.length=0;
  await run();
  assert.equal(requests.filter(p=>p==="/3/tv/11/season/1").length,1);
  assert.equal(requests.filter(p=>p==="/v4/series/21/episodes/default").length,1);
  assert.equal(requests.filter(p=>p==="/3/tv/30/season/1").length,0);
});
