import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverageIssueReport, CoverageWarning } from "../app/reports/components/coverage-issue-report";
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
hook.deregister();

async function fixture(t: TestContext) {
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
  const owned = true;
  let malformedTmdb = false;
  let feedFailure = false;
  let fatalInventory = false;
  let tmdbChanged: number[] = [];
  let tvdbChanged: number[] = [];
  let extraTmdbEpisode = false;
  const requests: string[] = [];
  const show = {ratingKey:"1",title:"Example",Guid:[{id:"tmdb://10"},{id:"tvdb://20"}],updatedAt:1};
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u.pathname);
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections" && fatalInventory) return Response.json({},{status:401});
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:owned ? [{ratingKey:"ep",parentIndex:1,index:1,Guid:[{id:"tmdb://100"},{id:"tvdb://200"}]}] : []}});
      return Response.json({MediaContainer:{Metadata:[show]}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes" && feedFailure) return Response.json({error:"feed unavailable"},{status:401});
    if(u.pathname === "/3/tv/changes") return Response.json({results:tmdbChanged.map(id=>({id})),total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:tvdbChanged.map(id=>({entityType:"series",recordId:id}))});
    if(u.pathname === "/3/tv/10") return Response.json({id:10,name:"Example",seasons:[{season_number:1},{season_number:2}],external_ids:{tvdb_id:20}});
    if(u.pathname === "/3/tv/10/season/2") return Response.json({episodes:extraTmdbEpisode ? [{id:101,season_number:2,episode_number:1,name:"Newly corrected episode",air_date:"2020-01-01"}] : []});
    if(u.pathname === "/3/tv/10/season/1" && malformedTmdb) return Response.json({});
    if(u.pathname === "/3/tv/10/season/1") return Response.json({episodes:[{id:100,season_number:1,episode_number:1,name:"Pilot",air_date:"2020-01-01"}]});
    if(u.pathname === "/v4/series/20") return Response.json({data:{id:20,name:"Example",slug:"example"}});
    if(u.pathname === "/v4/series/20/episodes/default" && u.searchParams.get("page") === "1") return Response.json({data:{episodes:[]}});
    if(u.pathname === "/v4/series/20/episodes/default") return Response.json({links:{next:"page1"},data:{episodes:[{id:200,seasonNumber:1,number:1,name:"Pilot",aired:"2020-01-01"}]}});
    if(u.pathname.includes("/find/")) return Response.json({tv_results:[],tv_episode_results:[]});
    throw new Error("Unexpected HTTP: "+u);
  });
  const run = async (ratingKey?: string) => {
    await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:JSON.stringify({ratingKey})}));
    for(let i=0;i<500;i++) { const state = await (await scan.GET()).json(); if(state.scan.status !== "running") { assert.equal(state.scan.status,"completed",state.scan.error); return state.report; } await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out");
  };
  return {run, requests, restart() { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase; },
    correction() { extraTmdbEpisode = true; },
    changed(tmdb: number[] = [], tvdb: number[] = []) { tmdbChanged = tmdb; tvdbChanged = tvdb; },
    fail(feed: boolean, download = false, inventory = false) { feedFailure = feed; malformedTmdb = download; fatalInventory = inventory; },
    async state() { return (await (await scan.GET()).json()); },
    counts() { return [requests.filter(p=>p === "/3/tv/10/season/1").length,requests.filter(p=>p === "/v4/series/20/episodes/default").length]; },
    at(value: string) { t.mock.timers.setTime(Date.parse(value)); requests.length = 0; },
  };
}

test("deferred TMDB changes survive advancing verification, UTC midnight and restart", async t => {
  const f = await fixture(t);
  await f.run(); f.correction(); f.changed([10]); f.requests.length = 0;
  assert.equal((await f.run()).shows[0].missing.length,0,"a later same-day correction may wait"); assert.deepEqual(f.counts(),[0,0]);
  f.changed(); f.at("2026-11-12T00:00:00Z"); f.restart();
  const refreshed = await f.run();
  assert.deepEqual(f.counts(),[1,0],"a suppressed change survives an empty later feed and restart");
  assert.equal(refreshed.shows[0].missing[0].tmdbEpisodeId,101,"the next day exposes the deferred provider correction");
  f.requests.length = 0; await f.run();
  assert.deepEqual(f.counts(),[0,0],"successful download consumes the deferred correction");
});

