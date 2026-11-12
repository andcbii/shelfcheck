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
test("reviewed one-to-one mappings are durable and membership conflicts leave saved mappings intact", async (t) => {
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
  let unavailableSource = false;
  let healthFailure = 0;
  let movedTmdb = false;
  let missingTmdbCoordinate = false;
  let reverse = false;
  let owned = false;
  let sourceId = 200;
  let automatic = false;
  let blockSeason = false;
  let unblock!: () => void;
  let entered!: () => void;
  let blocked = new Promise<void>(resolve => {
    unblock = resolve;
  });
  let started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const show = { ratingKey: "1", title: "Target", Guid: [{ id: "tmdb://10" }], updatedAt: 1 };
  const source = { ratingKey: "2", title: "Ignored source", Guid: [{ id: "tvdb://20" }], updatedAt: 1 };
  sqlite.writePlexSettings({ ignoredShows: [{ ratingKey: "ratingKey:2", title: "Ignored source" }], diagnosticsEnabled: false });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === "/v4/episodes/200/extended" && healthFailure) return Response.json({}, {status: healthFailure, headers: healthFailure === 429 ? {"Retry-After":"86400"} : undefined});
    if (u.pathname === "/3/tv/10/season/1/episode/1" && missingTmdbCoordinate) return Response.json({}, {status:404});
    if (u.pathname === "/3/tv/10/season/1/episode/1" && movedTmdb) return Response.json({id:999,season_number:1,episode_number:1,name:"Similar title"});
    let body: unknown;
    if (u.hostname === "plex") {
      if (unavailableSource && u.pathname.includes("/2/allLeaves")) return Response.json({error:"Plex source unavailable"},{status:404});
      if (u.pathname === "/library/sections")
        body = { MediaContainer: { Directory: [{ key: "1", type: "show" }, { key: "2", type: "show" }] } };
      else if (u.pathname.includes("/sections/"))
        body = { MediaContainer: { Metadata: u.pathname.includes("/sections/1/") ? [show] : [source] } };
      else if (u.pathname.includes("allLeaves"))
        body = { MediaContainer: { Metadata: u.pathname.includes("/2/") && owned ? [{ ratingKey: "owned", updatedAt: 1, parentIndex: 8, index: 8, Guid: [{ id: reverse ? "tmdb://100" : `tvdb://${sourceId}` }] }] : automatic ? [{ ratingKey: "automatic", parentIndex: 99, index: 99, Guid: [{ id: "tmdb://100" }] }] : [{ ratingKey: "unrelated", updatedAt: 1, parentIndex: 99, index: 99 }] } };
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
      body = { episodes: [{ id: 100, season_number: 1, episode_number: 1, name: "Missing", air_date: "2020-01-01" }] };
    }
    else if (u.pathname === "/3/tv/10/season/1/episode/1")
      body = { id: 100, season_number: 1, episode_number: 1, name: "Missing" };
    else if (u.pathname === "/3/tv/10/season/1/episode/3")
      body = { id: 102, season_number: 1, episode_number: 3, name: "Cleanup" };
    else if (u.pathname === "/v4/episodes/203/extended")
      body = { data: { id: 203, seriesId: 20, seasonNumber: 10, number: 11, name: "Cleanup equivalent" } };
    else if (u.pathname === "/3/tv/10/season/1/episode/2")
      body = { id: 101, season_number: 1, episode_number: 2, name: "Independent" };
    else if (u.pathname === "/v4/episodes/202/extended")
      body = { data: { id: 202, seriesId: 20, seasonNumber: 10, number: 10, name: "Replacement equivalent" } };
    else if (u.pathname === "/v4/episodes/201/extended")
      body = { data: { id: 201, seriesId: 20, seasonNumber: 9, number: 9, name: "Independent equivalent" } };
    else if (u.pathname === "/v4/login")
      body = { data: { token: "test" } };
    else if (u.pathname === "/v4/episodes/200/extended")
      body = { data: { id: 200, seriesId: 20, seasonNumber: 8, number: 8, name: "Equivalent" } };
    else if (u.pathname === "/v4/series/20/episodes/default")
      body = { data: { episodes: [{ id: 200, seasonNumber: 8, number: 8, name: "Equivalent", aired: "2020-01-01" }] } };
    else if (u.pathname === "/v4/series/20")
      body = { data: { id: 20, name: "Other show", slug: "other-show" } };
    else if (u.pathname === "/3/tv/changes")
      body = { results: [], total_pages: 1 };
    else if (u.pathname === "/v4/updates")
      body = { data: [] };
    else if (u.pathname.includes("/find/"))
      body = { tv_results: [], tv_episode_results: [] };
    else
      throw new Error("Unexpected HTTP: " + u);
    return Response.json(body);
  });
  const member = (provider: string, id: number) => ({ provider, id, showId: 1, show: "Example", title: "Pilot", season: 1, episode: 1, url: "https://example.com" });
  const request = (body: unknown) => new Request("http://localhost/api/plex/manual-coverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // Resolve is separately exercised against fixture HTTP; saving requires the server-issued preview token.
  const forged = await api.POST(request({ members: [member("TMDB", 1), member("TVDB", 2)] }));
  assert.equal(forged.status, 400);
  assert.deepEqual((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings, []);
  const invalid = await api.POST(request({ action: "resolve", urls: ["https://www.themoviedb.org/tv/10", "https://thetvdb.com/series/other-show/episodes/200"] }));
  assert.equal(invalid.status, 400);
  assert.deepEqual((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings, []);
  const previewResponse = await api.POST(request({ action: "resolve", urls: ["tmdb:100 show:10 season:1 episode:1", "tvdb:200"] }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.deepEqual(preview.members.map((m: {
    provider: string;
    id: number;
    show: string;
  }) => [m.provider, m.id, m.show]), [["TMDB", 100, "Target"], ["TVDB", 200, "Other show"]]);
  const savedResponse = await api.POST(request({ action: "save", preview: preview.preview }));
  assert.equal(savedResponse.status, 201);
  const saved = await savedResponse.json();
  const wait = async () => {
    for (let i = 0; i < 300; i++) {
      const response = await (await scan.GET()).json();
      if (response.scan.status !== "running")
        return response;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error("scan timeout");
  };
  const initialPending=await (await scan.GET()).json();
  assert.notEqual(initialPending.scan.status,"running","Saving before initial inventory must not start a scan");
  assert.ok(initialPending.coverage.issues.some((issue:{id:string})=>issue.id==="comparison-inputs:initial"));
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const beforeOwnership = await wait();
  assert.equal(beforeOwnership.scan.status, "completed", beforeOwnership.scan.error);
  assert.ok(!beforeOwnership.coverage.issues.some((issue:{id:string})=>issue.id==="comparison-inputs:initial"));
  assert.equal(beforeOwnership.report.shows[0].missing[0].tmdbEpisodeId, 100);
  assert.equal((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings.length, 1);
  // A standalone mapping created with neither side held applies after holdings change.
  owned = true;
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const covered = await wait();
  assert.equal(covered.scan.status, "completed", covered.scan.error);
  assert.deepEqual(covered.report.shows[0].missing, []);
  assert.equal(covered.report.shows.length, 1);
  assert.equal(covered.report.shows[0].manualCoverage[0].mappingId, saved.mapping.id);
  const selected = await (await api.POST(request({ action: "resolve", urls: ["https://www.themoviedb.org/tv/10/season/1/episode/1", "https://thetvdb.com/series/other-show/episodes/202"] }))).json();
  assert.equal(selected.existingMapping.id, saved.mapping.id);
  const conflict = await api.POST(request({ action: "save", preview: preview.preview }));
  assert.equal(conflict.status, 409);
  assert.equal((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings.length, 1);
  const otherPreviewResponse = await api.POST(request({ action: "resolve", urls: ["https://www.themoviedb.org/tv/10/season/1/episode/2", "https://thetvdb.com/series/other-show/episodes/201"] }));
  assert.equal(otherPreviewResponse.status, 200);
  const otherPreview = await otherPreviewResponse.json();
  const otherSavedResponse = await api.POST(request({ action: "save", preview: otherPreview.preview }));
  assert.equal(otherSavedResponse.status, 201);
  const independent = await otherSavedResponse.json();
  await wait();
  // Edits retain identity, atomically claim members, and withdraw old coverage.
  const replacementPreview = await (await api.POST(request({ action: "resolve", urls: ["https://www.themoviedb.org/tv/10/season/1/episode/1", "https://thetvdb.com/series/other-show/episodes/202"] }))).json();
  const editedResponse = await api.POST(request({ action: "save", id: saved.mapping.id, revision: saved.mapping.revision, preview: replacementPreview.preview }));
  assert.equal(editedResponse.status, 200);
  const edited = await editedResponse.json();
  assert.equal(edited.mapping.id, saved.mapping.id);
  assert.equal(edited.mapping.createdAt, saved.mapping.createdAt);
  assert.ok(edited.mapping.revision > saved.mapping.revision);
  assert.equal((await wait()).report.shows[0].missing[0].tmdbEpisodeId, 100);
  const competingEdits = await Promise.all([0, 1].map(() => api.POST(request({ action: "save", id: saved.mapping.id, revision: edited.mapping.revision, preview: replacementPreview.preview }))));
  assert.deepEqual(competingEdits.map(response => response.status).sort(), [200, 409]);
  edited.mapping = (await competingEdits.find(response => response.status === 200)!.json()).mapping;
  await wait();
  const stale = await api.POST(request({ action: "save", id: saved.mapping.id, revision: saved.mapping.revision, preview: preview.preview }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "stale-revision");
  const competing = await api.POST(request({ action: "save", id: saved.mapping.id, revision: edited.mapping.revision, preview: otherPreview.preview }));
  assert.equal(competing.status, 409);
  assert.equal((await competing.json()).mappingId, independent.mapping.id);
  const rejected = await api.POST(request({ action: "save", id: saved.mapping.id, revision: edited.mapping.revision, preview: "forged" }));
  assert.equal(rejected.status, 400);
  const intact = (await (await api.GET(new Request("http://localhost/api/plex/manual-coverage?id=" + saved.mapping.id))).json()).mappings[0];
  assert.equal(intact.revision, edited.mapping.revision);
  assert.deepEqual(intact.members.map((m: {id:number}) => m.id), [100, 202]);
  sourceId = 202;
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  assert.deepEqual((await wait()).report.shows[0].missing, []);
  const restored = await api.POST(request({ action: "save", id: saved.mapping.id, revision: edited.mapping.revision, preview: preview.preview }));
  assert.equal(restored.status, 200);
  saved.mapping = (await restored.json()).mapping;
  await wait();
  sourceId = 200;
  sqlite.clearPlexReport();
  cache.__shelfcheckDatabase?.close();
  delete cache.__shelfcheckDatabase;
  assert.equal((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings.length, 2);
  // Provider outages retain identities and pending state; only native episode 404 confirms deletion.
  const mappingList = async () => (await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings;
  const rerun = async () => {
    await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
    return wait();
  };
  healthFailure = 401;
  const outage = await rerun();
  assert.equal(outage.coverage.pending, 1);
  assert.ok(outage.coverage.issues.some((issue:{operation:string;mappingId:string;provider:string;episode?:{id:number;provider:string};cause:string})=>issue.operation === "member-verification" && issue.mappingId === saved.mapping.id && issue.provider === "TVDB" && issue.episode?.provider === "TVDB" && issue.episode.id === 200 && issue.cause.includes("401")));
  assert.equal((await mappingList()).find((m: {id:string}) => m.id === saved.mapping.id).health, "pending");
  assert.equal(outage.report.shows[0].missing[0].tmdbEpisodeId, 100);
  healthFailure = 429;
  assert.equal((await rerun()).coverage.pending,1,"Long cooldowns retain pending state without deleting mappings");
  assert.equal((await mappingList()).find((m: {id:string})=>m.id===saved.mapping.id).health,"pending");
  healthFailure = 404;
  const deletedMember = await rerun();
  let broken = (await mappingList()).find((m: {id:string}) => m.id === saved.mapping.id);
  assert.equal(broken.health, "needs-review");
  const missingMember = (await (await scan.GET()).json()).coverage.issues.find((issue:{operation:string;provider:string;episode?:{id:number}})=>issue.operation === "member-verification" && issue.provider === "TVDB" && issue.episode?.id === 200);
  assert.equal(missingMember.category,"Provider Lookup");
  assert.equal(missingMember.lookup.status,404);
  assert.match(missingMember.cause,/record not found/);
  assert.doesNotMatch(missingMember.cause,/no longer exists|deleted|merged/);
  assert.deepEqual(broken.members.map((m: {id:number;title:string}) => [m.id,m.title]), [[100,"Missing"],[200,"Equivalent"]]);
  assert.equal(deletedMember.report.shows[0].missing[0].tmdbEpisodeId, 100);
  (cache.__shelfcheckDatabase as DatabaseSync | undefined)?.close();
  delete cache.__shelfcheckDatabase;
  const reopenedBroken = (await mappingList()).find((m: {id:string})=>m.id===broken.id);
  assert.equal(reopenedBroken.health,"needs-review");
  assert.deepEqual(reopenedBroken.members,broken.members);
  // Automatic decisions still apply while a mapping needs repair.
  automatic = true;
  owned = false;
  assert.deepEqual((await rerun()).report.shows[0].missing, []);
  automatic = false;
  owned = true;
  const invalidRepair = await api.POST(request({action:"resolve",id:broken.id,urls:["tmdb:100 show:10 season:1 episode:1","tvdb:200"]}));
  assert.equal(invalidRepair.status, 503);
  const afterRejectedRepair = (await mappingList()).find((m: {id:string})=>m.id===broken.id);
  assert.deepEqual(afterRejectedRepair.members,broken.members);
  assert.equal(afterRejectedRepair.revision,broken.revision);
  const expiredHealthPreview = await api.POST(request({action:"save",id:broken.id,revision:broken.revision,preview:preview.preview}));
  assert.equal(expiredHealthPreview.status,503,"A previously reviewed preview cannot save a now-deleted member");
  assert.equal((await mappingList()).find((m: {id:string})=>m.id===broken.id).revision,broken.revision);
  healthFailure = 0;
  // Health stays Needs review until a user resolves and reviews a whole replacement.
  await rerun();
  assert.equal((await mappingList()).find((m: {id:string})=>m.id===broken.id).health,"needs-review");
  const repairPreview = await (await api.POST(request({action:"resolve",id:broken.id,urls:["tmdb:100 show:10 season:1 episode:1","tvdb:202"]}))).json();
  const repairResponse = await api.POST(request({action:"save",id:broken.id,revision:broken.revision,preview:repairPreview.preview}));
  assert.equal(repairResponse.status,200);
  saved.mapping = (await repairResponse.json()).mapping;
  sourceId = 202;
  assert.deepEqual((await rerun()).report.shows[0].missing, []);
  assert.ok(saved.mapping.revision > broken.revision);
  assert.notEqual(saved.mapping.health,"needs-review");
  // Coordinates returning another ID cannot silently replace the saved canonical TMDB member.
  movedTmdb = true;
  const moved = await rerun();
  assert.equal(moved.coverage.pending,1);
  broken = (await mappingList()).find((m: {id:string})=>m.id===broken.id);
  assert.equal(broken.health,"pending");
  assert.deepEqual(broken.members.map((m: {id:number})=>m.id),[100,202]);
  movedTmdb = false;
  missingTmdbCoordinate = true;
  assert.equal((await rerun()).coverage.pending,1);
  assert.equal((await mappingList()).find((m: {id:string})=>m.id===broken.id).health,"pending","A TMDB coordinate 404 cannot prove canonical deletion");
  missingTmdbCoordinate = false;
  await rerun();
  assert.equal((await mappingList()).find((m: {id:string})=>m.id===broken.id).health,"healthy");
  const returnPreview = await (await api.POST(request({action:"resolve",id:broken.id,urls:["tmdb:100 show:10 season:1 episode:1","tvdb:200"]}))).json();
  const current = (await mappingList()).find((m: {id:string})=>m.id===broken.id);
  saved.mapping = (await (await api.POST(request({action:"save",id:current.id,revision:current.revision,preview:returnPreview.preview}))).json()).mapping;
  sourceId = 200;
  await rerun();
  // Automatic ownership keeps its existing result and is not relabelled manual.
  automatic = true;
  owned = false;
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const automaticReport = await wait();
  assert.deepEqual(automaticReport.report.shows[0].missing, []);
  assert.equal(automaticReport.report.shows[0].manualCoverage, undefined);
  automatic = false;
  owned = true;
  // The same saved mapping works in the opposite direction across shows and seasons.
  reverse = true;
  show.Guid = [{ id: "tvdb://20" }];
  source.Guid = [{ id: "tmdb://10" }];
  await scan.DELETE(new Request("http://localhost/api/plex/scan", { method: "DELETE" }));
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const opposite = await wait();
  assert.deepEqual(opposite.report.shows[0].missing, []);
  assert.equal(opposite.report.shows[0].manualCoverage[0].source[0].identities[0].provider, "TMDB");
  unavailableSource = true;
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const unavailable = await wait();
  assert.equal(unavailable.coverage.pending, 1, "An unavailable ignored source must leave the coverage recheck actionable");
  unavailableSource = false;
  // Inferred outcomes never supply prerequisites; removing directly held content exposes the gap.
  owned = false;
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const absent = await wait();
  assert.equal(absent.report.shows[0].missing[0].tvdbEpisodeId, 200);
  // Mutations opened before a scan are rejected without applying or queueing work.
  reverse = false;
  owned = true;
  show.Guid = [{ id: "tmdb://10" }];
  source.Guid = [{ id: "tvdb://20" }];
  blockSeason = true;
  blocked = new Promise<void>(resolve => {
    unblock = resolve;
  });
  started = new Promise<void>(resolve => {
    entered = resolve;
  });
  await scan.DELETE(new Request("http://localhost/api/plex/scan", { method: "DELETE" }));
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  await started;
  const activeEdit = await api.POST(request({ action: "save", id: saved.mapping.id, revision: saved.mapping.revision, preview: replacementPreview.preview }));
  assert.equal(activeEdit.status, 409);
  assert.equal((await activeEdit.json()).code,"scan-active");
  const pending = await (await scan.GET()).json();
  assert.equal(pending.coverage.pending, 1);
  assert.equal((await mappingList()).find((m: {id:string})=>m.id===saved.mapping.id).revision,saved.mapping.revision);
  blockSeason = false;
  unblock();
  await wait();
  const acceptedEdit=await api.POST(request({ action:"save",id:saved.mapping.id,revision:saved.mapping.revision,preview:replacementPreview.preview }));
  assert.equal(acceptedEdit.status,200);
  const missing = await wait();
  assert.equal(missing.scan.status, "completed", missing.scan.error);
  assert.equal(missing.report.shows[0].missing[0].tmdbEpisodeId, 100);
  // Bulk cleanup captures explicit identities, withdraws coverage during an active
  // scan, and advances the batch revision once without touching unselected rows.
  const cleanupPreview = await (await api.POST(request({action:"resolve",urls:["tmdb:102 show:10 season:1 episode:3","tvdb:203"]}))).json();
  const cleanup = await (await api.POST(request({action:"save",preview:cleanupPreview.preview}))).json();
  await wait();
  const beforeRestore = (await mappingList()).find((m: {id:string})=>m.id===saved.mapping.id);
  await api.POST(request({action:"save",id:beforeRestore.id,revision:beforeRestore.revision,preview:preview.preview}));
  assert.deepEqual((await wait()).report.shows[0].missing, []);
  const beforeBatch = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  blockSeason = true;
  blocked = new Promise<void>(resolve => { unblock = resolve; });
  started = new Promise<void>(resolve => { entered = resolve; });
  await scan.DELETE(new Request("http://localhost/api/plex/scan", { method: "DELETE" }));
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  await started;
  const deleteRequest=()=>new Request("http://localhost/api/plex/manual-coverage", {method:"DELETE",body:JSON.stringify({ids:[saved.mapping.id,cleanup.mapping.id,"already-gone",saved.mapping.id]})});
  assert.equal((await api.DELETE(deleteRequest())).status,409);
  assert.equal((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).revision,beforeBatch.revision);
  blockSeason=false;
  unblock();
  await wait();
  const deleted = await api.DELETE(deleteRequest());
  assert.equal(deleted.status, 200);
  const batch = await deleted.json();
  assert.deepEqual(batch.deleted,[saved.mapping.id,cleanup.mapping.id]);
  assert.deepEqual(batch.missing,["already-gone"]);
  assert.equal(batch.revision,beforeBatch.revision+1);
  const duringBatch = await (await scan.GET()).json();
  assert.equal(duringBatch.scan.status,"completed");
  assert.ok(duringBatch.report);
  blockSeason = false;
  unblock();
  const withdrawn = await wait();
  assert.equal(withdrawn.report.shows[0].missing[0].tmdbEpisodeId,100);
  assert.equal(withdrawn.report.coverageRevision,batch.revision);
  (cache.__shelfcheckDatabase as DatabaseSync | undefined)?.close();
  delete cache.__shelfcheckDatabase;
  const remaining = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.deepEqual(remaining.mappings.map((mapping: {id:string})=>mapping.id), [independent.mapping.id]);
  const gone = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", {method:"DELETE",body:JSON.stringify({ids:["already-gone"]})}));
  assert.deepEqual((await gone.json()).deleted,[]);
  const malformed = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", {method:"DELETE",body:JSON.stringify({filter:"needs-review"})}));
  assert.equal(malformed.status,400);
  const afterInvalid = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.equal(afterInvalid.revision,batch.revision);
  assert.deepEqual(afterInvalid.mappings.map((mapping: {id:string})=>mapping.id),[independent.mapping.id]);
});

test("full Plex scans withdraw complete-set Manual Match coverage when a source item or its correction changes", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-comparator-"));
  const previousData = process.env.SHELFCHECK_DATA_DIR;
  const previousConfig = process.env.SHELFCHECK_CONFIG_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previousData === undefined) delete process.env.SHELFCHECK_DATA_DIR;
    else process.env.SHELFCHECK_DATA_DIR = previousData;
    if (previousConfig === undefined) delete process.env.SHELFCHECK_CONFIG_DIR;
    else process.env.SHELFCHECK_CONFIG_DIR = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-11T12:00:00Z") });
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "test", tvdbApiKey: "test" });
  sqlite.writePlexSettings({ ignoredShows: [{ ratingKey: "ratingKey:source", title: "Ignored source" }], diagnosticsEnabled: false });
  const target = { ratingKey: "target", title: "Combined target", Guid: [{ id: "tmdb://10" }] };
  const source = { ratingKey: "source", title: "Ignored source", Guid: [{ id: "tvdb://20" }] };
  let secondPart = true;
  let itemRevision = 1;
  let ambiguous = false;
  let catalogueDownloads = 0;
  let httpRequests=0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    httpRequests++;
    const u = new URL(String(input));
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections") return Response.json({ MediaContainer: { Directory: [{ key: "1", type: "show" }, { key: "2", type: "show" }] } });
      if (u.pathname.includes("/sections/")) return Response.json({ MediaContainer: { Metadata: u.pathname.includes("/1/") ? [target] : [source] } });
      if (u.pathname.includes("allLeaves")) {
        const parts = [{ ratingKey: "part1", updatedAt: itemRevision, parentIndex: 8, index: 8, Guid: [{ id: "tvdb://200" }, ...(ambiguous ? [{ id: "tmdb://100" }] : [])] },
          ...(secondPart ? [{ ratingKey: "part2", updatedAt: 1, parentIndex: 8, index: 9, Guid: [{ id: "tvdb://201" }] }] : [])];
        return Response.json({ MediaContainer: { Metadata: u.pathname.includes("/source/") ? parts : [] } });
      }
      return Response.json({ MediaContainer: { Metadata: [target] } });
    }
    if (u.pathname === "/v4/login") return Response.json({ data: { token: "test" } });
    if (u.pathname === "/3/tv/10") return Response.json({ id: 10, name: "Combined target", seasons: [{ season_number: 3 }] });
    if (u.pathname === "/3/tv/10/season/3") { catalogueDownloads++; return Response.json({ episodes: [{ id: 100, season_number: 3, episode_number: 18, name: "Complete episode", air_date: "2020-01-01" }] }); }
    if (u.pathname === "/3/tv/10/season/3/episode/18") return Response.json({ id: 100, season_number: 3, episode_number: 18, name: "Complete episode" });
    if (u.pathname === "/v4/series/20") return Response.json({ data: { id: 20, name: "Split source", slug: "split-source" } });
    if (u.pathname === "/v4/episodes/200/extended" || u.pathname === "/v4/episodes/201/extended") {
      const id = u.pathname.includes("/200/") ? 200 : 201;
      return Response.json({ data: { id, seriesId: 20, seasonNumber: 8, number: id === 200 ? 8 : 9, name: id === 200 ? "Part one" : "Part two" } });
    }
    if (u.pathname === "/3/tv/changes") return Response.json({ results: [], total_pages: 1 });
    if (u.pathname === "/v4/updates") return Response.json({ data: [] });
    throw new Error("Unexpected HTTP: " + u);
  });
  const request = (body: unknown) => new Request("http://localhost/api/plex/manual-coverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const wait = async () => {
    for (let i = 0; i < 300; i++) {
      const result = await (await scan.GET()).json();
      if (result.scan.status !== "running") {
        assert.equal(result.scan.status, "completed", result.scan.error);
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("scan timeout");
  };
  const rerun = async () => {
    await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
    return wait();
  };
  const previewResponse = await api.POST(request({ action: "resolve", urls: ["tmdb:100 show:10 season:3 episode:18", "tvdb:200", "tvdb:201"] }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const savedResponse = await api.POST(request({ action: "save", preview: preview.preview }));
  assert.equal(savedResponse.status, 201);
  const saved = await savedResponse.json();
  const complete = await rerun();
  assert.deepEqual(complete.report.shows.map((show: { title: string }) => show.title), ["Combined target"]);
  assert.deepEqual(complete.report.shows[0].missing, []);
  assert.deepEqual(complete.report.shows[0].manualCoverage[0].source.map((item: { ratingKey: string }) => item.ratingKey), ["part1", "part2"]);

  const reportMatches = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.equal(reportMatches.mappings.length, 1, "The all-match report retains a fully collected complete set as one record");
  assert.deepEqual(reportMatches.mappings[0].members.map((member: {provider:string;id:number}) => [member.provider,member.id]), [["TMDB",100],["TVDB",200],["TVDB",201]]);
  assert.equal(catalogueDownloads, 1);
  secondPart = false;
  const incomplete = await rerun();
  assert.deepEqual(incomplete.report.shows[0].missing, [{ season: 3, episode: 18, title: "Complete episode", airDate: "2020-01-01", tmdbEpisodeId: 100, sources: ["TMDB"] }]);
  assert.equal(incomplete.report.shows[0].manualCoverage, undefined);
  assert.equal(catalogueDownloads, 1, "Manual Match existence and changed source holdings do not invalidate complete provider catalogues");
  secondPart = true;
  ambiguous = true;
  assert.equal((await rerun()).report.shows[0].missing.length, 1, "Conflicting combined/split identities cannot complete the source set");
  const state = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  const item = state.mappings[0].evidence.find((entry: { ratingKey: string }) => entry.ratingKey === "part1");
  const beforeCorrection=httpRequests;
  const corrected = await api.POST(request({ action: "correct", mappingId: saved.mapping.id, revision: state.revision, item, identities: [{ provider: "TVDB", id: 200 }] }));
  assert.equal(corrected.status, 200);
  assert.equal(httpRequests,beforeCorrection,"Ownership correction rechecks must perform no HTTP");
  assert.deepEqual((await wait()).report.shows[0].missing, []);
  itemRevision++;
  const changedItem = await rerun();
  assert.equal(changedItem.report.shows[0].missing[0].tmdbEpisodeId, 100, "Changed Plex content invalidates the saved correction");
  const changedState = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.deepEqual(changedState.mappings[0].corrections, []);
  ambiguous = false;
  assert.deepEqual((await rerun()).report.shows[0].missing, []);
  const beforeReportDelete = httpRequests;
  const removed = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", {method:"DELETE",body:JSON.stringify({ids:[saved.mapping.id]})}));
  assert.equal(removed.status,200);
  assert.equal(httpRequests,beforeReportDelete,"Report bulk deletion uses cached rechecks with no Plex enumeration or provider downloads");
  const afterReportDelete=await (await scan.GET()).json();
  assert.equal(afterReportDelete.scan.status,"completed","Report mutations do not start or queue a full scan");
  assert.equal(afterReportDelete.report.shows[0].missing[0].tmdbEpisodeId,100,"Deleting the complete match immediately withdraws its cached coverage");
  assert.equal((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings.length,0);
  const downloadsBeforeExplicitScan=catalogueDownloads;
  await rerun();
  assert.equal(catalogueDownloads,downloadsBeforeExplicitScan+1,"The report cached recheck retains the next explicit scan provider refresh obligation");
});
