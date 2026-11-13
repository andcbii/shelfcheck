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

type Provider = "TMDB" | "TVDB";
type Identity = { provider: Provider; id: number };
type Episode = Identity & { season: number; episode: number; name: string };
type Missing = { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: Provider[]; reportedMissing?: Provider[]; incomplete?: Partial<Record<Provider, Identity[]>> };
type Group = { mappingId: string; members: (Identity & { status: string; missingParts?: Identity[] })[] };
type Result = { report: { shows: { missing: Missing[] }[]; coverageGroups?: Group[] } };

// One combined episode is the same content as three split episodes, A, B and C.
// The local Plex file is the complete combined episode, so normal matching
// collects every part through the Manual Match. A separate one-to-one Manual
// Match ("other") is unrelated to the combined episode.
const directions = {
  "TMDB combined": {
    combined: { provider: "TMDB", id: 100, season: 1, episode: 1, name: "Whole" },
    parts: [
      { provider: "TVDB", id: 200, season: 2, episode: 1, name: "Part A" },
      { provider: "TVDB", id: 201, season: 2, episode: 2, name: "Part B" },
      { provider: "TVDB", id: 202, season: 2, episode: 3, name: "Part C" },
    ],
    other: [{ provider: "TMDB", id: 101, season: 1, episode: 2, name: "Other" }, { provider: "TVDB", id: 203, season: 2, episode: 4, name: "Other (TVDB)" }],
  },
  "TVDB combined": {
    combined: { provider: "TVDB", id: 300, season: 3, episode: 1, name: "Whole (TVDB)" },
    parts: [
      { provider: "TMDB", id: 110, season: 2, episode: 1, name: "Part A" },
      { provider: "TMDB", id: 111, season: 2, episode: 2, name: "Part B" },
      { provider: "TMDB", id: 112, season: 2, episode: 3, name: "Part C" },
    ],
    other: [{ provider: "TVDB", id: 301, season: 3, episode: 2, name: "Other (TVDB)" }, { provider: "TMDB", id: 113, season: 2, episode: 4, name: "Other" }],
  },
} satisfies Record<string, { combined: Episode; parts: Episode[]; other: Episode[] }>;
type Direction = (typeof directions)[keyof typeof directions];

const key = (member: Identity) => `${member.provider}:${member.id}`;
const flag = (member: Identity) => ({ provider: member.provider, id: member.id });

async function harness(t: test.TestContext, direction: Direction) {
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
  const catalogue: Episode[] = [direction.combined, ...direction.parts, ...direction.other];
  const tmdb = catalogue.filter(episode => episode.provider === "TMDB");
  const tvdb = catalogue.filter(episode => episode.provider === "TVDB");
  // Plex owns the complete combined episode and the other mapping's source episode,
  // each by provider identity and by Plex coordinates.
  const owned = [direction.combined, direction.other[0]];
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
        // Another library also reports owning the complete combined episode.
        ? [{ ratingKey: "copy-1", updatedAt: 1, parentIndex: 7, index: 7, Guid: [guid(direction.combined)] }]
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
  const restart = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };
  return { state, requests, post, status, rerun, mappings, save, setFlags, flags, missing, group, restart };
}

