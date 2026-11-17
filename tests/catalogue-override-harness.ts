import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
export const scan = await import("../app/api/plex/scan/route");
export const selectionRoute = await import("../app/api/plex/catalogue-selection/route");
const sqlite = await import("../lib/sqlite");
const config = await import("../lib/server-config");
export const selections = await import("../lib/catalogue-selection-store");
export const reportData = await import("../app/reports/report-data");
hook.deregister();

export const DAY = 86400_000;
const ORIGIN = Date.parse("2026-01-01T12:00:00Z");
export const day = (n: number) => new Date(ORIGIN + n * DAY).toISOString();
export type Show = {ratingKey:string;tmdbId?:number;tvdbId?:number;missing:{tmdbEpisodeId?:number;tvdbEpisodeId?:number}[];warning?:string};
export const missingTmdb = (show: Show) => show.missing.flatMap(episode => episode.tmdbEpisodeId ? [episode.tmdbEpisodeId] : []).sort((a,b)=>a-b);

/**
 * One Plex show (two when `second` is set) against fake TMDB and TVDB catalogues. TMDB series
 * `id` has `episodes` episodes with IDs id*100+n; the Plex library owns only S1E1. A held scan
 * waits inside its Plex library listing until released, so it stays active.
 */
export async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"catalogue-override-"));
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
  let second: {tmdb:number;tvdb:number} | undefined;
  const tmdb: Record<number,{episodes:number;tvdb?:number|null;fail?:boolean}> = {10:{episodes:2,tvdb:1},11:{episodes:3,tvdb:1},12:{episodes:1,tvdb:2}};
  const tvdb: Record<number,{episodes:number;fail?:boolean}> = {1:{episodes:1},2:{episodes:1},3:{episodes:2}};
  const requests: string[] = [];
  let hold: {started: () => void; released: Promise<void>} | undefined;
  const guids = (ids: {tmdb:number[];tvdb:number[]}) => [...ids.tmdb.map(id=>({id:`tmdb://${id}`})),...ids.tvdb.map(id=>({id:`tvdb://${id}`}))];
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request) => {
    const u = new URL(String(input)); requests.push(u.pathname);
    const shows = [{ratingKey:"1",title:"Scooby",year:1976,Guid:guids(plex),updatedAt:1},...(second ? [{ratingKey:"2",title:"Other",Guid:guids({tmdb:[second.tmdb],tvdb:[second.tvdb]}),updatedAt:1}] : [])];
    if(u.hostname === "plex") {
      if(u.pathname === "/library/sections") return Response.json({MediaContainer:{Directory:[{key:"1",type:"show"}]}});
      if(u.pathname === "/library/sections/1/all") {
        if(hold) { const current = hold; hold = undefined; current.started(); await current.released; }
        return Response.json({MediaContainer:{Metadata:shows}});
      }
      if(u.pathname.includes("allLeaves")) return Response.json({MediaContainer:{Metadata:[{ratingKey:"ep",parentIndex:1,index:1,Guid:[]}]}});
      const key = u.pathname.match(/^\/library\/metadata\/(\d+)$/)?.[1];
      return Response.json({MediaContainer:{Metadata:shows.filter(show=>show.ratingKey === key)}});
    }
    if(u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if(u.pathname === "/3/tv/changes") return Response.json({results:[],total_pages:1});
    if(u.pathname === "/v4/updates") return Response.json({data:[]});
    const tmdbShow = u.pathname.match(/^\/3\/tv\/(\d+)(\/season\/1)?$/);
    if(tmdbShow && tmdb[Number(tmdbShow[1])]) {
      const id = Number(tmdbShow[1]), series = tmdb[id];
      if(series.fail) return Response.json({status_message:"not found"},{status:404});
      if(!tmdbShow[2]) return Response.json({id,name:`TMDB ${id}`,first_air_date:`19${id}-01-01`,seasons:[{season_number:1}],external_ids:{tvdb_id:series.tvdb ?? null}});
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
  type State = {scan:{status:string;error?:string};report:{shows:Show[]};coverage:{issues:{id:string;cause?:string}[]}};
  const state = async () => (await scan.GET()).json() as Promise<State>;
  const waitForScan = async () => {
    for(let i=0;i<500;i++) { const current = await state(); if(current.scan.status !== "running") { assert.equal(current.scan.status,"completed",current.scan.error); return current; } await new Promise(r=>setTimeout(r,10)); }
    throw new Error("Scan timed out");
  };
  return {
    plex, tmdb, tvdb, identity, requests, state,
    setSecond(value: typeof second) { second = value; },
    at(value: string) { t.mock.timers.setTime(Date.parse(value)); },
    restart() { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase; },
    /** Full scan; returns the first show's result. */
    async run(key = "1"): Promise<Show> {
      requests.length = 0;
      await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
      return (await waitForScan()).report.shows.find(show=>show.ratingKey === `ratingKey:${key}`)!;
    },
    /** Start a full scan that stays active until the returned release is called. */
    async startHeldScan() {
      let started!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { started = resolve; });
      hold = {started, released: new Promise<void>(resolve => { release = resolve; })};
      await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
      await reached;
      return async () => { release(); await waitForScan(); };
    },
    async show(key = "1") { return (await state()).report.shows.find(show=>show.ratingKey === `ratingKey:${key}`)!; },
    async issues() { return (await state()).coverage.issues; },
    async select(body: unknown) {
      const response = await selectionRoute.POST(new Request("http://localhost/api/plex/catalogue-selection",{method:"POST",body:JSON.stringify(body)}));
      return {status: response.status, body: await response.json()};
    },
    tmdbDownloads(id: number) { return requests.filter(p=>p === `/3/tv/${id}/season/1`).length; },
    tvdbDownloads(id: number) { return requests.filter(p=>p === `/v4/series/${id}/episodes/default`).length; },
    selection(key = identity) { return selections.readCatalogueSelections()[key]; },
  };
}
