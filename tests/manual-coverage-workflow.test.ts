import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
const hook = registerHooks({ resolve(s, c, next) {
    return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c);
  } });
const api = await import("../app/api/plex/manual-coverage/route");
const sqlite = await import("../lib/sqlite");
const ignoreResults = await import("../lib/ignore-results");
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
  let memberGone = false;
  let missingTmdbCoordinate = false;
  let tmdbTarget = false;
  let owned = false;
  let tvdbEpisodes = [200];
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
  // Manual Matches cover one way (ADR-0008): the TVDB-ordered target is covered by the TMDB
  // member its ignored source owns. A TMDB-ordered target is never covered by a Manual Match.
  const show = { ratingKey: "1", title: "Target", Guid: [{ id: "tvdb://20" }], updatedAt: 1 };
  const source = { ratingKey: "2", title: "Ignored source", Guid: [{ id: "tmdb://10" }], updatedAt: 1 };
  ignoreResults.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "ratingKey:2", title: "Ignored source" }], diagnosticsEnabled: false });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === "/v4/episodes/200/extended" && memberGone) return Response.json({}, {status: 404});
    if (u.pathname === "/3/tv/10/season/1/episode/1" && missingTmdbCoordinate) return Response.json({}, {status:404});
    let body: unknown;
    if (u.hostname === "plex") {
      if (unavailableSource && u.pathname.includes("/2/allLeaves")) return Response.json({error:"Plex source unavailable"},{status:404});
      if (u.pathname === "/library/sections")
        body = { MediaContainer: { Directory: [{ key: "1", type: "show" }, { key: "2", type: "show" }] } };
      else if (u.pathname.includes("/sections/"))
        body = { MediaContainer: { Metadata: u.pathname.includes("/sections/1/") ? [show] : [source] } };
      else if (u.pathname.includes("allLeaves"))
        body = { MediaContainer: { Metadata: u.pathname.includes("/2/") && owned ? [{ ratingKey: "owned", updatedAt: 1, parentIndex: 8, index: 8, Guid: [{ id: tmdbTarget ? "tvdb://200" : "tmdb://100" }] }] : automatic ? [{ ratingKey: "automatic", parentIndex: 99, index: 99, Guid: [{ id: tmdbTarget ? "tmdb://100" : "tvdb://200" }] }] : [{ ratingKey: "unrelated", updatedAt: 1, parentIndex: 99, index: 99 }] } };
      else
        body = { MediaContainer: { Metadata: [show] } };
    }
    else if (u.pathname === "/3/tv/10")
      body = { id: 10, name: "Target", seasons: [{ season_number: 1 }] };
    else if (u.pathname === "/3/tv/10/season/1" || u.pathname === "/v4/series/20/episodes/default") {
      if (blockSeason) {
        entered();
        await blocked;
      }
      body = u.pathname === "/3/tv/10/season/1"
        ? { episodes: [{ id: 100, season_number: 1, episode_number: 1, name: "Missing", air_date: "2020-01-01" }] }
        : { data: { episodes: tvdbEpisodes.map(id => id === 200 ? { id: 200, seasonNumber: 8, number: 8, name: "Equivalent", aired: "2020-01-01" } : { id: 202, seasonNumber: 10, number: 10, name: "Replacement equivalent", aired: "2020-01-01" }) } };
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
  assert.equal(beforeOwnership.report.shows[0].missing[0].tvdbEpisodeId, 200);
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
  const sayNoMapping = (text: string) => assert.doesNotMatch(text, /mapping/i, "User-visible text says Manual Match, not mapping");
  sayNoMapping((await conflict.json()).error);
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
  assert.equal((await wait()).report.shows[0].missing[0].tvdbEpisodeId, 200);
  const competingEdits = await Promise.all([0, 1].map(() => api.POST(request({ action: "save", id: saved.mapping.id, revision: edited.mapping.revision, preview: replacementPreview.preview }))));
  assert.deepEqual(competingEdits.map(response => response.status).sort(), [200, 409]);
  edited.mapping = (await competingEdits.find(response => response.status === 200)!.json()).mapping;
  await wait();
  const stale = await api.POST(request({ action: "save", id: saved.mapping.id, revision: saved.mapping.revision, preview: preview.preview }));
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.code, "stale-revision");
  sayNoMapping(staleBody.error);
  const competing = await api.POST(request({ action: "save", id: saved.mapping.id, revision: edited.mapping.revision, preview: otherPreview.preview }));
  assert.equal(competing.status, 409);
  assert.equal((await competing.json()).mappingId, independent.mapping.id);
  const rejected = await api.POST(request({ action: "save", id: saved.mapping.id, revision: edited.mapping.revision, preview: "forged" }));
  assert.equal(rejected.status, 400);
  const intact = (await (await api.GET(new Request("http://localhost/api/plex/manual-coverage?id=" + saved.mapping.id))).json()).mappings[0];
  assert.equal(intact.revision, edited.mapping.revision);
  assert.deepEqual(intact.members.map((m: {id:number}) => m.id), [100, 202]);
  tvdbEpisodes = [202];
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const replaced = await wait();
  assert.deepEqual(replaced.report.shows[0].missing, [], "the edited Manual Match covers its new TVDB member");
  assert.equal(replaced.report.shows[0].manualCoverage[0].mappingId, saved.mapping.id);
  const restored = await api.POST(request({ action: "save", id: saved.mapping.id, revision: edited.mapping.revision, preview: preview.preview }));
  assert.equal(restored.status, 200);
  saved.mapping = (await restored.json()).mapping;
  await wait();
  tvdbEpisodes = [200];
  ignoreResults.savedScanState("plex").clearReportAndResumePoint();
  cache.__shelfcheckDatabase?.close();
  delete cache.__shelfcheckDatabase;
  assert.equal((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings.length, 2);
  const mappingList = async () => (await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings;
  const rerun = async () => {
    await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
    return wait();
  };
  // Manual Matches have no health (ADR-0008): a scan requests no member, so a member its provider
  // no longer finds still lets the match cover, with no member Scan Issue.
  memberGone = true;
  missingTmdbCoordinate = true;
  const withoutMembers = await rerun();
  assert.deepEqual(withoutMembers.report.shows[0].missing, [], "The Manual Match still covers");
  assert.ok(!withoutMembers.coverage.issues.some((issue:{operation:string})=>issue.operation === "member-verification"), "No member Scan Issue");
  const kept = (await mappingList()).find((m: {id:string}) => m.id === saved.mapping.id);
  assert.equal("health" in kept || "healthMessage" in kept, false, "A listed Manual Match has no health");
  assert.deepEqual(kept.members.map((m: {id:number;title:string}) => [m.id,m.title]), [[100,"Missing"],[200,"Equivalent"]]);
  // Saving still checks the episodes against their providers.
  const invalidRepair = await api.POST(request({action:"resolve",id:kept.id,urls:["tmdb:100 show:10 season:1 episode:1","tvdb:200"]}));
  assert.equal(invalidRepair.status, 503);
  sayNoMapping((await invalidRepair.json()).error);
  const expiredPreview = await api.POST(request({action:"save",id:kept.id,revision:kept.revision,preview:preview.preview}));
  assert.equal(expiredPreview.status,503,"A previously reviewed preview cannot save a now-deleted member");
  assert.deepEqual((await mappingList()).find((m: {id:string})=>m.id===kept.id), kept, "A rejected save changes nothing");
  memberGone = false;
  missingTmdbCoordinate = false;
  saved.mapping = kept;
  // Automatic ownership keeps its existing result and is not relabelled manual.
  automatic = true;
  owned = false;
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const automaticReport = await wait();
  assert.deepEqual(automaticReport.report.shows[0].missing, []);
  assert.equal(automaticReport.report.shows[0].manualCoverage, undefined);
  automatic = false;
  owned = true;
  // The saved Manual Match covers across shows and seasons from the TMDB side only.
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const acrossShows = await wait();
  assert.deepEqual(acrossShows.report.shows[0].missing, []);
  assert.equal(acrossShows.report.shows[0].manualCoverage[0].source[0].identities[0].provider, "TMDB");
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
  // Owning the TVDB member never covers the TMDB member of a TMDB-ordered target.
  owned = true;
  tmdbTarget = true;
  show.Guid = [{ id: "tmdb://10" }];
  source.Guid = [{ id: "tvdb://20" }];
  await scan.DELETE(new Request("http://localhost/api/plex/scan", { method: "DELETE" }));
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  const tmdbOrdered = await wait();
  assert.equal(tmdbOrdered.scan.status, "completed", tmdbOrdered.scan.error);
  assert.deepEqual(tmdbOrdered.report.shows[0].missing.map((episode: {tmdbEpisodeId:number}) => episode.tmdbEpisodeId), [100]);
  assert.equal(tmdbOrdered.report.shows[0].manualCoverage, undefined);
  tmdbTarget = false;
  show.Guid = [{ id: "tvdb://20" }];
  source.Guid = [{ id: "tmdb://10" }];
  // Mutations opened before a scan are rejected without applying or queueing work.
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
  assert.equal(missing.report.shows[0].missing[0].tvdbEpisodeId, 200);
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
  assert.equal(withdrawn.report.shows[0].missing[0].tvdbEpisodeId,200);
  assert.equal(withdrawn.report.coverageRevision,batch.revision);
  (cache.__shelfcheckDatabase as DatabaseSync | undefined)?.close();
  delete cache.__shelfcheckDatabase;
  const remaining = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.deepEqual(remaining.mappings.map((mapping: {id:string})=>mapping.id), [independent.mapping.id]);
  const gone = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", {method:"DELETE",body:JSON.stringify({ids:["already-gone"]})}));
  assert.deepEqual((await gone.json()).deleted,[]);
  const malformed = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", {method:"DELETE",body:JSON.stringify({filter:"needs-review"})}));
  assert.equal(malformed.status,400);
  sayNoMapping((await malformed.json()).error);
  const unknown = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage?id=already-gone", {method:"DELETE"}));
  assert.equal(unknown.status,404);
  sayNoMapping((await unknown.json()).error);
  const afterInvalid = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.equal(afterInvalid.revision,batch.revision);
  assert.deepEqual(afterInvalid.mappings.map((mapping: {id:string})=>mapping.id),[independent.mapping.id]);
});

