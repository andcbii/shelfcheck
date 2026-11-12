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
  let feedFailure = false;
  let malformedInventory = false;
  let fatalInventory = false;
  let authenticationFailure = false;
  let malformedTvdb = false;
  let tmdbChanged: number[] = [];
  let tvdbChanged: number[] = [];
  const requests: string[] = [];
  const show = {ratingKey:"1",title:"Example",Guid:[{id:"tmdb://10"},{id:"tvdb://20"}],updatedAt:1};
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u.pathname);
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections" && fatalInventory) return Response.json({},{status:401});
      if(u.pathname.includes("allLeaves") && malformedInventory) return Response.json({MediaContainer:{}});
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:owned ? [{ratingKey:"ep",parentIndex:1,index:1,Guid:[{id:"tmdb://100"},{id:"tvdb://200"}]}] : []}});
      return Response.json({MediaContainer:{Metadata:[show]}});
    }
    if(u.pathname === "/v4/login" && authenticationFailure) return Response.json({},{status:401});
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes" && feedFailure) return Response.json({error:"feed unavailable"},{status:401});
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
  feedFailure = true;
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p.includes("/season/") || p.includes("/episodes/default")).length,0,"feed failure reuses last-good catalogues");
  const failedFeed = await (await scan.GET()).json();
  assert.ok(failedFeed.coverage.issues.some((issue:{operation:string;provider:string})=>issue.operation === "provider-verification" && issue.provider === "TMDB"));
  assert.equal(failedFeed.coverage.pending,1);
  const feedIssue = failedFeed.coverage.issues.find((issue:{id:string})=>issue.id === "provider-verification:TMDB");
  assert.equal(feedIssue.category,"Provider Lookup");
  assert.deepEqual(feedIssue.lookup.requested,{provider:"TMDB",kind:"show change feed"});
  assert.match(feedIssue.lookup.impact,/freshness.*could not be verified/);
  assert.match(feedIssue.action,/credentials or permissions/);
  feedFailure = false;
  await run();
  assert.equal((await (await scan.GET()).json()).coverage.issues.length,0);
  // The fifth successful full scan overrides the daily flag's same-day suppression.
  tmdbChanged = [10];
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,1);
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,0);
  tmdbChanged = []; tvdbChanged = [20];
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,0);
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,2);
  tvdbChanged = [];
  tmdbChanged = [10];
  malformedTmdb = true;
  t.mock.timers.tick(86400_000);
  tvdbChanged = [20];
  t.mock.timers.tick(60_000);
  const partial = await run();
  assert.equal(partial.shows[0].missing[0].tmdbEpisodeId,100,"failed refresh compares the retained last-good TMDB catalogue");
  assert.ok((await (await scan.GET()).json()).coverage.issues.some((issue:{operation:string;provider:string})=>issue.operation === "catalogue-refresh" && issue.provider === "TMDB"));
  (globalThis as typeof globalThis & {__shelfcheckDatabase?:DatabaseSync}).__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
  tvdbChanged = [];
  tmdbChanged = [];
  malformedTmdb = false;
  requests.length = 0;
  await run();
  assert.ok(requests.includes("/3/tv/10/season/1"), "an incomplete response must not replace the last complete catalogue or count as a successful refresh");
  tvdbChanged = [20]; malformedTvdb = true; feedFailure = true;
  const retainedTvdb = await run();
  assert.equal(retainedTvdb.shows[0].missing[0].tvdbEpisodeId,200,"a malformed later page preserves last-good TVDB coverage");
  (globalThis as typeof globalThis & {__shelfcheckDatabase?:DatabaseSync}).__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
  feedFailure = false; tvdbChanged = [];
  await run();
  const independentIssues = (await (await scan.GET()).json()).coverage.issues;
  assert.ok(!independentIssues.some((issue:{operation:string;provider:string})=>issue.operation === "provider-verification" && issue.provider === "TMDB"));
  assert.ok(independentIssues.some((issue:{operation:string;provider:string})=>issue.operation === "catalogue-refresh" && issue.provider === "TVDB"),"successful TMDB verification cannot clear an unrelated TVDB failure");
  tvdbChanged = []; malformedTvdb = false; requests.length=0;
  await run();
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,2,"a failed page is retried independently");
  assert.equal((await (await scan.GET()).json()).coverage.issues.length,0,"successful TVDB retry resolves its issue");
  const lastGood = await run();
  malformedInventory = true;
  const unavailable = await run();
  assert.deepEqual(unavailable.shows[0].missing,lastGood.shows[0].missing,"incomplete inventory preserves last-good comparison");
  const inventoryIssues = (await (await scan.GET()).json()).coverage.issues;
  assert.ok(inventoryIssues.some((issue:{operation:string;show?:{ratingKey:string}})=>issue.operation === "inventory" && issue.show?.ratingKey === "ratingKey:1"));
  malformedInventory = false;
  await run();
  assert.equal((await (await scan.GET()).json()).coverage.issues.length,0);
  fatalInventory = true;
  await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
  for(let i=0;i<500;i++) { const state=await (await scan.GET()).json(); if(state.scan.status!=="running") { assert.equal(state.scan.status,"error"); assert.ok(state.coverage.issues.some((issue:{scope:string})=>issue.scope==="library")); assert.deepEqual(state.report.shows[0].missing,lastGood.shows[0].missing); break; } await new Promise(r=>setTimeout(r,10)); }
  fatalInventory = false;
  await run();
  assert.equal((await (await scan.GET()).json()).coverage.issues.length,0);
  authenticationFailure = true;
  await scan.DELETE(new Request("http://localhost/api/plex/scan?ratingKey=ratingKey:1",{method:"DELETE"}));
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,1,"TMDB refresh succeeds while TVDB authentication fails");
  const authIssue = (await (await scan.GET()).json()).coverage.issues.find((i:{id:string})=>i.id === "provider-authentication:TVDB");
  assert.equal(authIssue.category,"Provider Lookup");
  assert.deepEqual(authIssue.lookup.requested,{provider:"TVDB",kind:"authentication"});
  assert.deepEqual(authIssue.lookup.source,[]);
  assert.match(authIssue.action,/credentials or permissions/);
  authenticationFailure = false; requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,0,"TVDB retry must not redownload a successful TMDB catalogue");
  assert.equal((await (await scan.GET()).json()).coverage.issues.length,0);
  await scan.DELETE(new Request("http://localhost/api/plex/scan?ratingKey=ratingKey:1",{method:"DELETE"}));
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,1);
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,2);
  await scan.DELETE(new Request("http://localhost/api/plex/scan",{method:"DELETE"}));
  requests.length = 0;
  malformedTmdb = true;
  await run();
  assert.ok((await (await scan.GET()).json()).coverage.issues.some((issue:{operation:string})=>issue.operation === "comparison"));
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,2);
  malformedTmdb = false;
  requests.length = 0;
  await run();
  assert.equal(requests.filter(p=>p === "/3/tv/10/season/1").length,1);
  assert.equal(requests.filter(p=>p === "/v4/series/20/episodes/default").length,0,"healthy TVDB success is not consumed by missing TMDB comparison inputs");
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
  let failedIdentity = false;
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
    if(u.pathname === "/3/find/210" && failedIdentity) return Response.json({},{status:401});
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
  owned = 999;
  failedIdentity = true;
  await run();
  const identityIssue = (await (await scan.GET()).json()).coverage.issues.find((issue:{operation:string;episode?:{id:number}})=>issue.operation === "episode-identity" && issue.episode?.id===210);
  assert.equal(identityIssue?.provider,"TMDB");
  assert.equal(identityIssue?.episode.provider,"TVDB","failed operation provider differs from the known episode identity provider");
  failedIdentity = false;
  aliasChanged = false;
  await run();
  assert.ok(!(await (await scan.GET()).json()).coverage.issues.some((issue:{operation:string})=>issue.operation === "episode-identity"),"the failed identity lookup is retried even when last-good relationships are reusable");
  // Clearing one show leaves unrelated catalogues reusable.
  await scan.DELETE(new Request("http://localhost/api/plex/scan?ratingKey=plex://show/target",{method:"DELETE"}));
  requests.length=0;
  await run();
  assert.equal(requests.filter(p=>p==="/3/tv/11/season/1").length,1);
  assert.equal(requests.filter(p=>p==="/v4/series/21/episodes/default").length,1);
  assert.equal(requests.filter(p=>p==="/3/tv/30/season/1").length,0);
});

