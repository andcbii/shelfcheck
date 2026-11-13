import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
const hook = registerHooks({ resolve(s, c, next) {
    return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c);
  } });
const api = await import("../app/api/plex/manual-coverage/route");
const sqlite = await import("../lib/sqlite");
const config = await import("../lib/server-config");
const scan = await import("../app/api/plex/scan/route");
hook.deregister();
test("complete-set Manual Matches cover equivalent owned content in both directions without ownership corrections", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  const cache = globalThis as typeof globalThis & {
    __shelfcheckDatabase?: DatabaseSync;
  };
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previous === undefined)
      delete process.env.SHELFCHECK_DATA_DIR;
    else
      process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const previousConfig = process.env.SHELFCHECK_CONFIG_DIR;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  t.after(() => {
    if (previousConfig === undefined)
      delete process.env.SHELFCHECK_CONFIG_DIR;
    else
      process.env.SHELFCHECK_CONFIG_DIR = previousConfig;
  });
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "test", tvdbApiKey: "test" });
  let owned = false;
  let inferredSource = false;
  let parts = [11551379];
  let sourceProvider = "tvdb";
  let expandedTarget = false;
  let ambiguous = false;
  let contentVersion = 1;
  let blockSeason = false;
  let unblock!: () => void;
  let entered!: () => void;

  const show = { ratingKey: "1", title: "Target", Guid: [{ id: "tmdb://10" }], updatedAt: 1 };
  const source = { ratingKey: "2", title: "Ignored source", Guid: [{ id: "tvdb://20" }], updatedAt: 1 };
  sqlite.writePlexSettings({ ignoredShows: [{ ratingKey: "ratingKey:2", title: "Ignored source" }], diagnosticsEnabled: false });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    let body: unknown;
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections")
        body = { MediaContainer: { Directory: [{ key: "1", type: "show" }, { key: "2", type: "show" }] } };
      else if (u.pathname.includes("/sections/"))
        body = { MediaContainer: { Metadata: u.pathname.includes("/sections/1/") ? [show] : [source] } };
      else if (u.pathname.includes("allLeaves"))
        body = { MediaContainer: { Metadata: inferredSource && u.pathname.includes("/1/") ? [{ratingKey:"direct-X",parentIndex:99,index:99,Guid:[{id:"tmdb://6741845"}]}] : u.pathname.includes("/2/") && owned ? parts.map(id => ({ ratingKey: `part-${id}`, updatedAt: contentVersion, parentIndex: 8, index: id, Guid: [{ id: `${sourceProvider}://${id}` }, ...(ambiguous ? [{id:"tmdb://6741845"}] : [])] })) : [{ ratingKey: "unrelated", parentIndex: 99, index: 99 }] } };
      else
        body = { MediaContainer: { Metadata: [show] } };
    }
    else if (u.pathname === "/3/tv/10")
      body = { id: 10, name: "Target", seasons: [{ season_number: 1 }] };
    else if (u.pathname === "/3/tv/10/season/1") {
      if (blockSeason) {
        entered();
        await blocked;
      }
      body = { episodes: [...(expandedTarget ? [{id:101,season_number:1,episode_number:2,name:"Second target",air_date:"2020-01-01"}] : []), { id: 6741845, season_number: 1, episode_number: 1, name: "Missing", air_date: "2020-01-01" }] };
    }
    else if (u.pathname === "/3/tv/10/season/1/episode/1")
      body = { id: 6741845, season_number: 1, episode_number: 1, name: "Missing" };
    else if (u.pathname === "/3/tv/10/season/1/episode/2")
      body = { id: 101, season_number: 1, episode_number: 2, name: "Independent" };
    else if (u.pathname === "/v4/episodes/11551380/extended")
      body = { data: { id: 11551380, seriesId: 20, seasonNumber: 0, number: 3, name: "Part two" } };
    else if (u.pathname === "/v4/episodes/202/extended")
      body = { data: { id: 202, seriesId: 20, seasonNumber: 10, number: 10, name: "Replacement equivalent" } };
    else if (u.pathname === "/v4/episodes/201/extended")
      body = { data: { id: 201, seriesId: 20, seasonNumber: 9, number: 9, name: "Independent equivalent" } };
    else if (u.pathname === "/v4/login")
      body = { data: { token: "test" } };
    else if (u.pathname === "/v4/episodes/11551379/extended")
      body = { data: { id: 11551379, seriesId: 20, seasonNumber: 8, number: 8, name: "Equivalent" } };
    else if (u.pathname === "/v4/series/20/episodes/default")
      body = { data: { episodes: [{id:11551380,seasonNumber:1,number:3,name:"Part two",aired:"2020-01-01"}, { id: 11551379, seasonNumber: 8, number: 8, name: "Equivalent", aired: "2020-01-01" }] } };
    else if (u.pathname === "/v4/series/20")
      body = { data: { id: 20, name: "Other show", slug: "other-show" } };
    else if (u.pathname === "/3/tv/changes")
      body = { results: [], total_pages: 1 };
    else if (u.pathname === "/v4/updates")
      body = { data: [] };
    else if (u.pathname.includes("/find/"))
      body = { tv_results: [], tv_episode_results: inferredSource && u.pathname.endsWith("/11551379") ? [{id:6741845,show_id:10,season_number:1,episode_number:1}] : [] };
    else
      throw new Error("Unexpected HTTP: " + u);
    return Response.json(body);
  });
  const request = (body: unknown) => new Request("http://localhost/api/plex/manual-coverage", { method: "POST", body: JSON.stringify(body) });
  const state = async () => (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  const wait = async () => { for (let i=0;i<500;i++) { const result=await (await scan.GET()).json(); if(result.scan.status!=="running") { assert.equal(result.scan.status,"completed",result.scan.error); return result; } await new Promise(r=>setTimeout(r,10)); } throw Error("timeout"); };
  const resolve = async (urls:string[]) => { const response=await api.POST(request({action:"resolve",urls})); assert.equal(response.status,200,await response.clone().text()); return response.json(); };
  const preview=await resolve(["tmdb:6741845 show:10 season:1 episode:1","tvdb:11551379","tvdb:11551380"]);
  const response=await api.POST(request({action:"save",preview:preview.preview}));
  assert.equal(response.status,201);
  const mapping=(await response.json()).mapping;
  await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));
  await wait();
  owned=true;
  const rescan=async()=>{await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"})); return wait();};
  const incomplete = await rescan();
  assert.equal(incomplete.report.shows[0].missing[0].tmdbEpisodeId,6741845,"one part cannot complete the source set");
  assert.equal(incomplete.report.coverageGroups.length, 1);
  assert.deepEqual(incomplete.report.coverageGroups[0].members.map((m: {id:number,status:string}) => [m.id,m.status]), [[6741845,"missing"],[11551379,"direct"],[11551380,"alternative"]]);
  assert.equal(incomplete.report.coverageGroups[0].mappingId,mapping.id);
  ambiguous=true;
  const partialMixed=await rescan();
  assert.equal(partialMixed.report.shows[0].missing[0]?.tmdbEpisodeId,6741845,"a part also reporting the combined identity cannot stand in for the missing part");
  assert.equal(partialMixed.report.shows[0].manualCoverage,undefined);
  ambiguous=false;
  parts=[11551379,11551380];
  const complete = await rescan();
  assert.deepEqual(complete.report.shows[0].missing,[]);
  assert.deepEqual(complete.report.coverageGroups,[]);
  assert.ok((await state()).mappings.some((m:{id:string})=>m.id===mapping.id),"complete mappings remain in the manager");
  // Reverse direction: a single combined item covers both parts, including when
  // the same Plex item also carries a split identity.
  show.Guid=[{id:"tvdb://20"}]; source.Guid=[{id:"tmdb://10"}];
  parts=[6741845]; sourceProvider="tmdb";
  await scan.DELETE(new Request("http://localhost/api/plex/scan",{method:"DELETE"}));
  assert.deepEqual((await rescan()).report.shows[0].missing,[]);
  parts=[11551379]; sourceProvider="tvdb"; ambiguous=true;
  const mixed=await rescan();
  assert.deepEqual(mixed.report.shows[0].missing,[],"a combined episode also reporting a split identity covers every mapped part");
  assert.deepEqual(mixed.report.shows[0].manualCoverage.map((item:{mappingId:string})=>item.mappingId),[mapping.id]);
  ambiguous=false;
  const partialReverse=await rescan();
  assert.deepEqual(partialReverse.report.shows[0].missing.map((e:{tvdbEpisodeId:number})=>e.tvdbEpisodeId),[11551380,11551379],"one part held outside the target show grants no Manual Match coverage for either part");
  assert.equal(partialReverse.report.shows[0].manualCoverage,undefined);

  // The obsolete ownership-correction mutation is no longer accepted.
  ambiguous=true; await rescan();
  const beforeObsolete=await state();
  assert.equal("corrections" in beforeObsolete.mappings[0],false,"no correction display state is returned");
  assert.ok(beforeObsolete.mappings[0].evidence.length,"independently useful inventory evidence remains available");
  const obsolete=await api.POST(request({action:"correct",mappingId:mapping.id,revision:beforeObsolete.revision,item:beforeObsolete.mappings[0].evidence[0],identities:[{provider:"TVDB",id:11551379}]}));
  assert.equal(obsolete.status,400);
  assert.equal((await obsolete.json()).code,"unsupported-action");
  assert.deepEqual(await state(),beforeObsolete);
  assert.equal((await (await scan.GET()).json()).scan.status,"completed","the rejected mutation starts no recheck or scan");
  sqlite.clearPlexReport(); cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase;
  assert.deepEqual((await state()).mappings.map((m:{id:string})=>m.id),[mapping.id],"mappings survive restart");
  // Edits and an unrelated batch deletion retain the complete-set mapping.
  const unchanged=await api.POST(request({action:"save",id:mapping.id,revision:mapping.revision,preview:preview.preview}));
  assert.equal(unchanged.status,200); mapping.revision=(await unchanged.json()).mapping.revision; await wait();
  const independentPreview=await resolve(["tmdb:101 show:10 season:1 episode:2","tvdb:201"]);
  const independent=await (await api.POST(request({action:"save",preview:independentPreview.preview}))).json(); await wait();
  const batchDelete=await api.DELETE(new Request("http://localhost/api/plex/manual-coverage",{method:"DELETE",body:JSON.stringify({ids:[independent.mapping.id,"already-removed"]})}));
  const batchResult=await batchDelete.json();
  assert.deepEqual(batchResult.deleted,[independent.mapping.id]);
  assert.deepEqual(batchResult.missing,["already-removed"]);
  await wait();
  contentVersion++;
  assert.deepEqual((await rescan()).report.shows[0].missing,[],"changed Plex content needs no repeated ownership declaration");
  const expanded=await resolve(["tmdb:6741845 show:10 season:1 episode:1","tmdb:101 show:10 season:1 episode:2","tvdb:11551379","tvdb:11551380"]);
  const edit=await api.POST(request({action:"save",id:mapping.id,revision:mapping.revision,preview:expanded.preview}));
  assert.equal(edit.status,200); mapping.revision=(await edit.json()).mapping.revision; await wait();
  ambiguous=false; parts=[6741845]; sourceProvider="tmdb";
  assert.equal((await rescan()).report.shows[0].missing.length,2,"many-to-many needs every directly held member");
  parts=[6741845,101];
  assert.deepEqual((await rescan()).report.shows[0].missing,[]);
  // Both TVDB parts cover both TMDB records in the other direction.
  show.Guid=[{id:"tmdb://10"}]; source.Guid=[{id:"tvdb://20"}]; expandedTarget=true;
  parts=[11551379]; sourceProvider="tvdb";
  await scan.DELETE(new Request("http://localhost/api/plex/scan",{method:"DELETE"}));
  assert.equal((await rescan()).report.shows[0].missing.length,2);
  parts=[11551379,11551380]; assert.deepEqual((await rescan()).report.shows[0].missing,[]);
  const manyToOne=await resolve(["tmdb:6741845 show:10 season:1 episode:1","tmdb:101 show:10 season:1 episode:2","tvdb:11551379"]);
  const manySave=await api.POST(request({action:"save",id:mapping.id,revision:mapping.revision,preview:manyToOne.preview}));
  assert.equal(manySave.status,200); mapping.revision=(await manySave.json()).mapping.revision; await wait();
  parts=[11551379]; assert.deepEqual((await rescan()).report.shows[0].missing,[]);
  // A held part that also reports a combined identity still completes its one-member side.
  ambiguous=true;
  assert.deepEqual((await rescan()).report.shows[0].missing,[],"a mixed-identity item retains the complete TVDB side");
  // Mapping saves during an active scan are rejected without changing saved state.
  const blocked=new Promise<void>(resolve=>{unblock=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;}); blockSeason=true;
  await scan.DELETE(new Request("http://localhost/api/plex/scan",{method:"DELETE"}));
  await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"})); await started;
  const current=await state();
  const duringScan=await api.POST(request({action:"save",id:mapping.id,revision:mapping.revision,preview:manyToOne.preview}));
  assert.equal(duringScan.status,409);
  assert.equal((await duringScan.json()).code,"scan-active");
  const obsoleteDuringScan=await api.POST(request({action:"correct",mappingId:mapping.id,revision:current.revision,item:current.mappings[0].evidence[0],identities:[{provider:"TMDB",id:6741845}]}));
  assert.equal(obsoleteDuringScan.status,400);
  assert.deepEqual(await state(),current);
  blockSeason=false;unblock();
  await wait();
  ambiguous=false;


  // X is directly held and automatically satisfies Y, but Y is not direct
  // inventory and therefore cannot satisfy Z through a separate explicit link.
  const noChain=await resolve(["tmdb:101 show:10 season:1 episode:2","tvdb:11551379"]);
  const chainEdit=await api.POST(request({action:"save",id:mapping.id,revision:mapping.revision,preview:noChain.preview}));
  assert.equal(chainEdit.status,200); await wait();
  inferredSource=true; owned=false; show.Guid=[{id:"tmdb://10"},{id:"tvdb://20"}];
  await scan.DELETE(new Request("http://localhost/api/plex/scan",{method:"DELETE"}));
  const noChaining=await rescan();
  assert.ok(noChaining.report.shows[0].autoMatches.some((match:{tvdb:{id:number}})=>match.tvdb.id===11551379),"Y is satisfied by its normal automatic crosswalk");
  assert.ok(noChaining.report.shows[0].missing.some((episode:{tmdbEpisodeId:number})=>episode.tmdbEpisodeId===101),"Z remains missing because inferred Y is not directly owned");
  assert.equal(noChaining.report.shows[0].manualCoverage,undefined);
  assert.deepEqual(noChaining.report.coverageGroups[0].members.map((m:{id:number,status:string})=>[m.id,m.status]),[[101,"missing"],[11551379,"automatic"]]);

});
