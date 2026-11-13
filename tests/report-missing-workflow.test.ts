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
const scan = await import("../app/api/plex/scan/route");
const config = await import("../lib/server-config");
hook.deregister();

type Identity = { provider: "TMDB" | "TVDB"; id: number };
type Missing = { season: number; episode: number; tmdbEpisodeId?: number; tvdbEpisodeId?: number; reportedMissing?: string[] };
type Group = { mappingId: string; members: (Identity & { status: string })[] };

// One Plex show carries both provider catalogues. TMDB 100 (S1E1) is the same
// content as TVDB 200 (S2E1); TMDB 101 (S1E2) is the same content as TVDB 201 (S2E2).
async function harness(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "report-missing-"));
  const previousData = process.env.SHELFCHECK_DATA_DIR, previousConfig = process.env.SHELFCHECK_CONFIG_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previousData === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previousData;
    if (previousConfig === undefined) delete process.env.SHELFCHECK_CONFIG_DIR; else process.env.SHELFCHECK_CONFIG_DIR = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  });
  await config.writePlexProviders({ plexUrl: "http://plex", plexToken: "test", tmdbToken: "test", tvdbApiKey: "test" });
  const state = {
    // Plex identities on the local S1E1 and S1E2 files. An empty list leaves coordinate matching only.
    first: [{ id: "tmdb://100" }] as { id: string }[],
    second: [{ id: "tmdb://101" }] as { id: string }[],
    secondLibrary: false,
    // TMDB's external-ID lookup links TVDB 200 to the owned TMDB 100.
    crosswalk: false,
    blockSeason: false,
  };
  let release!: () => void, entered!: () => void;
  let blocked = new Promise<void>(resolve => { release = resolve; });
  let started = new Promise<void>(resolve => { entered = resolve; });
  const requests: string[] = [];
  const show = { ratingKey: "target", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://20" }] };
  const copy = { ratingKey: "copy", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://20" }] };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    requests.push(u.pathname);
    let body: unknown;
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections") body = { MediaContainer: { Directory: [{ key: "1", type: "show" }, ...(state.secondLibrary ? [{ key: "2", type: "show" }] : [])] } };
      else if (u.pathname.includes("/sections/")) body = { MediaContainer: { Metadata: u.pathname.includes("/sections/2/") ? [copy] : [show] } };
      else if (u.pathname.includes("allLeaves")) body = { MediaContainer: { Metadata: u.pathname.includes("/copy/")
        ? [{ ratingKey: "copy-1", updatedAt: 1, parentIndex: 7, index: 7, Guid: [{ id: "tmdb://100" }] }]
        : [{ ratingKey: "file-1", updatedAt: 1, parentIndex: 1, index: 1, Guid: state.first }, { ratingKey: "file-2", updatedAt: 1, parentIndex: 1, index: 2, Guid: state.second },
          // TVDB 201 and 202 are collected by coordinate, so only mapped behaviour varies.
          { ratingKey: "file-3", updatedAt: 1, parentIndex: 2, index: 2 }, { ratingKey: "file-4", updatedAt: 1, parentIndex: 2, index: 3 }] } };
      else body = { MediaContainer: { Metadata: [u.pathname.includes("/copy") ? copy : show] } };
    }
    else if (u.pathname === "/v4/login") body = { data: { token: "test" } };
    else if (u.pathname === "/3/tv/10") body = { id: 10, name: "Target", seasons: [{ season_number: 1 }] };
    else if (u.pathname === "/3/tv/10/season/1") {
      if (state.blockSeason) { entered(); await blocked; }
      body = { episodes: [{ id: 100, season_number: 1, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }, { id: 101, season_number: 1, episode_number: 2, name: "Second", air_date: "2020-01-08" }] };
    }
    else if (u.pathname.match(/^\/3\/tv\/10\/season\/1\/episode\/[12]$/)) { const episode = Number(u.pathname.split("/").pop()); body = { id: 99 + episode, season_number: 1, episode_number: episode, name: episode === 1 ? "Pilot" : "Second" }; }
    else if (u.pathname === "/v4/series/20") body = { data: { id: 20, name: "Target", slug: "target" } };
    else if (u.pathname === "/v4/series/20/episodes/default") body = { data: { episodes: [{ id: 200, seasonNumber: 2, number: 1, name: "Pilot (TVDB)", aired: "2020-01-01" }, { id: 201, seasonNumber: 2, number: 2, name: "Second (TVDB)", aired: "2020-01-08" }, { id: 202, seasonNumber: 2, number: 3, name: "Replacement (TVDB)", aired: "2020-01-15" }] } };
    else if (u.pathname.match(/^\/v4\/episodes\/20[0-2]\/extended$/)) { const id = Number(u.pathname.split("/")[3]); body = { data: { id, seriesId: 20, seasonNumber: 2, number: id - 199, name: "TVDB " + id } }; }
    else if (u.pathname === "/3/tv/changes") body = { results: [], total_pages: 1 };
    else if (u.pathname === "/v4/updates") body = { data: [] };
    else if (u.pathname === "/3/find/200" && state.crosswalk) body = { tv_results: [], tv_episode_results: [{ id: 100, show_id: 10, season_number: 1, episode_number: 1, name: "Pilot" }] };
    else if (u.pathname.includes("/find/")) body = { tv_results: [], tv_episode_results: [] };
    else throw new Error("Unexpected HTTP: " + u);
    return Response.json(body);
  });
  const post = (body: unknown) => api.POST(new Request("http://localhost/api/plex/manual-coverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const status = async () => (await scan.GET()).json();
  const wait = async () => {
    for (let i = 0; i < 300; i++) {
      const result = await status();
      if (result.scan.status !== "running") { assert.equal(result.scan.status, "completed", result.scan.error); return result; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("scan timeout");
  };
  const rerun = async () => { await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" })); return wait(); };
  const mappings = async () => (await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings as { id: string; revision: number; members: (Identity & { reportMissing: boolean })[] }[];
  const save = async (tmdb: number, tvdb: number[], extra: Record<string, unknown> = {}) => {
    const resolved = await post({ action: "resolve", urls: [`tmdb:${tmdb} show:10 season:1 episode:${tmdb - 99}`, ...tvdb.map(id => `tvdb:${id}`)] });
    assert.equal(resolved.status, 200, await resolved.clone().text());
    return post({ action: "save", preview: (await resolved.json()).preview, ...extra });
  };
  const flags = async (id: string) => (await mappings()).find(mapping => mapping.id === id)!.members.filter(member => member.reportMissing).map(member => `${member.provider}:${member.id}`);
  const missing = (result: { report: { shows: { missing: Missing[] }[] } }) => result.report.shows[0].missing.map(episode => ({ tmdb: episode.tmdbEpisodeId, tvdb: episode.tvdbEpisodeId, reported: episode.reportedMissing || [] }));
  const group = (result: { report: { coverageGroups?: Group[] } }, id: string) => Object.fromEntries((result.report.coverageGroups || []).find(item => item.mappingId === id)?.members.map(member => [`${member.provider}:${member.id}`, member.status]) || []);
  const downloads = () => requests.filter(item => item === "/3/tv/10/season/1").length;
  const block = () => {
    state.blockSeason = true;
    blocked = new Promise<void>(resolve => { release = resolve; });
    started = new Promise<void>(resolve => { entered = resolve; });
    return { started: () => started, release: () => { state.blockSeason = false; release(); } };
  };
  return { state, cache, requests, post, status, wait, rerun, mappings, save, flags, missing, group, downloads, block };
}

test("Report Missing on a one-to-one Manual Match overrides direct ownership and Manual Match coverage until cleared", async t => {
  const h = await harness(t);
  const savedResponse = await h.save(100, [200]);
  assert.equal(savedResponse.status, 201);
  let mapping = (await savedResponse.json()).mapping;
  assert.deepEqual(await h.flags(mapping.id), [], "New members default to flags off");
  const collected = await h.rerun();
  assert.deepEqual(h.missing(collected), [], "TMDB 100 is directly owned and covers TVDB 200 through the Manual Match");
  const downloadsBefore = h.downloads();

  // A flag-only save needs no new provider resolution, Plex enumeration, or catalogue download.
  const beforeFlag = h.requests.length;
  const flagged = await h.post({ action: "save", id: mapping.id, revision: mapping.revision, reportMissing: [{ provider: "TMDB", id: 100 }] });
  assert.equal(flagged.status, 200, await flagged.clone().text());
  mapping = (await flagged.json()).mapping;
  assert.equal(h.requests.length, beforeFlag, "Saving a flag rechecks cached results without HTTP");
  assert.deepEqual(mapping.members.map((member: { reportMissing: boolean }) => member.reportMissing), [true, false]);
  assert.deepEqual(await h.flags(mapping.id), ["TMDB:100"]);
  const reported = await h.status();
  assert.equal(reported.scan.status, "completed", "Saving a flag does not start a full scan");
  assert.deepEqual(h.missing(reported), [{ tmdb: 100, tvdb: undefined, reported: ["TMDB"] }], "The explicit flag beats direct ownership and coordinate matching; the opposite member stays collected");
  assert.deepEqual(h.group(reported, mapping.id), { "TMDB:100": "reported-missing", "TVDB:200": "manual" }, "Grouped presentation shows the flag over direct ownership");

  // Flags survive full scans, restarts, and newly reported ownership from another library.
  h.state.secondLibrary = true;
  assert.deepEqual(h.missing(await h.rerun()), [{ tmdb: 100, tvdb: undefined, reported: ["TMDB"] }]);
  assert.equal(h.downloads(), downloadsBefore + 1, "The flag save leaves a provider refresh obligation for the next full scan");
  h.cache.__shelfcheckDatabase?.close();
  delete h.cache.__shelfcheckDatabase;
  assert.deepEqual(await h.flags(mapping.id), ["TMDB:100"]);
  assert.deepEqual(h.missing(await h.rerun()), [{ tmdb: 100, tvdb: undefined, reported: ["TMDB"] }]);
  h.state.secondLibrary = false;

  // Coordinate matching alone cannot hide the flag either.
  h.state.first = [];
  assert.deepEqual(h.missing(await h.rerun()).filter(item => item.tmdb === 100), [{ tmdb: 100, tvdb: undefined, reported: ["TMDB"] }]);
  h.state.first = [{ id: "tmdb://100" }];
  await h.rerun();

  // Flag the other side: TVDB 200 was collected only through Manual Match coverage.
  mapping = (await h.mappings()).find(item => item.id === mapping.id);
  const swapped = await h.post({ action: "save", id: mapping.id, revision: mapping.revision, reportMissing: [{ provider: "TVDB", id: 200 }] });
  assert.equal(swapped.status, 200);
  mapping = (await swapped.json()).mapping;
  const tvdbReported = await h.status();
  assert.deepEqual(h.missing(tvdbReported), [{ tmdb: undefined, tvdb: 200, reported: ["TVDB"] }], "Clearing TMDB 100 restores it; TVDB 200 is now reported missing");
  assert.deepEqual(h.group(tvdbReported, mapping.id), { "TMDB:100": "direct", "TVDB:200": "reported-missing" });

  // Clearing every flag immediately restores normal matching.
  const cleared = await h.post({ action: "save", id: mapping.id, revision: mapping.revision, reportMissing: [] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(h.missing(await h.status()), []);
  assert.deepEqual(await h.flags(mapping.id), []);
});

test("Report Missing beats automatic crosswalk ownership and only names members of the saved mapping", async t => {
  const h = await harness(t);
  h.state.crosswalk = true;
  const saved = await (await h.save(100, [200])).json();
  const automatic = await h.rerun();
  assert.deepEqual(h.missing(automatic), []);
  assert.ok(automatic.report.shows[0].autoMatches?.some((match: { tvdb: { id: number } }) => match.tvdb.id === 200), "TVDB 200 is collected through the TMDB external-ID crosswalk");
  const flagged = await h.post({ action: "save", id: saved.mapping.id, revision: saved.mapping.revision, reportMissing: [{ provider: "TVDB", id: 200 }] });
  assert.equal(flagged.status, 200);
  const reported = await h.status();
  assert.deepEqual(h.missing(reported), [{ tmdb: undefined, tvdb: 200, reported: ["TVDB"] }]);
  assert.deepEqual(h.group(reported, saved.mapping.id), { "TMDB:100": "direct", "TVDB:200": "reported-missing" });

  // Flags must name members of the saved mapping.
  const current = (await flagged.json()).mapping;
  const outsider = await h.post({ action: "save", id: current.id, revision: current.revision, reportMissing: [{ provider: "TVDB", id: 999 }] });
  assert.equal(outsider.status, 400);
  // Larger mappings accept flags too (see report-missing-combined-workflow and report-missing-many-to-many-workflow).
  const larger = await h.save(101, [201, 202], { reportMissing: [{ provider: "TVDB", id: 202 }] });
  assert.equal(larger.status, 201);
  assert.deepEqual(await h.flags(current.id), ["TVDB:200"], "Saving another mapping leaves this mapping's flags intact");
});

test("Report Missing follows mapping membership through edits and deletion and respects stale edits and scan locks", async t => {
  const h = await harness(t);
  const first = await (await h.save(100, [200], { reportMissing: [{ provider: "TMDB", id: 100 }, { provider: "TVDB", id: 200 }] })).json();
  const other = await (await h.save(101, [201], { reportMissing: [{ provider: "TMDB", id: 101 }] })).json();
  assert.deepEqual(await h.flags(first.mapping.id), ["TMDB:100", "TVDB:200"]);
  await h.rerun();

  // Editing membership without restating flags keeps retained members' flags and drops removed members'.
  const edited = await h.save(100, [202], { id: first.mapping.id, revision: first.mapping.revision });
  assert.equal(edited.status, 200);
  const editedMapping = (await edited.json()).mapping;
  assert.deepEqual(await h.flags(first.mapping.id), ["TMDB:100"]);
  const restored = await h.save(100, [200], { id: editedMapping.id, revision: editedMapping.revision });
  assert.deepEqual(await h.flags(first.mapping.id), ["TMDB:100"], "A removed member's flag is not resurrected when it returns");
  const current = (await restored.json()).mapping;

  // A stale draft cannot overwrite newer flag state.
  const stale = await h.post({ action: "save", id: current.id, revision: first.mapping.revision, reportMissing: [] });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "stale-revision");
  assert.deepEqual(await h.flags(current.id), ["TMDB:100"]);

  // Scans lock flag saves, including drafts opened before the scan started.
  const gate = h.block();
  await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
  await gate.started();
  const locked = await h.post({ action: "save", id: current.id, revision: current.revision, reportMissing: [] });
  assert.equal(locked.status, 409);
  assert.equal((await locked.json()).code, "scan-active");
  gate.release();
  const scanned = await h.wait();
  assert.deepEqual(await h.flags(current.id), ["TMDB:100"]);
  assert.deepEqual(h.missing(scanned).map(item => item.tmdb), [100, 101]);

  // Deleting a mapping deletes its flags and rechecks affected results; unrelated flags remain.
  const deleted = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", { method: "DELETE", body: JSON.stringify({ ids: [current.id] }) }));
  assert.equal(deleted.status, 200);
  assert.deepEqual(h.missing(await h.status()), [{ tmdb: 101, tvdb: undefined, reported: ["TMDB"] }, { tmdb: undefined, tvdb: 200, reported: [] }], "TMDB 100 returns to normal matching; unmapped TVDB 200 loses its Manual Match coverage");
  assert.deepEqual(await h.flags(other.mapping.id), ["TMDB:101"]);
  const recreated = await (await h.save(100, [200])).json();
  assert.deepEqual(await h.flags(recreated.mapping.id), [], "Recreating a deleted mapping does not restore its flags");
  const individually = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${other.mapping.id}`, { method: "DELETE" }));
  assert.equal(individually.status, 200);
  assert.deepEqual(h.missing(await h.status()), []);
});