test("full Plex scans withdraw complete-set Manual Match coverage when a source item changes", async (t) => {
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
  ignoreResults.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "ratingKey:source", title: "Ignored source" }], diagnosticsEnabled: false });
  // One way (ADR-0008): the TVDB combined episode is covered by its owned TMDB split parts.
  const target = { ratingKey: "target", title: "Combined target", Guid: [{ id: "tvdb://20" }] };
  const source = { ratingKey: "source", title: "Ignored source", Guid: [{ id: "tmdb://10" }] };
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
        const parts = [{ ratingKey: "part1", updatedAt: itemRevision, parentIndex: 3, index: 18, Guid: [{ id: "tmdb://100" }, ...(ambiguous ? [{ id: "tvdb://200" }] : [])] },
          ...(secondPart ? [{ ratingKey: "part2", updatedAt: 1, parentIndex: 3, index: 19, Guid: [{ id: "tmdb://101" }] }] : [])];
        return Response.json({ MediaContainer: { Metadata: u.pathname.includes("/source/") ? parts : [] } });
      }
      return Response.json({ MediaContainer: { Metadata: [target] } });
    }
    if (u.pathname === "/v4/login") return Response.json({ data: { token: "test" } });
    if (u.pathname === "/3/tv/10") return Response.json({ id: 10, name: "Split source", seasons: [{ season_number: 3 }] });
    if (u.pathname === "/3/tv/10/season/3/episode/18" || u.pathname === "/3/tv/10/season/3/episode/19") {
      const id = u.pathname.endsWith("/18") ? 100 : 101;
      return Response.json({ id, season_number: 3, episode_number: id === 100 ? 18 : 19, name: id === 100 ? "Part one" : "Part two" });
    }
    if (u.pathname === "/v4/series/20") return Response.json({ data: { id: 20, name: "Combined target", slug: "combined-target" } });
    if (u.pathname === "/v4/series/20/episodes/default") { catalogueDownloads++; return Response.json({ data: { episodes: [{ id: 200, seasonNumber: 8, number: 8, name: "Complete episode", aired: "2020-01-01" }] } }); }
    if (u.pathname === "/v4/episodes/200/extended") return Response.json({ data: { id: 200, seriesId: 20, seasonNumber: 8, number: 8, name: "Complete episode" } });
    if (u.pathname.includes("/find/")) return Response.json({ tv_results: [], tv_episode_results: [] });
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
  const previewResponse = await api.POST(request({ action: "resolve", urls: ["tvdb:200", "tmdb:100 show:10 season:3 episode:18", "tmdb:101 show:10 season:3 episode:19"] }));
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
  assert.deepEqual(reportMatches.mappings[0].members.map((member: {provider:string;id:number}) => [member.provider,member.id]), [["TVDB",200],["TMDB",100],["TMDB",101]]);
  assert.equal(catalogueDownloads, 1);
  secondPart = false;
  const incomplete = await rerun();
  assert.deepEqual(incomplete.report.shows[0].missing, [{ season: 8, episode: 8, title: "Complete episode", airDate: "2020-01-01", tvdbEpisodeId: 200, sources: ["TVDB"] }]);
  assert.equal(incomplete.report.shows[0].manualCoverage, undefined);
  assert.equal(catalogueDownloads, 1, "Manual Match existence and changed source holdings do not invalidate complete provider catalogues");
  secondPart = true;
  ambiguous = true;
  assert.deepEqual((await rerun()).report.shows[0].missing, [], "A part also reporting the combined identity still completes the split source set");
  const state = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  const item = state.mappings[0].evidence.find((entry: { ratingKey: string }) => entry.ratingKey === "part1");
  assert.deepEqual(item.identities, [{ provider: "TMDB", id: 100 }, { provider: "TVDB", id: 200 }], "Inventory evidence remains available");
  const beforeObsolete = httpRequests;
  const obsolete = await api.POST(request({ action: "correct", mappingId: saved.mapping.id, revision: state.revision, item, identities: [{ provider: "TMDB", id: 100 }] }));
  assert.equal(obsolete.status, 400);
  assert.equal((await obsolete.json()).code, "unsupported-action");
  assert.equal(httpRequests, beforeObsolete, "The rejected correction performs no recheck or HTTP");
  assert.deepEqual(await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json(), state);
  itemRevision++;
  assert.deepEqual((await rerun()).report.shows[0].missing, [], "Changed Plex content needs no repeated ownership declaration");
  ambiguous = false;
  const beforeReportDelete = httpRequests;
  const removed = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", {method:"DELETE",body:JSON.stringify({ids:[saved.mapping.id]})}));
  assert.equal(removed.status,200);
  assert.equal(httpRequests,beforeReportDelete,"Report bulk deletion uses cached rechecks with no Plex enumeration or provider downloads");
  const afterReportDelete=await (await scan.GET()).json();
  assert.equal(afterReportDelete.scan.status,"completed","Report mutations do not start or queue a full scan");
  assert.equal(afterReportDelete.report.shows[0].missing[0].tvdbEpisodeId,200,"Deleting the complete match immediately withdraws its cached coverage");
  assert.equal((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings.length,0);
  const downloadsBeforeExplicitScan=catalogueDownloads;
  await rerun();
  assert.equal(catalogueDownloads,downloadsBeforeExplicitScan+1,"The report cached recheck retains the next explicit scan provider refresh obligation");
});