for (const [name, direction] of Object.entries(directions)) {
  const { combined, parts: [a, b, c], other } = direction;
  const whole = key(combined);

  test(`${name}: reporting one split episode missing keeps the other parts collected and the combined episode incomplete`, async t => {
    const h = await harness(t, direction);
    const saved = await h.save([combined, a, b, c]);
    assert.equal(saved.status, 201, await saved.clone().text());
    const mapping = (await saved.json()).mapping;
    const unrelated = (await (await h.save(other)).json()).mapping;
    assert.deepEqual(h.missing(await h.rerun()), {}, "The directly owned combined episode covers every part through the complete Manual Match");

    // Flag C only. The save rechecks cached results without HTTP or a full scan.
    const before = h.requests.length;
    await h.setFlags(mapping.id, [c]);
    assert.equal(h.requests.length, before, "Saving a flag needs no provider download or Plex enumeration");
    let result = await h.status();
    assert.equal(result.scan.status, "completed");
    assert.deepEqual(h.missing(result), { [key(c)]: "reported-missing", [whole]: `incomplete because ${key(c)}` },
      "C is Reported missing, the combined episode stays missing although it is directly owned and matched by coordinates, and A/B stay collected");
    assert.deepEqual(h.group(result, mapping.id), { [whole]: `incomplete because ${key(c)}`, [key(a)]: "manual", [key(b)]: "manual", [key(c)]: "reported-missing" },
      "Grouped results show the derived status ahead of direct ownership and name the flagged part responsible");
    assert.deepEqual(await h.flags(mapping.id), [key(c)], "The derived status is never saved as a flag");

    // Explicit flags are durable; derived status is recalculated from them.
    h.state.secondLibrary = true;
    assert.deepEqual(h.missing(await h.rerun()), { [key(c)]: "reported-missing", [whole]: `incomplete because ${key(c)}` }, "Another library reporting the combined episode cannot hide it");
    h.restart();
    assert.deepEqual(await h.flags(mapping.id), [key(c)]);
    assert.deepEqual(h.missing(await h.rerun()), { [key(c)]: "reported-missing", [whole]: `incomplete because ${key(c)}` }, "Flags and derived status survive restarts and full scans");
    h.state.secondLibrary = false;

    // Independent decisions: each flagged part contributes, and clearing one removes only its effect.
    await h.setFlags(mapping.id, [b, c]);
    result = await h.status();
    assert.deepEqual(h.missing(result), { [key(b)]: "reported-missing", [key(c)]: "reported-missing", [whole]: `incomplete because ${key(b)},${key(c)}` });
    await h.setFlags(mapping.id, [b]);
    assert.deepEqual(h.missing(await h.status()), { [key(b)]: "reported-missing", [whole]: `incomplete because ${key(b)}` }, "Another flagged part still keeps the combined episode incomplete");

    // An explicit flag on the combined episode is independent of its parts.
    await h.setFlags(mapping.id, [combined, b]);
    result = await h.status();
    assert.deepEqual(h.missing(result), { [key(b)]: "reported-missing", [whole]: "reported-missing" }, "Explicit status outranks the derived one");
    await h.setFlags(mapping.id, [combined]);
    result = await h.status();
    assert.deepEqual(h.missing(result), { [whole]: "reported-missing" }, "Clearing the part keeps the explicitly flagged combined episode missing and infers no missing part");
    assert.deepEqual(h.group(result, mapping.id), { [whole]: "reported-missing", [key(a)]: "manual", [key(b)]: "manual", [key(c)]: "manual" },
      "The flagged combined episode keeps its source evidence, so every part retains Manual Match coverage");
    assert.deepEqual(h.missing(await h.rerun()), { [whole]: "reported-missing" });

    await h.setFlags(mapping.id, []);
    assert.deepEqual(h.missing(await h.status()), {}, "Clearing every flag restores normal matching immediately");
    assert.deepEqual(await h.flags(unrelated.id), [], "Unrelated mappings are untouched");
  });

  test(`${name}: removing flagged members and deleting the mapping withdraw derived status and keep unrelated flags`, async t => {
    const h = await harness(t, direction);
    const saved = await (await h.save([combined, a, b, c], { reportMissing: [flag(b), flag(c)] })).json();
    assert.deepEqual(await h.flags(saved.mapping.id), [key(b), key(c)].sort(), "Flags can be saved with a reviewed one-to-many preview");
    const unrelated = (await (await h.save(other, { reportMissing: [flag(other[1])] })).json()).mapping;
    assert.deepEqual(h.missing(await h.rerun()), { [key(b)]: "reported-missing", [key(c)]: "reported-missing", [whole]: `incomplete because ${key(b)},${key(c)}`, [key(other[1])]: "reported-missing" });

    // Removing C drops only C's flag and its derived effect; C now follows normal matching outside the mapping.
    const edited = await h.save([combined, a, b], { id: saved.mapping.id, revision: saved.mapping.revision });
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.deepEqual(await h.flags(saved.mapping.id), [key(b)]);
    assert.deepEqual(h.missing(await h.status()), { [key(b)]: "reported-missing", [key(c)]: "missing", [whole]: `incomplete because ${key(b)}`, [key(other[1])]: "reported-missing" },
      "The old and new members are rechecked through the cached path");

    // Bulk deletion withdraws the mapping's flags and derived status; unrelated flags remain.
    const bulk = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", { method: "DELETE", body: JSON.stringify({ ids: [saved.mapping.id] }) }));
    assert.equal(bulk.status, 200);
    assert.deepEqual(h.missing(await h.status()), { [key(a)]: "missing", [key(b)]: "missing", [key(c)]: "missing", [key(other[1])]: "reported-missing" },
      "The combined episode is collected again; unmapped parts lose Manual Match coverage");
    assert.deepEqual(await h.flags(unrelated.id), [key(other[1])]);

    // Individual deletion behaves the same way.
    const recreated = (await (await h.save([combined, a, b, c], { reportMissing: [flag(a)] })).json()).mapping;
    assert.deepEqual(h.missing(await h.status()), { [key(a)]: "reported-missing", [whole]: `incomplete because ${key(a)}`, [key(other[1])]: "reported-missing" });
    const single = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${recreated.id}`, { method: "DELETE" }));
    assert.equal(single.status, 200);
    assert.deepEqual(h.missing(await h.status()), { [key(a)]: "missing", [key(b)]: "missing", [key(c)]: "missing", [key(other[1])]: "reported-missing" });
    assert.deepEqual(await h.flags(unrelated.id), [key(other[1])]);
  });
}

test("many-to-many Manual Matches still reject Report Missing", async t => {
  const direction = directions["TMDB combined"];
  const h = await harness(t, direction);
  const both = [direction.combined, direction.other[0], ...direction.parts];
  const flagged = await h.save(both, { reportMissing: [flag(direction.combined), flag(direction.parts[0])] });
  assert.equal(flagged.status, 400);
  assert.equal((await flagged.json()).code, "report-missing-unsupported");
  assert.equal((await h.save(both)).status, 201, "Many-to-many mappings keep working without flags");
});
