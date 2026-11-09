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
  let reverse = false;
  let owned = true;
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
  const previewResponse = await api.POST(request({ action: "resolve", urls: ["https://www.themoviedb.org/tv/10/season/1/episode/1", "https://thetvdb.com/series/other-show/episodes/200"] }));
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
  // An edit during a provider request queues a fresh scan and cannot publish the old revision.
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
  assert.equal(activeEdit.status, 200);
  const pending = await (await scan.GET()).json();
  assert.equal(pending.coverage.pending, 1);
  assert.equal(pending.report, null);
  blockSeason = false;
  unblock();
  const missing = await wait();
  assert.equal(missing.scan.status, "completed", missing.scan.error);
  assert.equal(missing.report.shows[0].missing[0].tmdbEpisodeId, 100);
  const deleted = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage?id=" + saved.mapping.id, { method: "DELETE" }));
  assert.equal(deleted.status, 200);
  await wait();
  const remaining = await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.deepEqual(remaining.mappings.map((mapping: {id:string})=>mapping.id), [independent.mapping.id]);
});
