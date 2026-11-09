import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
const hook = registerHooks({ resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); } });
const api = await import("../app/api/plex/manual-coverage/route");
const config = await import("../lib/server-config");
hook.deregister();

test("provider-qualified episode IDs require resolving context and review canonical records atomically", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-inputs-"));
  const prior = [process.env.SHELFCHECK_DATA_DIR, process.env.SHELFCHECK_CONFIG_DIR];
  process.env.SHELFCHECK_DATA_DIR = dir;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  const cache = globalThis as typeof globalThis & {__shelfcheckDatabase?:DatabaseSync};
  t.after(() => {
    cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase;
    for (const [index,key] of ["SHELFCHECK_DATA_DIR","SHELFCHECK_CONFIG_DIR"].entries()) {
      if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index];
    }
    rmSync(dir,{recursive:true,force:true});
  });
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  let throttled = false;
  t.mock.method(globalThis,"fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (throttled && u.hostname === "api.themoviedb.org") return Response.json({error:"cooldown"},{status:429,headers:{"Retry-After":"3600"}});
    if (u.pathname === "/3/tv/10/season/0/episode/2") return Response.json({id:100,name:"Combined special",season_number:0,episode_number:2});
    if (u.pathname === "/3/tv/10") return Response.json({id:10,name:"First show"});
    if (u.pathname === "/v4/login") return Response.json({data:{token:"test"}});
    if (u.pathname === "/v4/episodes/200/extended") return Response.json({data:{id:200,seriesId:20,name:"Other special",seasonNumber:8,number:9}});
    if (u.pathname === "/v4/series/20") return Response.json({data:{id:20,name:"Second show",slug:"second"}});
    if (u.pathname === "/v4/episodes/999/extended") return Response.json({error:"not found"},{status:404});
    if (u.pathname === "/v4/episodes/20/extended") return Response.json({data:{id:20,name:"Show record",slug:"second"}});
    throw new Error("Unexpected HTTP: " + u);
  });
  const resolve = (urls:string[]) => api.POST(new Request("http://localhost/api/plex/manual-coverage",{method:"POST",body:JSON.stringify({action:"resolve",urls})}));
  const result = await resolve(["tmdb:100 show:10 season:0 episode:2","tvdb:200"]);
  assert.equal(result.status,200,await result.clone().text());
  const preview = await result.json();
  assert.deepEqual(preview.members,[
    {provider:"TMDB",id:100,showId:10,show:"First show",title:"Combined special",season:0,episode:2,url:"https://www.themoviedb.org/tv/10/season/0/episode/2"},
    {provider:"TVDB",id:200,showId:20,show:"Second show",title:"Other special",season:8,episode:9,url:"https://thetvdb.com/series/second/episodes/200"}
  ]);
  for (const [inputs, message] of [
    [["tmdb:100", "tvdb:200"], /episode URL or context/],
    [["tmdb:101 show:10 season:0 episode:2", "tvdb:200"], /resolved episode 100, not 101/],
    [["https://www.themoviedb.org/tv/10", "tvdb:200"], /not an episode/],
    [["https://www.themoviedb.org/tv/10/season/0/episode/2", "https://thetvdb.com/series/second"], /not an episode/],
    [["not a URL", "tvdb:200"], /provider.*ID|episode URL/],
    [["tmdb:100 show:10 season:0 episode:2", "tvdb:20"], /could not resolve that episode/],
    [["tmdb:100 show:10 season:0 episode:2", "tvdb:999"], /Check.*episode.*credentials/],
  ] as [string[], RegExp][]) {
    const failed = await resolve(inputs);
    assert.ok(!failed.ok);
    assert.match((await failed.json()).error, message);
    assert.deepEqual((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings, []);
  }
  const forgedSave = await api.POST(new Request("http://localhost/api/plex/manual-coverage", {method:"POST",body:JSON.stringify({action:"save",preview:"not-issued"})}));
  assert.equal(forgedSave.status,400);
  assert.deepEqual((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings, []);
  throttled=true;
  assert.equal((await resolve(["tmdb:100 show:10 season:0 episode:2","tvdb:200"])).status,503);
  throttled=false;
  assert.equal((await resolve(["tmdb:100 show:10 season:0 episode:2","tvdb:200"])).status,200,"a later provider-resolution attempt can recover after an outage");
  await config.writePlexProviders({tmdbToken:null});
  const unconfigured = await resolve(["tmdb:100 show:10 season:0 episode:2","tvdb:200"]);
  assert.equal(unconfigured.status,409);
  assert.equal((await unconfigured.json()).code,"configuration");
});
