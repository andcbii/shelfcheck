import { authenticateTvdb } from "@/lib/tvdb-auth";
import "server-only";
import { randomUUID } from "node:crypto";
import { readPlexProviders } from "@/lib/server-config";
import { database } from "@/lib/sqlite";
import { CoverageError } from "@/lib/manual-coverage";
import { ProviderClient } from "@/lib/provider-client";
import type { CoverageMember } from "@/lib/manual-coverage-model";
import type { ProviderYearObservation } from "@/lib/show-year";
const client = new ProviderClient();
/** A resolution: the stored preview token, its reviewed members, and the provider years its show lookups gave. */
export type ResolvedCoverage = { preview: string; members: CoverageMember[]; showYears: ProviderYearObservation[] };
/** The year of a TMDB `first_air_date` ("2005-03-26") or a TVDB series `year` ("2005"); anything else gives none. */
const yearOf = (value: unknown, pattern: RegExp) => {
  const match = typeof value === "string" ? value.match(pattern) : null;
  return match ? Number(match[1]) : undefined;
};
export async function resolveCoverageUrls(urls: unknown): Promise<ResolvedCoverage> {
  // A failed attempt, even one a provider cooldown ended, must not disable later user-requested retries.
  client.forgetProviderDeadlines();
  client.startRun();
  try {
    return await resolveCoverageInputs(urls);
  } catch (error) {
    if (error instanceof CoverageError) throw error;
    throw new CoverageError(`${error instanceof Error ? error.message : "Provider resolution failed."} Check the episode URL or ID and provider credentials, then retry. No Manual Match was saved.`, 503, "provider-unavailable");
  }
}
async function resolveCoverageInputs(urls: unknown): Promise<ResolvedCoverage> {
  if (!Array.isArray(urls) || urls.length < 2 || urls.some(url => typeof url !== "string"))
    throw new CoverageError("Supply nonempty complete TMDB and TVDB episode sets using URLs or provider-qualified IDs.");
  const config = await readPlexProviders();
  if (!config)
    throw new CoverageError("Configure Plex, TMDB, and TVDB credentials before resolving episodes.", 409, "configuration");
  let token: Promise<string> | undefined;
  const tvdbToken = () => token ||= authenticateTvdb(client, config.tvdbApiKey, config.tvdbPin);
  const members: CoverageMember[] = [];
  // The show lookups below are required for identity; the year they carry is optional and never rejects.
  const showYears: ProviderYearObservation[] = [];
  for (const value of urls) {
    const input = value.trim();
    // TMDB has no native episode-ID lookup. Coordinates locate a record; its
    // returned canonical ID must still agree with the explicitly supplied ID.
    let expectedTmdbId: number | undefined;
    let resolvedInput = input;
    const tmdbIdentity = input.match(/^tmdb:(\d+)(?:\s+show:(\d+)\s+season:(\d+)\s+episode:(\d+))?$/i);
    const tvdbIdentity = input.match(/^tvdb:(\d+)$/i);
    if (tmdbIdentity) {
      if (!tmdbIdentity[2])
        throw new CoverageError("TMDB episode IDs need an episode URL or context: tmdb:100 show:10 season:1 episode:2. A show ID alone is not an episode.");
      expectedTmdbId = Number(tmdbIdentity[1]);
      resolvedInput = `https://www.themoviedb.org/tv/${tmdbIdentity[2]}/season/${tmdbIdentity[3]}/episode/${tmdbIdentity[4]}`;
    } else if (tvdbIdentity) {
      resolvedInput = `https://thetvdb.com/series/lookup/episodes/${tvdbIdentity[1]}`;
    }
    let url: URL;
    try {
      url = new URL(resolvedInput);
    } catch {
      throw new CoverageError("Enter a TMDB/TVDB episode URL, tvdb:200, or tmdb:100 show:10 season:1 episode:2.");
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
        first_air_date?: unknown;
      }>(`https://api.themoviedb.org/3/tv/${showId}`, init, "TMDB");
      if (!Number.isSafeInteger(record.id) || !record.id || show.id !== showId || record.season_number !== season || record.episode_number !== episode)
        throw new CoverageError("TMDB could not resolve that episode.");
      if (expectedTmdbId !== undefined && record.id !== expectedTmdbId)
        throw new CoverageError(`TMDB context resolved episode ${record.id}, not ${expectedTmdbId}. Check the episode ID and show/season/episode context.`);
      showYears.push({ provider: "TMDB", showId, year: yearOf(show.first_air_date, /^(\d{4})-\d{2}-\d{2}$/), observedAt: Date.now() });
      members.push({ provider: "TMDB", id: record.id, showId, show: show.name || `TMDB series ${showId}`, title: record.name || "Untitled episode", season, episode, url: `https://www.themoviedb.org/tv/${showId}/season/${season}/episode/${episode}` });
    } else if (host === "thetvdb.com") {
      const match = url.pathname.match(/^\/series\/[^/]+\/episodes\/(\d+)\/?$/);
      if (!match)
        throw new CoverageError("This TVDB URL is not an episode. Open the episode record first.");
      const token = await tvdbToken();
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
          year?: unknown;
        };
      }>(`https://api4.thetvdb.com/v4/series/${record.seriesId}`, init, "TVDB");
      if (show?.id !== record.seriesId || !show.slug)
        throw new CoverageError("TVDB could not resolve the parent show.");
      showYears.push({ provider: "TVDB", showId: record.seriesId, year: yearOf(show.year, /^(\d{4})$/), observedAt: Date.now() });
      members.push({ provider: "TVDB", id: record.id, showId: record.seriesId, show: show.name || `TVDB series ${record.seriesId}`, title: record.name || "Untitled episode", season: record.seasonNumber!, episode: record.number!, url: `https://thetvdb.com/series/${encodeURIComponent(show.slug)}/episodes/${record.id}` });
    } else
      throw new CoverageError("Use an episode URL from TMDB or TVDB.");
  }
  if (new Set(members.map(m => m.provider)).size !== 2)
    throw new CoverageError("Review at least one episode from each provider.");
  const db = database();
  db.prepare("DELETE FROM shelfcheck_coverage_previews WHERE expires<?").run(Date.now());
  const preview = randomUUID();
  db.prepare("INSERT INTO shelfcheck_coverage_previews VALUES(?,?,?)").run(preview, JSON.stringify(members), Date.now() + 30 * 60000);
  return { preview, members, showYears };
}

export function reviewedCoverageMembers(preview: unknown): CoverageMember[] {
  if (typeof preview !== "string")
    throw new CoverageError("Resolve and review both episode records before saving.");
  const db = database();
  const row = db.prepare("SELECT payload FROM shelfcheck_coverage_previews WHERE id=? AND expires>?").get(preview, Date.now()) as {
    payload: string;
  } | undefined;
  if (!row)
    throw new CoverageError("The preview expired. Resolve the episode inputs again.");
  return JSON.parse(row.payload);
}
