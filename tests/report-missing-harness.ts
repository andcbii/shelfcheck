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
export const preferences = await import("../app/api/plex/state/route");
const config = await import("../lib/server-config");
hook.deregister();

// Report Missing API/workflow harness: temporary persistence, one Plex show
// ("Target", TMDB 10 / TVDB 20) and mocked Plex and provider responses built
// from a provider catalogue.
export type Provider = "TMDB" | "TVDB";
export type Identity = { provider: Provider; id: number };
/** A provider episode of "Target" unless `show` places it in the second Plex show, "Other" (TMDB 11 / TVDB 21). */
/** `airDate` defaults to 2020-01-01; `name` may be null as providers sometimes return it; `runtime` (minutes) also sets an owned Plex file's duration. */
export type Episode = Identity & { season: number; episode: number; name: string | null; show?: "other"; airDate?: string; runtime?: number };
type Missing = { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: Provider[]; reportedMissing?: Provider[]; incomplete?: Partial<Record<Provider, Identity[]>> };
type Group = { mappingId: string; members: (Identity & { status: string; missingParts?: Identity[] })[] };
type Result = { report: { shows: { ratingKey: string; missing: Missing[] }[]; coverageGroups?: Group[] } };

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
  const tmdbShowId = (episode: Episode) => episode.show ? 11 : 10;
  const tvdbShowId = (episode: Episode) => episode.show ? 21 : 20;
  const inShow = (id: number) => (episode: Episode) => (episode.provider === "TMDB" ? tmdbShowId(episode) : tvdbShowId(episode)) === id;
  const tmdbAll = catalogue.filter(episode => episode.provider === "TMDB");
  const tvdbAll = catalogue.filter(episode => episode.provider === "TVDB");
  const hasOther = catalogue.some(episode => episode.show);
  // Plex owns each `owned` episode by provider identity and by Plex coordinates.
  const guid = (episode: Episode) => ({ id: `${episode.provider.toLowerCase()}://${episode.id}` });
  // `tvdbChanged`: TVDB series the update feed reports changed, so their catalogues are downloaded again.
  // `tmdbRecords` (by season) and `tvdbRecords`: raw, possibly malformed, catalogue records appended to Target's provider responses.
  // `bodies`/`statuses`: per-pathname provider response overrides (e.g. a malformed `/3/find/301` payload or a 404).
  // `imdb`: an IMDb GUID Plex also carries on the owned file of a provider episode.
  const state = { secondLibrary: false, tvdbChanged: [] as number[], tmdbRecords: {} as Record<number, unknown[]>, tvdbRecords: [] as unknown[], bodies: new Map<string, unknown>(), statuses: new Map<string, number>(), imdb: new Map<number, string>() };
  const requests: string[] = [];
  const show = { ratingKey: "target", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://20" }] };
  const copy = { ratingKey: "copy", title: "Target", Guid: [{ id: "tmdb://10" }, { id: "tvdb://20" }] };
  const otherShow = { ratingKey: "other", title: "Other", Guid: [{ id: "tmdb://11" }, { id: "tvdb://21" }] };
  const library = () => [show, ...(hasOther ? [otherShow] : [])];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const u = new URL(String(input));
    requests.push(u.pathname);
    if (state.statuses.has(u.pathname)) return Response.json({}, { status: state.statuses.get(u.pathname) });
    if (state.bodies.has(u.pathname)) return Response.json(state.bodies.get(u.pathname));
    let body: unknown;
    let match: RegExpMatchArray | null;
    if (u.hostname === "plex") {
      if (u.pathname === "/library/sections") body = { MediaContainer: { Directory: [{ key: "1", type: "show" }, ...(state.secondLibrary ? [{ key: "2", type: "show" }] : [])] } };
      else if (u.pathname.includes("/sections/")) body = { MediaContainer: { Metadata: u.pathname.includes("/sections/2/") ? [copy] : library() } };
      else if (u.pathname.includes("allLeaves")) body = { MediaContainer: { Metadata: u.pathname.includes("/copy/")
        // Another library also reports owning the first owned episode.
        ? [{ ratingKey: "copy-1", updatedAt: 1, parentIndex: 7, index: 7, Guid: [guid(owned[0])] }]
        : owned.filter(episode => Boolean(episode.show) === u.pathname.includes("/other/")).map(episode => ({ ratingKey: `file-${episode.id}`, updatedAt: 1, parentIndex: episode.season, index: episode.episode, ...(episode.runtime && episode.name ? { title: episode.name, duration: episode.runtime * 60_000 } : {}), Guid: [guid(episode), ...(state.imdb.has(episode.id) ? [{ id: `imdb://${state.imdb.get(episode.id)}` }] : [])] })) } };
      else body = { MediaContainer: { Metadata: [u.pathname.includes("/copy") ? copy : u.pathname.includes("/other") ? otherShow : show] } };
    }
    else if (u.pathname === "/v4/login") body = { data: { token: "test" } };
    else if ((match = u.pathname.match(/^\/3\/tv\/(1[01])$/))) {
      const tmdb = tmdbAll.filter(inShow(Number(match[1])));
      body = { id: Number(match[1]), name: match[1] === "10" ? "Target" : "Other", seasons: [...new Set([...tmdb.map(episode => episode.season), ...(match[1] === "10" ? Object.keys(state.tmdbRecords).map(Number) : [])])].map(season_number => ({ season_number })) };
    }
    else if ((match = u.pathname.match(/^\/3\/tv\/(1[01])\/season\/(\d+)$/))) body = { episodes: tmdbAll.filter(inShow(Number(match[1]))).filter(episode => episode.season === Number(match![2])).map((episode): unknown => ({ id: episode.id, season_number: episode.season, episode_number: episode.episode, name: episode.name, air_date: episode.airDate || "2020-01-01", ...(episode.runtime ? { runtime: episode.runtime } : {}) })).concat(match[1] === "10" ? state.tmdbRecords[Number(match[2])] || [] : []) };
    else if ((match = u.pathname.match(/^\/3\/tv\/(1[01])\/season\/(\d+)\/episode\/(\d+)$/))) {
      const episode = tmdbAll.filter(inShow(Number(match[1]))).find(item => item.season === Number(match![2]) && item.episode === Number(match![3]))!;
      body = { id: episode.id, season_number: episode.season, episode_number: episode.episode, name: episode.name };
    }
    else if ((match = u.pathname.match(/^\/v4\/series\/(2[01])$/))) body = { data: { id: Number(match[1]), name: match[1] === "20" ? "Target" : "Other", slug: match[1] === "20" ? "target" : "other" } };
    else if ((match = u.pathname.match(/^\/v4\/series\/(2[01])\/episodes\/default$/))) body = { data: { episodes: tvdbAll.filter(inShow(Number(match[1]))).map((episode): unknown => ({ id: episode.id, seasonNumber: episode.season, number: episode.episode, name: episode.name, aired: episode.airDate || "2020-01-01", ...(episode.runtime ? { runtime: episode.runtime } : {}) })).concat(match[1] === "20" ? state.tvdbRecords : []) } };
    else if ((match = u.pathname.match(/^\/v4\/episodes\/(\d+)\/extended$/))) {
      const episode = tvdbAll.find(item => item.id === Number(match![1]))!;
      body = { data: { id: episode.id, seriesId: tvdbShowId(episode), seasonNumber: episode.season, number: episode.episode, name: episode.name } };
    }
    else if (u.pathname === "/3/tv/changes") body = { results: [], total_pages: 1 };
    else if (u.pathname === "/v4/updates") body = { data: state.tvdbChanged.map(recordId => ({ entityType: "series", recordId })) };
    else if (u.pathname.includes("/find/")) body = { tv_results: [], tv_episode_results: [] };
    else if (u.pathname.startsWith("/search/tvdb/")) body = [];
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
    const resolved = await post({ action: "resolve", urls: members.map(member => member.provider === "TMDB" ? `tmdb:${member.id} show:${tmdbShowId(member)} season:${member.season} episode:${member.episode}` : `tvdb:${member.id}`) });
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
  const missing = (result: Result, show: "target" | "other" = "target") => Object.fromEntries((result.report.shows.find(item => item.ratingKey === `ratingKey:${show}`)?.missing || []).flatMap(episode => episode.sources.map(source => {
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
  // Saves Plex preferences (Ignore rules) as the Plex page sends them.
  const patchSettings = (patch: Record<string, unknown>) => preferences.PATCH(new Request("http://localhost/api/plex/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }));
  const restart = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };
  return { state, requests, patchSettings, post, status, rerun, mappings, save, setFlags, flags, missing, group, restart, writeFlags };
}