// Superseded: this gap was measured from the last clean full scan. It is now TMDB's own
// verification position, which only full scans with a successful TMDB feed advance.
test("TMDB verification gaps refresh only TMDB strictly beyond the fourteen-day change-feed window", async t => {
  const f = await fixture(t); await f.run();
  // Targeted work must not advance provider verification positions.
  f.at("2026-11-25T11:59:59Z"); await f.run("ratingKey:1");
  f.at("2026-11-25T12:00:00Z"); await f.run();
  assert.deepEqual(f.counts(),[0,0],"exactly fourteen days is reusable");
  f.at("2026-12-09T11:59:59Z"); await f.run();
  assert.deepEqual(f.counts(),[0,0],"just below fourteen days is reusable");
  f.at("2026-12-23T12:00:00Z");
  f.fail(false,false,true); await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
  for(let i=0;i<500;i++) { if((await f.state()).scan.status !== "running") break; await new Promise(r=>setTimeout(r,10)); }
  f.fail(false); f.restart(); f.requests.length = 0;
  await f.run();
  assert.deepEqual(f.counts(),[1,0],"failed attempts and restart cannot conceal the elapsed gap");
  assert.equal((await f.state()).coverage.issues.length,0,"a fresh direct download resolves the deliberate TMDB feed-window fallback");
});

test("independent sixty-day provider ages expire strictly, retain last-good data and retry despite feed outages", async t => {
  const f = await fixture(t); await f.run();
  f.at("2026-11-12T12:00:00Z"); f.changed([], [20]); await f.run();
  assert.deepEqual(f.counts(),[0,2]); f.changed();
  for(const day of ["2026-11-25","2026-12-08","2026-12-21","2027-01-03"]) { f.at(`${day}T12:00:00Z`); await f.run(); }
  f.at("2027-01-10T11:59:59.999Z"); await f.run(); assert.deepEqual(f.counts(),[0,0]);
  f.at("2027-01-10T12:00:00Z"); await f.run(); assert.deepEqual(f.counts(),[0,0],"exactly sixty elapsed days does not expire TMDB");
  f.at("2027-01-10T12:00:00.001Z"); f.fail(true,true); const stale = await f.run();
  assert.deepEqual(f.counts(),[1,0],"age mandates a TMDB attempt despite unavailable changes");
  assert.equal(stale.shows[0].missing.length,0,"last-good coverage remains visible");
  assert.ok((await f.state()).coverage.issues.some((issue:{operation:string})=>issue.operation === "catalogue-refresh"));
  const failedIssues=(await f.state()).coverage.issues;
  const failedView=renderToStaticMarkup(createElement(CoverageIssueReport,{issues:failedIssues}));
  assert.match(failedView,/Provider Lookup/);
  assert.match(failedView,/TMDB/);
  assert.match(failedView,/Library-wide and unassigned issues/);
  assert.match(renderToStaticMarkup(createElement(CoverageWarning,{issues:failedIssues})),/Scan Issues/);
  f.restart(); f.fail(true); f.requests.length = 0; await f.run();
  assert.deepEqual(f.counts(),[1,0],"a failed mandatory download retries across restart");
  const repairedIssues=(await f.state()).coverage.issues;
  const repairedView=renderToStaticMarkup(createElement(CoverageIssueReport,{issues:repairedIssues}));
  assert.ok(!repairedIssues.some((issue:{operation:string})=>issue.operation === "catalogue-refresh"),"successful retry clears the failed catalogue lookup");
  assert.match(repairedView,/Provider Lookup/,"independent provider feed failure remains visible");
  assert.ok(repairedIssues.some((issue:{operation:string})=>issue.operation === "provider-verification"),"unrelated freshness verification remains visible");
  assert.match(renderToStaticMarkup(createElement(CoverageWarning,{issues:repairedIssues})),/Scan Issues/);
  f.fail(false); f.at("2027-01-11T11:59:59.999Z"); await f.run(); assert.deepEqual(f.counts(),[0,0]);
  f.at("2027-01-11T12:00:00Z"); await f.run(); assert.deepEqual(f.counts(),[0,0],"TVDB has its own exact sixty-day boundary");
  f.at("2027-01-11T12:00:00.001Z"); await f.run(); assert.deepEqual(f.counts(),[0,2],"only TVDB expires after its independent download");
  assert.equal((await f.state()).coverage.issues.length,0);
  await scan.DELETE(new Request("http://localhost/api/plex/scan?ratingKey=ratingKey:1",{method:"DELETE"}));
  f.requests.length=0; await f.run(); assert.deepEqual(f.counts(),[1,2],"explicit clearing beats same-day reuse");
});

test("targeted checks do not advance the TMDB verification position", async t => {
  const f = await fixture(t); await f.run();
  f.at("2026-11-25T11:59:59Z"); await f.run("ratingKey:1");
  f.at("2026-11-25T12:00:00.001Z"); f.restart(); await f.run();
  assert.deepEqual(f.counts(),[1,0],"targeted fresh catalogues do not mask the full-scan gap or force TVDB");
});
