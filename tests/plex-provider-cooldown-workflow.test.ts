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
const issues = await import("../lib/coverage-issues");
const { scanProviderClient } = await import("../lib/scan-provider-client");
hook.deregister();

// Provider cooldowns last for the server process, as the shared scan provider client does, so
// this file's tests run in order against one process: TVDB's cooldown from the first test is still
// in force in the second.

type Report = {scan:{status:string;error?:string};report:{shows:{title:string;missing:unknown[]}[]}};
const day = (n: number) => new Date(Date.parse("2026-11-01T12:00:00Z") + n * 86400_000).toISOString();

// Three shows: TMDB 10/30/50 pair with TVDB 20/40/60; each has one aired pilot, which Plex owns.
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"provider-cooldown-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  t.after(() => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  sqlite.savedScanState("plex").options.patch({diagnosticsEnabled:false});
  t.mock.timers.enable({apis:["Date"],now:new Date(day(0))});
  const state = { tvdbChanged:[] as number[], tvdbCooldown:false, tmdbChanged:[] as number[], tmdbCooldown:false, plexCooldown:false };
  const requests: URL[] = [];
  const unexpected: string[] = [];
  t.after(() => assert.deepEqual(unexpected,[],"every request is one the fixture expects"));
  const shows = [10,30,50].map(id=>({ratingKey:String(id),title:`Show ${id}`,Guid:[{id:`tmdb://${id}`},{id:`tvdb://${id+10}`}],updatedAt:1}));
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u);
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname === "/library/sections/1/all") return state.plexCooldown ? new Response(null,{status:429,headers:{"Retry-After":"1200"}}) : Response.json({MediaContainer:{Metadata:shows}});
      const leaves = u.pathname.match(/^\/library\/metadata\/(\d+)\/allLeaves$/);
      if(leaves) { const id = Number(leaves[1]); return Response.json({MediaContainer:{Metadata:[{ratingKey:`ep${id}`,parentIndex:1,index:1,Guid:[{id:`tmdb://${id*10}`},{id:`tvdb://${(id+10)*10}`}]}]}}); }
      return Response.json({MediaContainer:{Metadata:[shows.find(s=>u.pathname === `/library/metadata/${s.ratingKey}`)]}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:state.tmdbChanged.map(id=>({id})),total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:state.tvdbChanged.map(id=>({entityType:"series",recordId:id}))});
    const tmdb = u.pathname.match(/^\/3\/tv\/(\d+)(\/season\/1)?$/);
    if(tmdb && tmdb[2] && state.tmdbCooldown) return new Response(null,{status:503,headers:{"Retry-After":"1200"}});
    if(tmdb && tmdb[2]) return Response.json({episodes:[{id:Number(tmdb[1])*10,season_number:1,episode_number:1,name:"Pilot",air_date:"2020-01-01"}]});
    if(tmdb) return Response.json({id:Number(tmdb[1]),name:`Show ${tmdb[1]}`,seasons:[{season_number:1}],external_ids:{tvdb_id:Number(tmdb[1])+10}});
    const tvdb = u.pathname.match(/^\/v4\/series\/(\d+)(\/episodes\/default)?$/);
    if(tvdb && tvdb[2] && state.tvdbCooldown) return new Response(null,{status:503,headers:{"Retry-After":"1200"}});
    if(tvdb && tvdb[2]) return Response.json({data:{episodes:[{id:Number(tvdb[1])*10,seasonNumber:1,number:1,name:"Pilot",aired:"2020-01-01"}]}});
    if(tvdb) return Response.json({data:{id:Number(tvdb[1]),name:`Show ${Number(tvdb[1])-10}`,slug:`show-${tvdb[1]}`}});
    if(/^\/v4\/episodes\/\d+\/extended$/.test(u.pathname)) return Response.json({data:{remoteIds:[]}});
    if(/\/find\/\d+$/.test(u.pathname)) return Response.json({tv_results:[],tv_episode_results:[]});
    unexpected.push(u.href);
    return Response.json({},{status:404});
  });
  const run = async (): Promise<Report> => {
    requests.length = 0;
    await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:JSON.stringify({})}));
    for(let i=0;i<500;i++) { const result = await (await scan.GET()).json(); if(result.scan.status !== "running") return result; await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out: "+JSON.stringify((await (await scan.GET()).json()).scan));
  };
  const at = (n: number) => t.mock.timers.setTime(Date.parse(day(n)));
  return {state,requests,run,at};
}