test("upgrading discards saved ownership corrections and keeps every Manual Match unchanged", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-migration-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR;
    else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const member = (provider: string, id: number) => ({ provider, id, showId: 10, show: "Example", title: "Episode " + id, season: 1, episode: id, url: "https://example.com/" + id });
  const mapping = { id: "kept", revision: 4, createdAt: "2026-01-01T00:00:00.000Z", members: [member("TMDB", 100), member("TVDB", 200), member("TVDB", 201)] };
  // A database written by a release that still supported ownership corrections,
  // before mapping members carried Report Missing flags.
  const legacy = new DatabaseSync(path.join(dir, "shelfcheck.db"));
  legacy.exec(`CREATE TABLE shelfcheck_coverage_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
    INSERT INTO shelfcheck_coverage_state(id,revision,pending) VALUES(1,4,0);
    CREATE TABLE shelfcheck_coverage_mappings(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE shelfcheck_coverage_members(provider TEXT NOT NULL, episode_id INTEGER NOT NULL, mapping_id TEXT NOT NULL REFERENCES shelfcheck_coverage_mappings(id) ON DELETE CASCADE, PRIMARY KEY(provider, episode_id));`);
  legacy.prepare("INSERT INTO shelfcheck_coverage_mappings VALUES(?,?)").run(mapping.id, JSON.stringify(mapping));
  for (const m of mapping.members) legacy.prepare("INSERT INTO shelfcheck_coverage_members VALUES(?,?,?)").run(m.provider, m.id, mapping.id);
  legacy.exec("CREATE TABLE shelfcheck_coverage_corrections(mapping_id TEXT NOT NULL,show_key TEXT NOT NULL,item_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(mapping_id,show_key,item_key))");
  legacy.prepare("INSERT INTO shelfcheck_coverage_corrections VALUES(?,?,?,?)").run("kept", "show", "file", JSON.stringify({ mappingId: "kept", ratingKey: "file", showKey: "show", fingerprint: "v1", identities: [{ provider: "TVDB", id: 200 }] }));
  legacy.close();

  const upgraded = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.deepEqual(upgraded.mappings, [{ ...mapping, members: mapping.members.map(m => ({ ...m, reportMissing: false })), evidence: [] }], "Manual Matches survive unchanged with Report Missing off, with no inferred decisions");
  assert.ok(upgraded.revision > 4, "Discarding corrections advances the coverage revision");
  assert.ok(upgraded.issues.some((issue: { id: string }) => issue.id === "comparison-pending"), "Cached results shaped by corrections are flagged for comparison");
  assert.equal(sqlite.database().prepare("SELECT 1 FROM sqlite_master WHERE name='shelfcheck_coverage_corrections'").get(), undefined, "Saved corrections are discarded");
  const repeat = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.equal(repeat.revision, upgraded.revision, "The migration runs once");
});
