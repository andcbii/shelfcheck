import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const scan = await import("../app/api/plex/scan/route");
const ignoreResults = await import("../lib/ignore-results");
const config = await import("../lib/server-config");
const selections = await import("../lib/catalogue-selection-store");
hook.deregister();

test("scans compare the lowest Plex series ID or the saved override, reconciling removals from complete observations", async t => {
  const dir = mkdtempSync(path.join(tmpdir(),"catalogue-selection-"));
  const previous = [process.env.SHELFCHECK_DATA_DIR,process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir; process.env.SHELFCHECK_CONFIG_DIR = dir;
  const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
  t.after(() => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    for (const [i,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) { if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    rmSync(dir,{recursive:true,force:true}); });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  ignoreResults.savedScanState("plex").options.patch({diagnosticsEnabled:false});
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-11-11T12:00:00Z")});
  const identity = "ratingKey:1";
  let guids = ["tmdb://10","tvdb://21","tmdb://9","tvdb://20","tmdb://9"];
  let unusableDetails = false;
  const requests: string[] = [];
  const tmdb: Record<string,{name:string;episodes:{id:number;episode_number:number}[]}> = {
    "9": {name:"Dynomutt Hour",episodes:[{id:900,episode_number:1}]},
    "10": {name:"Scooby-Doo Show",episodes:[{id:1000,episode_number:1},{id:1001,episode_number:2}]},
  };
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u.pathname);
    const show = {ratingKey:"1",title:"Scooby",Guid:guids.map(id=>({id})),updatedAt:1};
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname === "/library/sections/1/all") return Response.json({MediaContainer:{Metadata:[show]}});
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:[{ratingKey:"ep",parentIndex:1,index:1,Guid:[{id:"tvdb://200"}]}]}});
      return Response.json({MediaContainer:{Metadata:unusableDetails ? [] : [show]}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:[],total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:[]});
    const tmdbShow = u.pathname.match(/^\/3\/tv\/(\d+)$/);
    if(tmdbShow && tmdb[tmdbShow[1]]) return Response.json({id:Number(tmdbShow[1]),name:tmdb[tmdbShow[1]].name,seasons:[{season_number:1}],external_ids:{tvdb_id:20}});
    const season = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/1$/);
    if(season && tmdb[season[1]]) return Response.json({episodes:tmdb[season[1]].episodes.map(episode=>({...episode,season_number:1,name:`Episode ${episode.episode_number}`,air_date:"2020-01-01"}))});
    const series = u.pathname.match(/^\/v4\/series\/(20|21)$/);
    if(series) return Response.json({data:{id:Number(series[1]),name:`TVDB ${series[1]}`,slug:`tvdb-${series[1]}`}});
    if(u.pathname === "/v4/series/20/episodes/default") return Response.json({data:{episodes:[{id:200,seasonNumber:1,number:1,name:"Episode 1",aired:"2020-01-01"}]}});
    if(u.pathname.includes("/find/")) return Response.json({tv_results:[],tv_episode_results:[]});
    throw new Error("Unexpected HTTP: "+u);
  });
  const run = async () => {
    requests.length = 0;
    t.mock.timers.tick(60_000);
    await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
    for(let i=0;i<500;i++) { const state = await (await scan.GET()).json(); if(state.scan.status !== "running") { assert.equal(state.scan.status,"completed",state.scan.error); return state.report.shows[0]; } await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out");
  };

  let result = await run();
  assert.equal(result.tmdbId,9,"9 sorts before 10");
  assert.equal(result.tvdbId,20);
  assert.deepEqual(result.missing,[]);
  assert.ok(!requests.includes("/v4/series/21/episodes/default"));
  const named = selections.readCatalogueSelections()[identity];
  assert.deepEqual(named.tmdb.candidates,[{id:9,name:"Dynomutt Hour"},{id:10,name:"Scooby-Doo Show"}]);
  assert.deepEqual(named.tvdb.candidates,[{id:20,name:"TVDB 20"},{id:21,name:"TVDB 21"}]);
  assert.equal(named.tmdb.current?.usingId,9);
  assert.deepEqual(result.catalogueSelection,named,"results carry the persisted selection for their notice");

  guids = [...guids].reverse();
  result = await run();
  assert.equal(result.tmdbId,9,"reversed GUID order keeps the TMDB choice");
  assert.equal(result.tvdbId,20,"reversed GUID order keeps the TVDB choice");

  selections.saveCatalogueOverride(identity,"tmdb",10);
  result = await run();
  assert.equal(result.tmdbId,10);
  assert.deepEqual(result.missing.map((episode:{tmdbEpisodeId?:number})=>episode.tmdbEpisodeId),[1001]);
  assert.equal(result.tvdbId,20,"a TMDB override leaves the TVDB choice alone");

  unusableDetails = true;
  guids = ["tmdb://9","tvdb://20"];
  result = await run();
  assert.equal(result.tmdbId,10,"metadata without a usable record is not evidence of removal");
  assert.equal(selections.readCatalogueSelections()[identity].tmdb.override,10);

  unusableDetails = false;
  result = await run();
  assert.equal(result.tmdbId,9,"a complete observation removing a candidate clears the override");
  const reconciled = selections.readCatalogueSelections()[identity];
  assert.equal(reconciled.tmdb.override,undefined);
  assert.deepEqual(reconciled.tmdb.candidates.map(candidate=>candidate.id),[9]);
  assert.deepEqual(reconciled.tvdb.candidates.map(candidate=>candidate.id),[20]);
});