const missing = (result: Report) => Object.fromEntries(result.report.shows.map(show=>[show.title,show.missing.length]));
const tvdbRequests = (requests: URL[]) => requests.filter(u=>u.hostname.includes("thetvdb"));

test("a TVDB provider cooldown makes only TVDB unavailable: the Plex scan run completes with last-good TVDB data, and the next run sends TVDB nothing", async t => {
  const f = await fixture(t);
  const baseline = await f.run();
  assert.equal(baseline.scan.status,"completed",baseline.scan.error || "");

  f.at(1);
  f.state.tvdbChanged = [20,40,60];
  f.state.tvdbCooldown = true;
  const cooled = await f.run();
  assert.equal(cooled.scan.status,"completed",cooled.scan.error || "");
  assert.deepEqual(missing(cooled),missing(baseline),"last-good TVDB catalogues keep each show's result");
  const catalogueRequests = tvdbRequests(f.requests).filter(u=>u.pathname.endsWith("/episodes/default"));
  assert.equal(catalogueRequests.length,1,"only the first catalogue download is sent once TVDB asks for 20 minutes");
  assert.ok(f.requests.some(u=>u.hostname.includes("themoviedb")),"TMDB checks continue");
  const tvdbIssue = issues.listCoverageIssues().find(issue=>issue.provider === "TVDB" && issue.lookup?.status === 503);
  assert.ok(tvdbIssue,"a Coverage Issue records the TVDB server wait with its status");
  assert.doesNotMatch(tvdbIssue.cause,/rate limit/i,"a server wait is not reported as a rate limit");

  f.at(2);
  const next = await f.run();
  assert.equal(next.scan.status,"completed",next.scan.error || "");
  assert.deepEqual(tvdbRequests(f.requests).map(u=>u.pathname),[],"over 15 minutes remain, so this run sends TVDB nothing");
  assert.deepEqual(missing(next),missing(baseline));

  // Once the cooldown ends (a server restart forgets it), TVDB's refresh obligations from the cooled run are met.
  scanProviderClient.forgetProviderDeadlines();
  f.state.tvdbCooldown = false;
  f.state.tvdbChanged = [];
  f.at(3);
  const recovered = await f.run();
  assert.equal(recovered.scan.status,"completed",recovered.scan.error || "");
  assert.deepEqual(tvdbRequests(f.requests).filter(u=>u.pathname.endsWith("/episodes/default")).map(u=>u.pathname).sort(),["/v4/series/20/episodes/default","/v4/series/40/episodes/default","/v4/series/60/episodes/default"],"each changed TVDB catalogue is downloaded once TVDB is available again");
});

test("a TMDB provider cooldown makes only TMDB unavailable: TVDB checks continue and last-good TMDB data is kept", async t => {
  const f = await fixture(t);
  const baseline = await f.run();
  assert.equal(baseline.scan.status,"completed",baseline.scan.error || "");
  f.at(1);
  f.state.tmdbChanged = [10,30,50];
  f.state.tmdbCooldown = true;
  const cooled = await f.run();
  assert.equal(cooled.scan.status,"completed",cooled.scan.error || "");
  assert.deepEqual(missing(cooled),missing(baseline));
  assert.equal(f.requests.filter(u=>u.hostname.includes("themoviedb") && u.pathname.endsWith("/season/1")).length,1,"only the first season download is sent");
  assert.ok(tvdbRequests(f.requests).length > 0,"TVDB checks continue");
  assert.ok(issues.listCoverageIssues().some(issue=>issue.provider === "TMDB" && issue.lookup?.status === 503));
  scanProviderClient.forgetProviderDeadlines();
});

test("a Plex provider cooldown during library inventory still fails the Plex scan run", async t => {
  const f = await fixture(t);
  f.state.plexCooldown = true;
  const result = await f.run();
  assert.equal(result.scan.status,"error");
  assert.match(result.scan.error || "",/Plex requested a 20-minute cooldown/);
});
