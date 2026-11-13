import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type test from "node:test";
const hook = registerHooks({ resolve(s, c, next) {
  return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c);
} });
export const api = await import("../app/api/plex/manual-coverage/route");
const scan = await import("../app/api/plex/scan/route");
const config = await import("../lib/server-config");
hook.deregister();

// Report Missing API/workflow harness: temporary persistence, one Plex show
// ("Target", TMDB 10 / TVDB 20) and mocked Plex and provider responses built
// from a provider catalogue.
export type Provider = "TMDB" | "TVDB";
export type Identity = { provider: Provider; id: number };
export type Episode = Identity & { season: number; episode: number; name: string };
type Missing = { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: Provider[]; reportedMissing?: Provider[]; incomplete?: Partial<Record<Provider, Identity[]>> };
type Group = { mappingId: string; members: (Identity & { status: string; missingParts?: Identity[] })[] };
type Result = { report: { shows: { missing: Missing[] }[]; coverageGroups?: Group[] } };

export const key = (member: Identity) => `${member.provider}:${member.id}`;
export const flag = (member: Identity) => ({ provider: member.provider, id: member.id });

export async function harness(t: test.TestContext, catalogue: Episode[], owned: Episode[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "report-missing-combined-"));
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
  const tmdb = catalogue.filter(episode => episode.provider === "TMDB");
  const tvdb = catalogue.filter(episode => episode.provider === "TVDB");
  // Plex owns each `owned` episode by provider identity and by Plex coordinates.
  const guid = (episode: Episode) => ({ id: `${episode.provider.toLowerCase()}://${episode.id}` });
  const state = { secondLibrary: false };
  const requests: string[] = [];
  const show = { ratingKey: "target", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://20" }] };
  const copy = { ratingKey: "copy", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://20" }] };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    requests.push(u.pathname);
    let body: unknown;
    let match: RegExpMatchArray | null;
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections") body = { MediaContainer: { Directory: [{ key: "1", type: "show" }, ...(state.secondLibrary ? [{ key: "2", type: "show" }] : [])] } };
      else if (u.pathname.includes("/sections/")) body = { MediaContainer: { Metadata: u.pathname.includes("/sections/2/") ? [copy] : [show] } };
      else if (u.pathname.includes("allLeaves")) body = { MediaContainer: { Metadata: u.pathname.includes("/copy/")
        // Another library also reports owning the first owned episode.
        ? [{ ratingKey: "copy-1", updatedAt: 1, parentIndex: 7, index: 7, Guid: [guid(owned[0])] }]
        : owned.map(episode => ({ ratingKey: `file-${episode.id}`, updatedAt: 1, parentIndex: episode.season, index: episode.episode, Guid: [guid(episode)] })) } };
      else body = { MediaContainer: { Metadata: [u.pathname.includes("/copy") ? copy : show] } };
    }
    else if (u.pathname === "/v4/login") body = { data: { token: "test" } };
    else if (u.pathname === "/3/tv/10") body = { id: 10, name: "Target", seasons: [...new Set(tmdb.map(episode => episode.season))].map(season_number => ({ season_number })) };
    else if ((match = u.pathname.match(/^\/3\/tv\/10\/season\/(\d+)$/))) body = { episodes: tmdb.filter(episode => episode.season === Number(match![1])).map(episode => ({ id: episode.id, season_number: episode.season, episode_number: episode.episode, name: episode.name, air_date: "2020-01-01" })) };
    else if ((match = u.pathname.match(/^\/3\/tv\/10\/season\/(\d+)\/episode\/(\d+)$/))) {
      const episode = tmdb.find(item => item.season === Number(match![1]) && item.episode === Number(match![2]))!;
      body = { id: episode.id, season_number: episode.season, episode_number: episode.episode, name: episode.name };
    }
    else if (u.pathname === "/v4/series/20") body = { data: { id: 20, name: "Target", slug: "target" } };
    else if (u.pathname === "/v4/series/20/episodes/default") body = { data: { episodes: tvdb.map(episode => ({ id: episode.id, seasonNumber: episode.season, number: episode.episode, name: episode.name, aired: "2020-01-01" })) } };
    else if ((match = u.pathname.match(/^\/v4\/episodes\/(\d+)\/extended$/))) {
      const episode = tvdb.find(item => item.id === Number(match![1]))!;
      body = { data: { id: episode.id, seriesId: 20, seasonNumber: episode.season, number: episode.episode, name: episode.name } };
    }
    else if (u.pathname === "/3/tv/changes") body = { results: [], total_pages: 1 };
    else if (u.pathname === "/v4/updates") body = { data: [] };
    else if (u.pathname.includes("/find/")) body = { tv_results: [], tv_episode_results: [] };
    else throw new Error("Unexpected HTTP: " + u);
    return Response.json(body);
  });
  const post = (body: unknown) => api.POST(new Request("http://localhost/api/plex/manual-coverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const status = async (): Promise<Result & { scan: { status: string; error?: string } }> => (await scan.GET()).json();
  const rerun = async () => {
    await scan.POST(new Request("http://localhost/api/plex/scan", { method: "POST", body: "{}" }));
    for (let i = 0; i < 300; i++) {
      const result = await status();
      if (result.scan.status !== "running") { assert.equal(result.scan.status, "completed", result.scan.error); return result; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("scan timeout");
  };
  type Saved = { id: string; revision: number; members: (Identity & { reportMissing: boolean })[] };
  const mappings = async () => (await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings as Saved[];
  const save = async (members: Episode[], extra: Record<string, unknown> = {}) => {
    const resolved = await post({ action: "resolve", urls: members.map(member => member.provider === "TMDB" ? `tmdb:${member.id} show:10 season:${member.season} episode:${member.episode}` : `tvdb:${member.id}`) });
    assert.equal(resolved.status, 200, await resolved.clone().text());
    return post({ action: "save", preview: (await resolved.json()).preview, ...extra });
  };
  // A flag-only save of the latest saved revision, as the editor sends it.
  const setFlags = async (id: string, members: Identity[]) => {
    const current = (await mappings()).find(mapping => mapping.id === id)!;
    const response = await post({ action: "save", id, revision: current.revision, reportMissing: members.map(flag) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).mapping as Saved;
  };
  const flags = async (id: string) => (await mappings()).find(mapping => mapping.id === id)!.members.filter(member => member.reportMissing).map(key);
  // Plex missing results: each missing provider record and why it is missing.
  const missing = (result: Result) => Object.fromEntries(result.report.shows[0].missing.flatMap(episode => episode.sources.map(source => {
    const parts = episode.incomplete?.[source];
    return [`${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`, episode.reportedMissing?.includes(source) ? "reported-missing" : parts ? `incomplete because ${parts.map(key).join(",")}` : "missing"];
  })));
  const group = (result: Result, id: string) => Object.fromEntries((result.report.coverageGroups || []).find(item => item.mappingId === id)?.members.map(member => [key(member), member.missingParts ? `${member.status} because ${member.missingParts.map(key).join(",")}` : member.status]) || []);
  // Writes membership flags directly, as automatic cleanup (not a manual save) would.
  const writeFlags = (id: string, members: Identity[]) => {
    const db = cache.__shelfcheckDatabase!;
    db.prepare("UPDATE shelfcheck_coverage_members SET report_missing=0 WHERE mapping_id=?").run(id);
    for (const member of members) db.prepare("UPDATE shelfcheck_coverage_members SET report_missing=1 WHERE mapping_id=? AND provider=? AND episode_id=?").run(id, member.provider, member.id);
  };
  const restart = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };
  return { state, requests, post, status, rerun, mappings, save, setFlags, flags, missing, group, restart, writeFlags };
}