test("explicit zero-sized Plex collections withdraw previous ownership while incomplete responses retain last-good results", async t => {
  const dir = mkdtempSync(path.join(tmpdir(),"plex-empty-collections-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  t.after(() => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  sqlite.writePlexSettings({diagnosticsEnabled:false});
  const responses = new Map<string,unknown>();
  const show = {ratingKey:"1",title:"Example",Guid:[{id:"tmdb://10"}]};
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input));
    if(u.hostname === "plex") {
      if(responses.has(u.pathname)) return Response.json(responses.get(u.pathname));
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname === "/library/metadata/1/allLeaves") return Response.json({MediaContainer:{Metadata:[{ratingKey:"ep",parentIndex:1,index:1,Guid:[{id:"tmdb://100"}]}]}});
      return Response.json({MediaContainer:{Metadata:[show]}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:[],total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:[]});
    if(u.pathname === "/3/tv/10") return Response.json({id:10,name:"Example",seasons:[{season_number:1}]});
    if(u.pathname === "/3/tv/10/season/1") return Response.json({episodes:[{id:100,season_number:1,episode_number:1,name:"Pilot",air_date:"2020-01-01"}]});
    throw new Error("Unexpected HTTP: "+u);
  });
  const run = async () => {
    await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
    for(let i=0;i<500;i++) { const state = await (await scan.GET()).json(); if(state.scan.status !== "running") return state; await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out");
  };
  const initial = await run();
  assert.equal(initial.scan.status,"completed",initial.scan.error);
  assert.deepEqual(initial.report.shows[0].missing,[]);
  responses.set("/library/metadata/1/allLeaves",{MediaContainer:{size:0}});
  const empty = await run();
  assert.equal(empty.scan.status,"completed",empty.scan.error);
  assert.equal(empty.report.shows[0].missing.length,1,"a valid empty collection removes previous ownership");
  assert.equal(empty.report.shows[0].missing[0].tmdbEpisodeId,100);
  assert.deepEqual(empty.coverage.issues,[]);
  assert.equal(empty.coverage.pending,0);
  responses.clear();
  for (const endpoint of ["/library/sections/1/all","/library/sections"]) {
    assert.deepEqual((await run()).report.shows[0].missing,[]);
    responses.set(endpoint,{MediaContainer:{size:0}});
    const emptyLibrary = await run();
    assert.equal(emptyLibrary.scan.status,"completed",emptyLibrary.scan.error);
    assert.deepEqual(emptyLibrary.report.shows,[],"an explicitly empty library must remove its former shows");
    assert.deepEqual(emptyLibrary.coverage.issues,[]);
    assert.equal(emptyLibrary.coverage.pending,0);
    responses.clear();
  }
  for (const endpoint of ["/library/sections","/library/sections/1/all","/library/metadata/1/allLeaves","/library/metadata/1"]) {
    const field = endpoint === "/library/sections" ? "Directory" : "Metadata";
    const incompleteBodies = [
      {}, {MediaContainer:{}}, {MediaContainer:{size:1}}, {MediaContainer:{size:"0"}},
      {MediaContainer:{size:0,[field]:null}}, {MediaContainer:{size:0,[field]:{}}},
      ...(endpoint === "/library/metadata/1" ? [{MediaContainer:{size:0}}] : []),
    ];
    for (const body of incompleteBodies) {
      const restored = await run();
      assert.equal(restored.scan.status,"completed",restored.scan.error);
      assert.deepEqual(restored.coverage.issues,[]);
      responses.set(endpoint,body);
      const unavailable = await run();
      const message = `${endpoint}: ${JSON.stringify(body)}`;
      assert.deepEqual(unavailable.report.shows[0].missing,[],"incomplete inventory retains last-good ownership: "+message);
      assert.ok(unavailable.coverage.issues.some((issue:{provider:string;operation:string})=>issue.provider === "Plex" && issue.operation === "inventory"),"incomplete responses produce a Plex inventory issue: "+message);
      assert.equal(unavailable.coverage.pending,1,message);
      responses.clear();
    }
  }
});
