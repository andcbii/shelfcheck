import "server-only";
import { randomUUID } from "node:crypto";
import { readPlexProviders } from "@/lib/server-config";
import { coverageDatabase } from "@/lib/sqlite";
import { CoverageError } from "@/lib/manual-coverage";
import { PlexProviderClient } from "@/lib/plex-provider-client";
import type { CoverageMember } from "@/lib/manual-coverage-model";
const client = new PlexProviderClient(() => undefined, () => {
});
export async function resolveCoverageUrls(urls: unknown) {
  if (!Array.isArray(urls) || urls.length !== 2 || urls.some(url => typeof url !== "string"))
    throw new CoverageError("Supply one TMDB episode URL and one TVDB episode URL.");
  const config = await readPlexProviders();
  if (!config)
    throw new CoverageError("Configure Plex, TMDB, and TVDB credentials before resolving episodes.", 409, "configuration");
  const members: CoverageMember[] = [];
  for (const input of urls) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new CoverageError("Enter a valid provider episode URL.");
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new CoverageError("Enter an HTTP provider episode URL.");
    if (host === "themoviedb.org") {
      const match = url.pathname.match(/^\/tv\/(\d+)(?:-[^/]*)?\/season\/(\d+)\/episode\/(\d+)\/?$/);
      if (!match)
        throw new CoverageError("This TMDB URL is not an episode. Open a season and episode first.");
      const showId = Number(match[1]), season = Number(match[2]), episode = Number(match[3]);
      const init = { headers: { Authorization: `Bearer ${config.tmdbToken}` } };
      const record = await client.json<{
        id?: number;
        name?: string;
        season_number?: number;
        episode_number?: number;
      }>(`https://api.themoviedb.org/3/tv/${showId}/season/${season}/episode/${episode}`, init, "TMDB");
      const show = await client.json<{
        id?: number;
        name?: string;
      }>(`https://api.themoviedb.org/3/tv/${showId}`, init, "TMDB");
      if (!record.id || !show.id || record.season_number !== season || record.episode_number !== episode)
        throw new CoverageError("TMDB could not resolve that episode.");
      members.push({ provider: "TMDB", id: record.id, showId, show: show.name || `TMDB series ${showId}`, title: record.name || "Untitled episode", season, episode, url: `https://www.themoviedb.org/tv/${showId}/season/${season}/episode/${episode}` });
    } else if (host === "thetvdb.com") {
      const match = url.pathname.match(/^\/series\/[^/]+\/episodes\/(\d+)\/?$/);
      if (!match)
        throw new CoverageError("This TVDB URL is not an episode. Open the episode record first.");
      const login = await client.json<{
        data?: {
          token?: string;
        } | string;
      }>("https://api4.thetvdb.com/v4/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apikey: config.tvdbApiKey, ...(config.tvdbPin ? { pin: config.tvdbPin } : {}) }) }, "TVDB");
      const token = typeof login.data === "string" ? login.data : login.data?.token;
      if (!token)
        throw new CoverageError("TVDB login did not return a token.", 503, "provider-unavailable");
      const init = { headers: { Authorization: `Bearer ${token}` } };
      const { data: record } = await client.json<{
        data?: {
          id?: number;
          seriesId?: number;
          seasonNumber?: number;
          number?: number;
          name?: string;
        };
      }>(`https://api4.thetvdb.com/v4/episodes/${match[1]}/extended`, init, "TVDB");
      if (!record?.id || record.id !== Number(match[1]) || !record.seriesId || !Number.isInteger(record.seasonNumber) || !Number.isInteger(record.number))
        throw new CoverageError("TVDB could not resolve that episode.");
      const { data: show } = await client.json<{
        data?: {
          id?: number;
          name?: string;
          slug?: string;
        };
      }>(`https://api4.thetvdb.com/v4/series/${record.seriesId}`, init, "TVDB");
      if (!show?.id || !show.slug)
        throw new CoverageError("TVDB could not resolve the parent show.");
      members.push({ provider: "TVDB", id: record.id, showId: record.seriesId, show: show.name || `TVDB series ${record.seriesId}`, title: record.name || "Untitled episode", season: record.seasonNumber!, episode: record.number!, url: `https://thetvdb.com/series/${encodeURIComponent(show.slug)}/episodes/${record.id}` });
    } else
      throw new CoverageError("Use an episode URL from TMDB or TVDB.");
  }
  if (new Set(members.map(m => m.provider)).size !== 2)
    throw new CoverageError("Review one episode from each provider.");
  const db = coverageDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS shelfcheck_coverage_previews(id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires INTEGER NOT NULL)");
  db.prepare("DELETE FROM shelfcheck_coverage_previews WHERE expires<?").run(Date.now());
  const preview = randomUUID();
  db.prepare("INSERT INTO shelfcheck_coverage_previews VALUES(?,?,?)").run(preview, JSON.stringify(members), Date.now() + 30 * 60000);
  return { preview, members };
}

export function reviewedCoverageMembers(preview: unknown): CoverageMember[] {
  if (typeof preview !== "string")
    throw new CoverageError("Resolve and review both episode URLs before saving.");
  const db = coverageDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS shelfcheck_coverage_previews(id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires INTEGER NOT NULL)");
  const row = db.prepare("SELECT payload FROM shelfcheck_coverage_previews WHERE id=? AND expires>?").get(preview, Date.now()) as {
    payload: string;
  } | undefined;
  if (!row)
    throw new CoverageError("The preview expired. Resolve the episode URLs again.");
  return JSON.parse(row.payload);
}
