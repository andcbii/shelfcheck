import { reuseProviderCatalogue, tmdbFeedCovers, tmdbVerificationPlan, tvdbVerificationFrom } from "@/lib/plex-catalogue-policy";
import { setCoverageIssue, resolveCoverageIssue, getCoverageIssue, coverageIssueCause, providerLookupContext, type LookupSourceStep } from "@/lib/coverage-issues";
import { AsyncLocalStorage } from "node:async_hooks";
import { usableProviderCatalogue, readPlexInputs, savePlexCatalogue, savePlexComparison, savePlexInventory, saveDeferredTmdbChanges, savePendingTvdbChanges, savePendingSafeguards, saveProviderVerification, saveCompletedFullScan, clearPlexInputs, type PlexGeneratedInputs, type SavedPlexComparison } from "@/lib/plex-catalogues";
import { authenticateTvdb } from "@/lib/tvdb-auth";
import { recheckCoverageHealth } from "@/lib/manual-coverage-health";
import { coverageState, beginCoverageRecheck, clearReportMissingFlags, completeCoverageRecheck, listCoverageMappings, saveCoverageEvidence } from "@/lib/manual-coverage";
import { missingPartsOf, type CoverageMember, type CoverageEvidence, type CoverageIdentity, type CoverageOutcome, type CoverageGroup } from "@/lib/manual-coverage-model";
import "server-only";

import { readPlexProviders } from "@/lib/server-config";
import { createScanLogger, type ScanLogger } from "@/lib/scan-log";
import { clearPlexCheckpoint, clearPlexReport, readPlexCheckpoint, readPlexReport, readPlexScanStatus, readPlexSettings, trackScanIgnores, writePlexCheckpoint, writePlexReport, writePlexScanStatus } from "@/lib/sqlite";
import { validTraktCredentials } from "@/lib/trakt-auth";
import { SHELFCHECK_VERSION } from "@/lib/version";
import type { CompoundCoverage, LocalCompoundEpisode } from "@/lib/compound-episodes";
import { comparePlexShow, type ProviderEpisode } from "@/lib/plex-comparison";
import { ignoredPlexKeys } from "@/lib/ignored-shows";
import { parsePlexPreferences } from "@/lib/preferences";
import { PLEX_SCAN_WORKERS, type PlexProviderName } from "@/lib/plex-provider-policy";
import { ActiveScanTracker, runTrackedWorkerPool, runWorkerPool, type ActiveScanWork } from "@/lib/scan-concurrency";
import { groupPlexShows, hasPlexEpisodeCoordinate, idsFromGuids, plexEpisodeFingerprint, plexFingerprint, type PlexMetadata, type PlexShowGroup } from "@/lib/plex-inventory";
import { PlexProviderClient, ProviderResponseError } from "@/lib/plex-provider-client";
import { checkpointIsUsable, checkpointShowsWithCache, checkpointWithoutRatingKey, mergeScanProgress, plexReportCacheIsUsable, PLEX_CACHE_VERSION, pruneEpisodeIdentityCache, targetedScanCarryOver, type PlexScanCacheEntry } from "@/lib/plex-scan-cache";
import { shouldSaveCheckpoint } from "@/lib/scan-cache";
import type { TmdbFindEpisode } from "@/lib/plex-auto-match";
import { equivalentTmdbShowIds, ownedTmdbEpisodeMatch, tmdbShowLinksToTvdb } from "@/lib/tmdb-show-equivalence";

export type PlexScanStatus = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; startedAt?: string; finishedAt?: string; error?: string; rateLimitPaused?: boolean; rateLimitProvider?: ProviderName; currentShow?: string; currentPhase?: string; activeShows?: ActiveScanWork[]; heartbeatAt?: string };
export type PlexProviderShowMatch = { id: number; name?: string; year?: number; slug?: string };
export type PlexProviderMatches = { tmdb: PlexProviderShowMatch[]; tvdb: PlexProviderShowMatch[] };
export type PlexShow = { ratingKey: string; plexGuid?: string; plexGuids?: string[]; plexRatingKeys?: string[]; title: string; year?: number; thumb?: string; tmdbId?: number; tvdbId?: number; tvdbSlug?: string; plexEpisodes: number };
export type PlexMissingEpisode = { season: number; episode: number; title?: string; airDate?: string; tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: ("TMDB" | "TVDB")[]; reportedMissing?: ("TMDB" | "TVDB")[]; incomplete?: Partial<Record<"TMDB" | "TVDB", CoverageIdentity[]>> };
export type PlexAutoMatchMethod = "Matched via IMDb" | "Matched via Trakt" | "Matched via TMDB External ID" | "Shelfcheck Compound Match";
export type PlexAutoMatchEpisode = { id?: number; showId?: number; showSlug?: string; show: string; name?: string; season: number; episode: number; airDate?: string; url?: string };
export type PlexAutoMatch = { method: PlexAutoMatchMethod; tmdb: PlexAutoMatchEpisode; tvdb: PlexAutoMatchEpisode };
export type PlexProviderResolution = { tmdb: boolean; tvdb: boolean };
export type PlexShowResult = PlexShow & { missing: PlexMissingEpisode[]; coverageOutcomes?: CoverageOutcome[]; providerResolution?: PlexProviderResolution; providerMatches?: PlexProviderMatches; autoMatches?: PlexAutoMatch[]; compoundCoverage?: CompoundCoverage[]; manualCoverage?: { mappingId: string; source: CoverageEvidence[] }[]; warning?: string };
type PlexCacheEntry = PlexScanCacheEntry;
export type PlexReport = { shows: PlexShowResult[]; coverageGroups?: CoverageGroup[]; lastScan: string; startedAt?: string; finishedAt?: string; scanCache?: Record<string, PlexCacheEntry>; cacheVersion?: number; autoCompoundEpisodes?: boolean; coverageRevision?: number };
type PlexCheckpoint = { shows: PlexShowResult[]; scanCache: Record<string, PlexCacheEntry>; cacheVersion: number; savedAt: string; autoCompoundEpisodes?: boolean; coverageRevision?: number };

type PlexContainer = { MediaContainer?: { size?: number; Directory?: PlexMetadata[]; Metadata?: PlexMetadata[] } };
type TmdbShow = { id: number; name?: string; first_air_date?: string | null; seasons?: { season_number: number }[]; external_ids?: { tvdb_id?: number | null } };
type TvdbShow = { id: number; name?: string; slug?: string; year?: string };
type TmdbEpisodeFindResult = TmdbFindEpisode;
type TraktIds = { trakt?: number | null; tmdb?: number | null; tvdb?: number | null };
type TraktEpisodeSearchResult = { type?: string; episode?: { season?: number; number?: number; ids?: TraktIds }; show?: { ids?: TraktIds } };
type TraktCredentials = { clientId: string; accessToken: string };
type ScanGlobal = typeof globalThis & { __shelfcheckPlexScan?: Promise<void>; __shelfcheckPlexLogger?: ScanLogger };

const TMDB = "https://api.themoviedb.org/3";
const TVDB = "https://api4.thetvdb.com/v4";
const TRAKT = "https://api.trakt.tv";
const CACHE_VERSION = PLEX_CACHE_VERSION;
type ProviderName = PlexProviderName;

function replaceStatus(status: PlexScanStatus) { writePlexScanStatus(status); }
function updateStatus(progress: Partial<PlexScanStatus>) {
  writePlexScanStatus(mergeScanProgress(getPlexScanStatus(), progress));
}

const providerClient = new PlexProviderClient(
  () => (globalThis as ScanGlobal).__shelfcheckPlexLogger,
  (provider, paused) => {
    const current = getPlexScanStatus();
    if (current.status === "running" && (paused || current.rateLimitProvider === provider)) updateStatus({ rateLimitPaused: paused, rateLimitProvider: paused ? provider : undefined });
  },
);

const comparisonIssueScope = new AsyncLocalStorage<{ratingKey:string;title?:string;tmdbId?:number;tvdbId?:number;tmdbSource?:LookupSourceStep[];tvdbSource?:LookupSourceStep[];providerEpisodes?:ProviderEpisode[];tmdbCached?:boolean;tvdbCached?:boolean;tvdbAuthenticationError?:unknown}>();
const lookupSourceScope = new AsyncLocalStorage<LookupSourceStep[]>();
const replayScope = new AsyncLocalStorage<{missing:Set<string>}>();
const relationshipScope = new AsyncLocalStorage<SavedPlexComparison["relationships"]>();
function relationshipIsReusable(key:string) {
  const relationships = relationshipScope.getStore();
  const show = comparisonIssueScope.getStore();
  return Boolean(relationships && Object.hasOwn(relationships,key) && (replayScope.getStore() || !getCoverageIssue(`episode-identity:${show?.ratingKey}:${key}`)));
}
async function checkedJson<T>(url: string, init: RequestInit, provider: ProviderName, episodeIdentity?: {provider:"TMDB"|"TVDB";id:number}): Promise<T> {
  const relationships = relationshipScope.getStore();
  const key = `${provider}:${url}`;
  const show = comparisonIssueScope.getStore();
  const issueId = `episode-identity:${show?.ratingKey}:${key}`;
  if (relationships && relationshipIsReusable(key)) return relationships[key].value as T;
  const replay=replayScope.getStore();
  if (replay) { replay.missing.add(key); throw new Error(`Saved provider identity relationship is missing: ${key}`); }
  const endpoint = new URL(url);
  const tvdbEpisodeId = endpoint.pathname.match(/\/(?:episodes|search\/tvdb)\/(\d+)/)?.[1];
  const findId = endpoint.pathname.match(/\/find\/(\d+)/)?.[1];
  const coordinate = endpoint.pathname.match(/\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)/);
  const matching = Boolean(tvdbEpisodeId || findId || coordinate || provider === "Trakt");
  let value: T;
  try {
    if (provider === "TVDB" && show?.tvdbAuthenticationError) throw show.tvdbAuthenticationError;
    value = await providerClient.json<T>(url, init, provider);
  }
  catch (error) {
    if (show && matching) {
      const externalId = episodeIdentity?.id;
      setCoverageIssue({id:issueId,...(provider === "TVDB" && error === show.tvdbAuthenticationError ? {causedBy:["provider-authentication:TVDB"]} : {}),operation:findId && !episodeIdentity ? "provider-association" : "episode-identity",provider,scope:tvdbEpisodeId || externalId || coordinate ? "episode" : "show",show:{ratingKey:show.ratingKey,title:show.title,tmdbId:show.tmdbId,tvdbId:show.tvdbId},
        ...(tvdbEpisodeId || externalId ? {episode:{provider:"TVDB" as const,id:Number(tvdbEpisodeId || externalId),showId:show.tvdbId,...((e)=>e ? {season:e.season,episode:e.episode,title:e.title} : {})(show.providerEpisodes?.find(e=>e.source === "TVDB" && e.providerEpisodeId === Number(tvdbEpisodeId || externalId)))}} : coordinate ? {episode:{provider:"TMDB" as const,...(lookupSourceScope.getStore()?.at(-1)?.kind === "external TMDB episode ID" ? {id:lookupSourceScope.getStore()!.at(-1)!.id} : {}),showId:Number(coordinate[1]),season:Number(coordinate[2]),episode:Number(coordinate[3])}} : {}),
        ...providerLookupContext(error,{
          source: lookupSourceScope.getStore() || (tvdbEpisodeId || externalId
            ? [...(show.tvdbSource || []),{provider:"TVDB",kind:"catalogue episode",id:Number(tvdbEpisodeId || externalId),cached:show.tvdbCached}]
            : findId ? show.tvdbSource || [] : []),
          requested:{provider,kind:findId ? "external ID search" : coordinate ? `show ${coordinate[1]} season ${coordinate[2]} episode` : "episode",...(findId || tvdbEpisodeId ? {id:Number(findId || tvdbEpisodeId)} : coordinate ? {id:Number(coordinate[3])} : {})},
          impact:"Episode identity and coverage could not be fully verified. Available last-good results were retained.",
        })});
    }
    throw error;
  }
  if (show && matching) resolveCoverageIssue(issueId);
  if (relationships) relationships[key] = {provider, value};
  return value;
}

async function plexJson(path: string, url: string, token: string): Promise<PlexContainer> {
  const body = await checkedJson<PlexContainer>(`${url}${path}`, { headers: { Accept: "application/json", "X-Plex-Token": token, "X-Plex-Client-Identifier": "shelfcheck" } }, "Plex");
  const pathname = path.split("?")[0];
  const field = pathname === "/library/sections" ? "Directory" : "Metadata";
  const collection = /^\/library\/(?:sections(?:\/[^/]+\/all)?|metadata\/[^/]+\/allLeaves)$/.test(pathname);
  const container = body?.MediaContainer;
  // Plex may omit children on explicitly empty collections, but never certify
  // incomplete singleton lookups or malformed child fields as empty inventory.
  if (collection && container?.size === 0 && !Object.hasOwn(container, field)) container[field] = [];
  if (!Array.isArray(container?.[field])) throw new ProviderResponseError("Plex",{provider:"Plex",kind:field === "Directory" ? "library sections" : "library inventory"});
  return body;
}

async function tmdbJson<T>(path: string, token: string, episodeIdentity?: {provider:"TMDB"|"TVDB";id:number}): Promise<T> {
  return checkedJson<T>(`${TMDB}${path}`, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }, "TMDB", episodeIdentity);
}

async function traktJson<T>(path: string, credentials: TraktCredentials): Promise<T> {
  return checkedJson<T>(`${TRAKT}${path}`, { headers: {
    Accept: "application/json",
    Authorization: `Bearer ${credentials.accessToken}`,
    "trakt-api-key": credentials.clientId,
    "trakt-api-version": "2",
    "User-Agent": `Shelfcheck/${SHELFCHECK_VERSION} (+https://github.com/andcbii/shelfcheck)`,
  } }, "Trakt");
}

async function getTmdbShow(tmdbId: number | undefined, tvdbId: number | undefined, token: string, resolved?: (id:number)=>void): Promise<TmdbShow | null> {
  if (tmdbId) return tmdbJson<TmdbShow>(`/tv/${tmdbId}?append_to_response=external_ids`, token);
  if (!tvdbId) return null;
  const found = await tmdbJson<{ tv_results?: TmdbShow[] }>(`/find/${tvdbId}?external_source=tvdb_id`, token);
  const show = found.tv_results?.[0];
  if (show) resolved?.(show.id);
  return show ? tmdbJson<TmdbShow>(`/tv/${show.id}?append_to_response=external_ids`, token) : null;
}

async function tmdbEpisodes(show: TmdbShow, token: string): Promise<ProviderEpisode[]> {
  if (!Number.isFinite(show.id) || !Array.isArray(show.seasons)) throw new Error("TMDB returned an incomplete show catalogue.");
  const seasons = show.seasons;
  const responses = await Promise.all(seasons.map(async (season) => {
    const response = await tmdbJson<{ episodes?: { id?: number; season_number: number; episode_number: number; name?: string; air_date?: string | null; runtime?: number | null }[] }>(`/tv/${show.id}/season/${season.season_number}`, token);
    if (!Array.isArray(response.episodes)) throw new ProviderResponseError("TMDB",{provider:"TMDB",kind:`show ${show.id} season`,id:season.season_number});
    return response;
  }));
  return responses.flatMap((season) => (season.episodes || []).map((episode) => ({ showTitle: show.name, season: episode.season_number, episode: episode.episode_number, title: episode.name, airDate: episode.air_date || undefined, runtime: episode.runtime || undefined, providerEpisodeId: episode.id, source: "TMDB" as const })));
}

async function findTmdbEpisodeByTvdbId(tvdbEpisodeId: number, token: string): Promise<TmdbEpisodeFindResult[]> {
  const found = await tmdbJson<{ tv_episode_results?: TmdbEpisodeFindResult[] }>(`/find/${tvdbEpisodeId}?external_source=tvdb_id`, token, {provider:"TVDB",id:tvdbEpisodeId});
  return found.tv_episode_results || [];
}

async function tmdbShowsForTvdbId(tvdbShowId: number, token: string): Promise<TmdbShow[]> {
  const found = await tmdbJson<{ tv_results?: TmdbShow[] }>(`/find/${tvdbShowId}?external_source=tvdb_id`, token);
  return found.tv_results || [];
}

async function tvdbShow(seriesId: number, token: string): Promise<TvdbShow | null> {
  const response = await checkedJson<{ data?: { id?: number; name?: string; slug?: string; year?: string } }>(`${TVDB}/series/${seriesId}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
  return response.data ? { id: response.data.id || seriesId, name: response.data.name, slug: response.data.slug, year: response.data.year } : null;
}

async function findEpisodeViaTrakt(tvdbEpisodeId: number, equivalentTmdbIds: Set<number>, tvdbShowId: number, localTmdbEpisodeIds: Set<number>, credentials: TraktCredentials, tmdbToken: string) {
  const cached = relationshipIsReusable(`Trakt:${TRAKT}/search/tvdb/${tvdbEpisodeId}?type=episode`);
  const results = await traktJson<TraktEpisodeSearchResult[]>(`/search/tvdb/${tvdbEpisodeId}?type=episode`, credentials);
  const sameShow = results.filter((result) => result.type === "episode" && Number.isFinite(result.show?.ids?.tmdb) && equivalentTmdbIds.has(result.show!.ids!.tmdb as number) && result.show?.ids?.tvdb === tvdbShowId);
  const completeMappings = sameShow.filter((result) => result.episode?.ids?.tvdb === tvdbEpisodeId && Number.isFinite(result.episode.ids.tmdb) && Number.isFinite(result.episode.season) && Number.isFinite(result.episode.number));
  if (!completeMappings.length) return { validated: false, owned: false, validationFailed: 0, traktTmdbIds: [] as number[], validatedTmdbIds: [] as number[] };
  const validations = await Promise.allSettled(completeMappings.map(async (result) => {
    const episode = result.episode!;
    const matchedTmdbShowId = result.show!.ids!.tmdb as number;
    const origin = comparisonIssueScope.getStore();
    const details = await lookupSourceScope.run([
      ...(origin?.tvdbSource || []),{provider:"TVDB",kind:"catalogue episode",id:tvdbEpisodeId,cached:origin?.tvdbCached},
      {provider:"Trakt",kind:"external TMDB show ID",id:matchedTmdbShowId,cached},
      {provider:"Trakt",kind:"external TMDB episode ID",id:episode.ids!.tmdb as number,cached},
    ],()=>tmdbJson<{ id?: number }>(`/tv/${matchedTmdbShowId}/season/${episode.season}/episode/${episode.number}`, tmdbToken));
    return details.id === episode.ids!.tmdb ? details.id : undefined;
  }));
  const validatedIds = validations.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  return { validated: validatedIds.length > 0, owned: validatedIds.some((id) => localTmdbEpisodeIds.has(id)), ownedTmdbId: validatedIds.find((id) => localTmdbEpisodeIds.has(id)), validationFailed: validations.length - validatedIds.length, traktTmdbIds: completeMappings.map((result) => result.episode!.ids!.tmdb as number), validatedTmdbIds: validatedIds };
}

async function tvdbSeries(seriesId: number, token: string, cachedSlug?: string, showTitle?: string): Promise<{ episodes: ProviderEpisode[]; slug?: string; name?: string }> {
  const episodes: ProviderEpisode[] = [];
  const series = cachedSlug ? null : await checkedJson<{ data?: { slug?: string; name?: string } }>(`${TVDB}/series/${seriesId}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
  if (!cachedSlug && !series?.data) throw new Error("TVDB returned an incomplete series catalogue.");
  let page = 0;
  while (page < 100) {
    const body = await checkedJson<{ data?: { episodes?: { id?: number; seasonNumber?: number; number?: number; name?: string; aired?: string; runtime?: number }[] }; links?: { next?: string | null } }>(`${TVDB}/series/${seriesId}/episodes/default?page=${page}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
    if (!Array.isArray(body.data?.episodes)) throw new ProviderResponseError("TVDB",{provider:"TVDB",kind:"series episode catalogue",id:seriesId});
    // Specials (season 0) are kept so Report Missing can be evaluated on them; the
    // comparator still ignores unflagged specials, as before.
    for (const episode of body.data.episodes) if ((episode.seasonNumber || 0) >= 0 && episode.number) {
      episodes.push({ showTitle: series?.data?.name || showTitle, season: episode.seasonNumber || 0, episode: episode.number, title: episode.name, airDate: episode.aired, runtime: episode.runtime, providerEpisodeId: episode.id, source: "TVDB" });
    }
    if (!body.links?.next) break;
    page += 1;
    if (page >= 100) throw new Error("TVDB episode catalogue exceeded the safe pagination limit.");
  }
  return { episodes, slug: cachedSlug || series?.data?.slug, name: series?.data?.name };
}

async function tvdbEpisodeImdbIds(episodeId: number, token: string) {
  const body = await checkedJson<{ data?: { remoteIds?: { id?: string }[] } }>(`${TVDB}/episodes/${episodeId}/extended`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
  return new Set((body.data?.remoteIds || []).flatMap((remote) => remote.id?.match(/^tt\d+$/i) ? [remote.id.toLowerCase()] : []));
}

async function tmdbChangedShows(since: string, token: string, now: string): Promise<Set<number> | null> {
  if (!tmdbFeedCovers(since, now)) return null;
  const start = new Date(since);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = now.slice(0, 10);
  const changed = new Set<number>();
  let page = 1;
  let pages = 1;
  do {
    const body = await tmdbJson<{ results?: { id?: number }[]; total_pages?: number }>(`/tv/changes?start_date=${startDate}&end_date=${endDate}&page=${page}`, token);
    if (!Array.isArray(body.results)) throw new Error("TMDB returned an incomplete change feed.");
    for (const item of body.results || []) if (item.id) changed.add(item.id);
    if ((body.total_pages || 1) > 500) throw new Error("TMDB change feed exceeded the safe pagination limit.");
    pages = Math.max(1, body.total_pages || 1);
    page += 1;
  } while (page <= pages);
  return changed;
}

async function tvdbChangedShows(since: string, token: string): Promise<Set<number>> {
  const timestamp = Math.max(0, Math.floor(Date.parse(since) / 1000) - 60);
  if (!timestamp) throw new Error("The prior TVDB checkpoint is invalid.");
  const changed = new Set<number>();
  let page = 0;
  let complete = false;
  while (page < 500) {
    const body = await checkedJson<{ data?: { entityType?: string; recordId?: number; seriesId?: number }[]; links?: { next?: string | null } }>(`${TVDB}/updates?since=${timestamp}&page=${page}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
    if (!Array.isArray(body.data)) throw new Error("TVDB returned an incomplete update feed.");
    for (const update of body.data) {
      if (update.seriesId) changed.add(update.seriesId);
      else if (update.entityType === "series" && update.recordId) changed.add(update.recordId);
    }
    if (!body.links?.next) { complete = true; break; }
    page += 1;
  }
  if (!complete) throw new Error("TVDB update feed exceeded the safe pagination limit.");
  return changed;
}

/** Visibly mark a provider's catalogue freshness as unverified after its change check fails. */
function setProviderVerificationIssue(provider: "TMDB" | "TVDB", error: unknown, causedBy?: string[]) {
  setCoverageIssue({id:`provider-verification:${provider}`,...(causedBy ? {causedBy} : {}),operation:"provider-verification",provider,scope:"library",...providerLookupContext(error,{source:[],requested:{provider,kind:provider === "TMDB" ? "show change feed" : "series update feed"},impact:"Provider catalogue freshness could not be verified. Available saved data and successful-download timestamps were retained."})});
}

/**
 * Durably retain verified changes before any processing, so a provider's verification
 * position can advance even when a changed show cannot be handled during this scan.
 */
function retainVerifiedChanges(inputs: PlexGeneratedInputs, tmdb: Set<number> | null, tvdb: Set<number> | null) {
  const retain = (changes: Set<number> | null, catalogues: Record<string, unknown>, pending: Record<string, true>, save: (pending: Record<string, true>) => void) => {
    const added = [...changes || []].filter(id => catalogues[String(id)] && !pending[String(id)]);
    for (const id of added) pending[String(id)] = true;
    if (added.length) save(pending);
  };
  retain(tmdb, inputs.tmdb, inputs.deferredTmdbChanges, saveDeferredTmdbChanges);
  retain(tvdb, inputs.tvdb, inputs.pendingTvdbChanges, savePendingTvdbChanges);
  for (const [ratingKey, comparison] of Object.entries(inputs.comparisons)) {
    // Primary TMDB changes are retained above with their own same-day reuse rule.
    const tmdbStale = !comparison.staleRelationships?.tmdb && Boolean(tmdb && comparison.tmdbAliases?.some(id => id !== comparison.tmdbId && tmdb.has(id)));
    const tvdbStale = !comparison.staleRelationships?.tvdb && Boolean(tvdb && comparison.tvdbAliases?.some(id => tvdb.has(id)));
    if (!tmdbStale && !tvdbStale) continue;
    comparison.staleRelationships = {...comparison.staleRelationships, ...(tmdbStale ? {tmdb: true} : {}), ...(tvdbStale ? {tvdb: true} : {})};
    savePlexComparison(ratingKey, comparison);
  }
}

/**
 * A safeguard is fulfilled once its change list is retrieved and each changed library show with a
 * saved TMDB catalogue holds a durable refresh obligation; otherwise it stays pending.
 */
function retainSafeguard(inputs: PlexGeneratedInputs, utcDate: string, changes: Set<number> | null, candidates: PlexShowGroup[]) {
  if (changes === null) {
    if (!inputs.pendingSafeguards[utcDate]) { inputs.pendingSafeguards[utcDate] = true; savePendingSafeguards(inputs.pendingSafeguards); }
    return;
  }
  for (const group of candidates) {
    const comparison = inputs.comparisons[group.identity];
    if (!comparison?.tmdbId || !changes.has(comparison.tmdbId) || !inputs.tmdb[String(comparison.tmdbId)] || comparison.refresh?.tmdb) continue;
    comparison.refresh = {...comparison.refresh, tmdb: true};
    savePlexComparison(group.identity, comparison);
  }
  if (inputs.pendingSafeguards[utcDate]) { delete inputs.pendingSafeguards[utcDate]; savePendingSafeguards(inputs.pendingSafeguards); }
}

/**
 * Fulfil safeguards left pending on earlier UTC days once TMDB verification succeeds.
 *
 * A safeguard is left pending only on its own day, while TMDB's verification position is no later
 * than that day, and the position advances only after verification succeeds. So the first later
 * successful verification covers the safeguard's whole original day. Either its change feed starts
 * on or before that day, and the changes are retained as deferred changes that cannot use same-day
 * reuse after midnight, or TMDB verification recovery refreshes every catalogue the feed cannot
 * cover. The new day's list does not replace the missed interval, and the new day's count stays
 * independent. Today's pending safeguard still needs today's own list (see retainSafeguard).
 */
function fulfilOverdueSafeguards(inputs: PlexGeneratedInputs, utcDate: string) {
  const overdue = Object.keys(inputs.pendingSafeguards).filter(day => day < utcDate);
  for (const day of overdue) delete inputs.pendingSafeguards[day];
  if (overdue.length) savePendingSafeguards(inputs.pendingSafeguards);
}

type LoadedComparison = {
  group: PlexShowGroup; details: PlexMetadata[]; localMetadata: PlexMetadata[];
  tmdbId?: number; tvdbId?: number; tmdbShow: TmdbShow | null; tvdbResolved: boolean; tvdbSlug?: string;
  providerEpisodes: ProviderEpisode[]; tmdbEpisodeAliases: Set<number>; cachedTvdbEpisodeImdbIds: Record<string,string[]>;
  libraryTmdbEpisodeIds: Set<number>; libraryTvdbEpisodeIds: Set<number>; libraryImdbEpisodeIds: Set<string>;
  mappings: ReturnType<typeof listCoverageMappings>; manualInventory: CoverageEvidence[]; autoCompoundEpisodes: boolean;
  config: {tmdbToken:string}; token: string; traktCredentials: TraktCredentials | null;
  tvdbChanges: Set<number> | null; logger: Pick<ScanLogger,"info"|"warn">;
  addWarning: (message:string)=>void; setHeartbeat: (key:string,title:string,phase:string)=>void;
};
/** Ordinary automatic ownership excludes ignored shows; manual evidence keeps all items. */
function libraryInventoryIndex(groups: PlexShowGroup[], items: Record<string, PlexMetadata[]>, ignored: Set<string>) {
  const libraryTmdbEpisodeIds = new Set<number>();
  const libraryTvdbEpisodeIds = new Set<number>();
  const libraryImdbEpisodeIds = new Set<string>();
  for (const group of groups) {
    if (ignored.has(group.identity)) continue;
    for (const record of group.records) for (const episode of items[record.ratingKey || ""] || []) {
      const ids = idsFromGuids(episode.Guid);
      if (ids.tmdbId) libraryTmdbEpisodeIds.add(ids.tmdbId);
      if (ids.tvdbId) libraryTvdbEpisodeIds.add(ids.tvdbId);
      if (ids.imdbId) libraryImdbEpisodeIds.add(ids.imdbId);
    }
  }
  return {libraryTmdbEpisodeIds, libraryTvdbEpisodeIds, libraryImdbEpisodeIds};
}

function localComparisonInventory(localMetadata: PlexMetadata[]) {
  const localEpisodes = new Set(localMetadata.filter(hasPlexEpisodeCoordinate).map(episode => `${episode.parentIndex}:${episode.index}`));
  const localProviderEpisodes: LocalCompoundEpisode[] = localMetadata.flatMap(episode => {
    if (!hasPlexEpisodeCoordinate(episode)) return [];
    const ids=idsFromGuids(episode.Guid);
    return [{season:episode.parentIndex as number,episode:episode.index,title:episode.title,runtime:episode.duration ? episode.duration/60_000 : undefined,tmdbEpisodeId:ids.tmdbId,tvdbEpisodeId:ids.tvdbId,imdbEpisodeId:ids.imdbId}];
  });
  return {localEpisodes,localProviderEpisodes,localTmdbEpisodeIds:new Set(localProviderEpisodes.flatMap(e=>e.tmdbEpisodeId ? [e.tmdbEpisodeId] : []))};
}
/** Resolve automatic evidence once, using either live saved relationships or strict saved-input replay. */
async function compareLoadedPlexShow(input: LoadedComparison) {
  const {group,details,localMetadata,tmdbId,tvdbId,tmdbShow,tvdbResolved,tvdbSlug,providerEpisodes,tmdbEpisodeAliases,libraryTmdbEpisodeIds,libraryTvdbEpisodeIds,libraryImdbEpisodeIds,mappings,manualInventory,autoCompoundEpisodes,config,token,traktCredentials,tvdbChanges,logger,addWarning,setHeartbeat}=input;
  let {cachedTvdbEpisodeImdbIds}=input;
  let warning: string | undefined;
  const primary=group.records[0], ratingKey=group.identity;
  const plexGuids=[...new Set(details.flatMap(d=>d.guid?.startsWith("plex://show/") ? [d.guid] : []))];
  const plexTmdbIds=[...new Set(details.flatMap(d=>{const id=idsFromGuids(d.Guid).tmdbId;return id ? [id] : [];}))];
  const plexTvdbIds=[...new Set(details.flatMap(d=>{const id=idsFromGuids(d.Guid).tvdbId;return id ? [id] : [];}))];
  const {localEpisodes,localProviderEpisodes,localTmdbEpisodeIds}=localComparisonInventory(localMetadata);
  let tmdbSeriesMatches: TmdbShow[]=[], tvdbSeriesMatches: TvdbShow[]=[], equivalentTmdbIds=new Set<number>();
  const autoMatchEvidence=new Map<number,{method:PlexAutoMatchMethod;tmdbEpisodeId:number;tmdbEpisode?:TmdbEpisodeFindResult}>();
  const phaseTimings: Record<string,number>={};
  const recordWarning=(message:string)=>{warning=warning ? `${warning} ${message}` : message;addWarning(message);};
        if (tvdbId) {
          tmdbSeriesMatches = await tmdbShowsForTvdbId(tvdbId, config.tmdbToken).catch((error) => {
            logger.warn("plex.show.tmdb-equivalent-series-unavailable", { ratingKey, tmdbShowId: tmdbShow?.id, tvdbShowId: tvdbId, error: error instanceof Error ? error.message : String(error) });
            return [];
          });
        }
        const knownTmdbIds = new Set(tmdbSeriesMatches.map((show) => show.id));
        const extraTmdbShows = await Promise.allSettled(plexTmdbIds.filter((id) => !knownTmdbIds.has(id) && id !== tmdbShow?.id).map((id) => tmdbJson<TmdbShow>(`/tv/${id}`, config.tmdbToken)));
        tmdbSeriesMatches = [...tmdbSeriesMatches, ...(tmdbShow ? [tmdbShow] : []), ...extraTmdbShows.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])].filter((show, index, matches) => matches.findIndex((candidate) => candidate.id === show.id) === index);
        // Episode-discovered aliases describe provider relationships, independently of
        // whether the current library still owns one of their episodes.
        const savedAliasSummaries = await Promise.allSettled([...tmdbEpisodeAliases].filter(id => !tmdbSeriesMatches.some(show => show.id === id)).map(id => tmdbJson<TmdbShow>(`/tv/${id}?append_to_response=external_ids`, config.tmdbToken)));
        tmdbSeriesMatches.push(...savedAliasSummaries.flatMap(result => result.status === "fulfilled" ? [result.value] : []));
        equivalentTmdbIds = tmdbShow?.id || tmdbId ? equivalentTmdbShowIds((tmdbShow?.id || tmdbId)!, tmdbSeriesMatches) : new Set<number>();
        const tvdbSummaries = await Promise.allSettled(plexTvdbIds.map((id) => tvdbShow(id, token)));
        tvdbSeriesMatches = tvdbSummaries.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
        for (const id of plexTvdbIds) if (!tvdbSeriesMatches.some((show) => show.id === id)) tvdbSeriesMatches.push({ id });
        const coordinateMissingTvdbIds = new Set(providerEpisodes.filter((episode) => episode.source === "TVDB" && episode.season > 0 && episode.providerEpisodeId && !localEpisodes.has(`${episode.season}:${episode.episode}`)).map((episode) => episode.providerEpisodeId as number));
        if (!tvdbId || tvdbChanges === null || tvdbChanges.has(tvdbId)) cachedTvdbEpisodeImdbIds = {};
        const directTvdbSatisfied = new Set<number>([...coordinateMissingTvdbIds].filter((id) => libraryTvdbEpisodeIds.has(id)));
        const directImdbSatisfied = new Set<number>();
        const traktSatisfied = new Set<number>();
        const tmdbSatisfied = new Set<number>();
        const locallySatisfiedTvdbIds = new Set<number>(directTvdbSatisfied);
        for (const tvdbEpisodeId of locallySatisfiedTvdbIds) logger.info("plex.show.episode-crosswalk-decision", { ratingKey, tvdbShowId: tvdbId, tvdbEpisodeId, outcome: "reconciled-by-direct-plex-tvdb-guid" });
        if (libraryImdbEpisodeIds.size) {
          const canReuseTvdbEpisodeIds = Boolean(tvdbId && tvdbChanges !== null && !tvdbChanges.has(tvdbId));
          const imdbLookups = await Promise.allSettled([...coordinateMissingTvdbIds].filter((id) => !locallySatisfiedTvdbIds.has(id)).map(async (tvdbEpisodeId) => {
            const cached = canReuseTvdbEpisodeIds ? cachedTvdbEpisodeImdbIds[String(tvdbEpisodeId)] : undefined;
            const imdbIds = cached ? new Set(cached) : await tvdbEpisodeImdbIds(tvdbEpisodeId, token);
            cachedTvdbEpisodeImdbIds[String(tvdbEpisodeId)] = [...imdbIds];
            return { tvdbEpisodeId, imdbIds };
          }));
          const failedImdbLookups = imdbLookups.filter((lookup) => lookup.status === "rejected").length;
          if (failedImdbLookups) recordWarning(`${failedImdbLookups} TVDB IMDb identity ${failedImdbLookups === 1 ? "lookup" : "lookups"} failed; this show will be checked again next scan.`);
          for (const lookup of imdbLookups) if (lookup.status === "fulfilled" && [...lookup.value.imdbIds].some((id) => libraryImdbEpisodeIds.has(id))) {
            locallySatisfiedTvdbIds.add(lookup.value.tvdbEpisodeId);
            directImdbSatisfied.add(lookup.value.tvdbEpisodeId);
            const localMatch = localProviderEpisodes.find((episode) => episode.tmdbEpisodeId && episode.imdbEpisodeId && lookup.value.imdbIds.has(episode.imdbEpisodeId));
            if (localMatch?.tmdbEpisodeId) autoMatchEvidence.set(lookup.value.tvdbEpisodeId, { method: "Matched via IMDb", tmdbEpisodeId: localMatch.tmdbEpisodeId });
            logger.info("plex.show.episode-crosswalk-decision", { ratingKey, tvdbShowId: tvdbId, tvdbEpisodeId: lookup.value.tvdbEpisodeId, imdbEpisodeIds: [...lookup.value.imdbIds], outcome: "reconciled-by-direct-imdb-guid" });
          }
        }
        const crosswalkCandidateTvdbIds = new Set([...coordinateMissingTvdbIds].filter((id) => !locallySatisfiedTvdbIds.has(id)));
        if (tmdbShow && crosswalkCandidateTvdbIds.size && libraryTmdbEpisodeIds.size) {
          setHeartbeat(ratingKey, primary.title || "Unknown show", "episode-crosswalk");
          const crosswalkStarted = Date.now();
          const tmdbFallbackIds = new Set(crosswalkCandidateTvdbIds);
          const crosswalkDecisions = new Map<number, string>();
          const crosswalkDetails = new Map<number, { traktTmdbIds?: number[]; validatedTmdbIds?: number[]; tmdbFindIds?: number[] }>();
          let traktReconciled = 0;
          let traktValidatedNotOwned = 0;
          let traktValidationFailed = 0;
          let traktInvalid = 0;
          let traktFailed = 0;
          const traktFailureReasons = new Set<string>();
          if (traktCredentials && tvdbId) {
            const traktCrosswalks = await Promise.allSettled([...crosswalkCandidateTvdbIds].map(async (tvdbEpisodeId) => ({ tvdbEpisodeId, result: await findEpisodeViaTrakt(tvdbEpisodeId, equivalentTmdbIds, tvdbId!, libraryTmdbEpisodeIds, traktCredentials, config.tmdbToken) })));
            for (const crosswalk of traktCrosswalks) {
              if (crosswalk.status === "rejected") {
                traktFailed += 1;
                traktFailureReasons.add(crosswalk.reason instanceof Error ? crosswalk.reason.message : String(crosswalk.reason));
                continue;
              }
              if (!crosswalk.value.result.validated) {
                crosswalkDetails.set(crosswalk.value.tvdbEpisodeId, { traktTmdbIds: crosswalk.value.result.traktTmdbIds, validatedTmdbIds: crosswalk.value.result.validatedTmdbIds });
                traktValidationFailed += crosswalk.value.result.validationFailed;
                traktInvalid += 1;
                crosswalkDecisions.set(crosswalk.value.tvdbEpisodeId, "trakt-invalid-tmdb-fallback");
                continue;
              }
              traktValidationFailed += crosswalk.value.result.validationFailed;
              crosswalkDetails.set(crosswalk.value.tvdbEpisodeId, { traktTmdbIds: crosswalk.value.result.traktTmdbIds, validatedTmdbIds: crosswalk.value.result.validatedTmdbIds });
              if (crosswalk.value.result.owned) {
                tmdbFallbackIds.delete(crosswalk.value.tvdbEpisodeId);
                locallySatisfiedTvdbIds.add(crosswalk.value.tvdbEpisodeId);
                traktSatisfied.add(crosswalk.value.tvdbEpisodeId);
                if (crosswalk.value.result.ownedTmdbId) autoMatchEvidence.set(crosswalk.value.tvdbEpisodeId, { method: "Matched via Trakt", tmdbEpisodeId: crosswalk.value.result.ownedTmdbId });
                traktReconciled += 1;
                crosswalkDecisions.set(crosswalk.value.tvdbEpisodeId, "reconciled-by-validated-trakt");
              } else { traktValidatedNotOwned += 1; crosswalkDecisions.set(crosswalk.value.tvdbEpisodeId, "trakt-not-owned-tmdb-fallback"); }
            }
            if (traktFailed) recordWarning(`${traktFailed} Trakt episode identity ${traktFailed === 1 ? "lookup" : "lookups"} failed; this show will be checked again next scan.`);
          }
          const crosswalks = await Promise.allSettled([...tmdbFallbackIds].map(async (tvdbEpisodeId) => ({ tvdbEpisodeId, matches: await findTmdbEpisodeByTvdbId(tvdbEpisodeId, config.tmdbToken) })));
          const unknownTmdbShowIds = [...new Set(crosswalks.flatMap((result) => result.status === "fulfilled" ? result.value.matches.flatMap((episode) => episode.show_id && !equivalentTmdbIds.has(episode.show_id) ? [episode.show_id] : []) : []))];
          for (const id of unknownTmdbShowIds) tmdbEpisodeAliases.add(id);
          const aliasChecks = await Promise.allSettled(unknownTmdbShowIds.map((showId) => tmdbJson<TmdbShow>(`/tv/${showId}?append_to_response=external_ids`, config.tmdbToken)));
          for (const alias of aliasChecks) if (alias.status === "fulfilled") {
            // The episode-level /find result is already an explicit provider link.
            // Fetching the show only enriches reporting; it does not validate or veto that link.
            if (!tmdbSeriesMatches.some((show) => show.id === alias.value.id)) tmdbSeriesMatches.push(alias.value);
            if (tvdbId && tmdbShowLinksToTvdb(alias.value, tvdbId)) equivalentTmdbIds.add(alias.value.id);
          }
          let rejectedOtherShow = 0;
          let unmatched = 0;
          for (const result of crosswalks) {
            if (result.status !== "fulfilled") continue;
            const sameShowMatches = result.value.matches.filter((episode) => episode.show_id && equivalentTmdbIds.has(episode.show_id));
            crosswalkDetails.set(result.value.tvdbEpisodeId, { ...crosswalkDetails.get(result.value.tvdbEpisodeId), tmdbFindIds: result.value.matches.flatMap((episode) => episode.id ? [episode.id] : []) });
            const ownedTmdbMatch = ownedTmdbEpisodeMatch(result.value.matches, libraryTmdbEpisodeIds);
            if (ownedTmdbMatch?.id) {
              locallySatisfiedTvdbIds.add(result.value.tvdbEpisodeId); tmdbSatisfied.add(result.value.tvdbEpisodeId); autoMatchEvidence.set(result.value.tvdbEpisodeId, { method: "Matched via TMDB External ID", tmdbEpisodeId: ownedTmdbMatch.id, tmdbEpisode: ownedTmdbMatch }); crosswalkDecisions.set(result.value.tvdbEpisodeId, "reconciled-by-tmdb-find");
              // No parent-series agreement or secondary lookup is required: Plex owns
              // the exact TMDB episode returned for this TVDB episode external ID.
            }
            else if (result.value.matches.length && !sameShowMatches.length) rejectedOtherShow += 1;
            else unmatched += 1;
            if (!crosswalkDecisions.has(result.value.tvdbEpisodeId)) crosswalkDecisions.set(result.value.tvdbEpisodeId, result.value.matches.length && !sameShowMatches.length ? "tmdb-cross-show-rejected" : "reported-missing");
          }
          const failedCrosswalks = crosswalks.filter((result) => result.status === "rejected").length;
          if (failedCrosswalks) recordWarning(`${failedCrosswalks} TMDB TVDB-ID ${failedCrosswalks === 1 ? "lookup" : "lookups"} failed; this show will be checked again next scan.`);
          logger.info("plex.show.episode-crosswalk", { ratingKey, strategy: traktCredentials ? "trakt-validate-with-tmdb-then-find" : "tmdb-find-by-tvdb-episode-id", equivalentTmdbShowIds: [...equivalentTmdbIds], tvdbCandidates: crosswalkCandidateTvdbIds.size, traktReconciled, traktValidatedNotOwned, traktValidationFailed, traktInvalid, traktFailed, ...(traktFailureReasons.size ? { traktFailureReasons: [...traktFailureReasons].slice(0, 3) } : {}), tmdbFallback: tmdbFallbackIds.size, reconciled: locallySatisfiedTvdbIds.size, rejectedOtherShow, unmatched, failed: failedCrosswalks });
          for (const tvdbEpisodeId of crosswalkCandidateTvdbIds) logger.info("plex.show.episode-crosswalk-decision", { ratingKey, tmdbShowId: tmdbShow.id, tvdbShowId: tvdbId, tvdbEpisodeId, ...crosswalkDetails.get(tvdbEpisodeId), outcome: crosswalkDecisions.get(tvdbEpisodeId) || "lookup-failed" });
          phaseTimings.crosswalkMs = Date.now() - crosswalkStarted;
        }
        const { missing, coverageOutcomes, autoMatches, compoundCoverage, manualCoverage, diagnostics } = comparePlexShow({
          ratingKey, primary, tmdbShow, tvdbId, tvdbSlug, tmdbSeriesMatches, providerEpisodes,
          localEpisodes, localProviderEpisodes, localTmdbEpisodeIds, libraryTmdbEpisodeIds,
          coordinateMissingTvdbIds, directTvdbSatisfied, directImdbSatisfied, traktSatisfied,
          tmdbSatisfied, autoMatchEvidence, mappings, manualInventory, autoCompoundEpisodes,
        });
        for (const { event, data } of diagnostics) logger.info(event, data);
        const linkedTvdbIds = [...new Set(tmdbSeriesMatches.flatMap((show) => show.external_ids?.tvdb_id ? [show.external_ids.tvdb_id] : []))];
        const missingTvdbSummaries = linkedTvdbIds.filter((id) => !tvdbSeriesMatches.some((show) => show.id === id));
        const linkedTvdbSummaries = await Promise.allSettled(missingTvdbSummaries.map((id) => tvdbShow(id, token)));
        tvdbSeriesMatches.push(...linkedTvdbSummaries.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []));
        const providerMatches: PlexProviderMatches = {
          tmdb: tmdbSeriesMatches.map((show) => ({ id: show.id, name: show.name, ...(show.first_air_date ? { year: Number(show.first_air_date.slice(0, 4)) } : {}) })),
          tvdb: tvdbSeriesMatches.map((show) => ({ id: show.id, name: show.name, slug: show.slug, ...(show.year && Number.isFinite(Number(show.year)) ? { year: Number(show.year) } : {}) })),
        };
        const result: PlexShowResult = { ratingKey, plexGuid: group.plexGuid, ...(plexGuids.length ? { plexGuids } : {}), plexRatingKeys: group.records.flatMap((record) => record.ratingKey ? [record.ratingKey] : []), title: primary.title || "Unknown show", year: primary.year, thumb: details.find((detail) => detail.thumb)?.thumb || primary.thumb, tmdbId, tvdbId, tvdbSlug, plexEpisodes: localEpisodes.size, providerResolution: { tmdb: Boolean(tmdbShow), tvdb: tvdbResolved }, providerMatches, coverageOutcomes, missing, ...(autoMatches.length ? { autoMatches } : {}), ...(compoundCoverage.length ? { compoundCoverage } : {}), ...(manualCoverage.length ? { manualCoverage } : {}), ...(warning ? { warning } : {}) };
  return {result,tmdbSeriesMatches,tvdbSeriesMatches,cachedTvdbEpisodeImdbIds};
}

async function runPlexScan(targetRatingKey?: string) {
  const startedAt = new Date().toISOString();
  let coverageRevision = coverageState().revision;
  let mappings = listCoverageMappings();
  if (mappings.length) beginCoverageRecheck(coverageRevision);
  const settings = parsePlexPreferences(readPlexSettings());
  const autoCompoundEpisodes = settings.autoCompoundEpisodes !== false;
  const logger = createScanLogger(settings.diagnosticsEnabled !== false, "shelfcheck-plex");
  const global = globalThis as ScanGlobal;
  global.__shelfcheckPlexLogger = logger;
  providerClient.resetMetrics();
  const activeWork = new ActiveScanTracker();
  const staleStatus = readPlexScanStatus() as PlexScanStatus | null;
  if (staleStatus?.status === "running") logger.warn("plex.scan.interrupted-detected", { previousStartedAt: staleStatus.startedAt, processed: staleStatus.processed, total: staleStatus.total, currentShow: staleStatus.currentShow, currentPhase: staleStatus.currentPhase, lastHeartbeatAt: staleStatus.heartbeatAt });
  logger.info("plex.scan.start", { startedAt, version: SHELFCHECK_VERSION, mode: targetRatingKey ? "single-show" : "full", targetRatingKey, autoCompoundEpisodes });
  replaceStatus({ status: "running", processed: 0, total: 0, startedAt, currentPhase: "initializing", heartbeatAt: startedAt });
  const heartbeatTimer = setInterval(() => {
    const activeShows = activeWork.snapshot();
    const heartbeatAt = new Date().toISOString();
    logger.info("plex.scan.heartbeat", { processed, total: currentTotal, activeShows, heartbeatAt });
    updateStatus({ status: "running", processed, total: currentTotal, activeShows, currentShow: activeShows.length === 1 ? activeShows[0].show : undefined, currentPhase: activeShows.length > 1 ? `processing-${activeShows.length}-shows` : activeShows[0]?.phase || "processing", heartbeatAt });
  }, 15_000);
  let processed = 0;
  let currentTotal = 0;
  const setHeartbeat = (key: string, show: string, phase: string) => activeWork.update(key, show, phase);
  const finishIgnoreTracking = trackScanIgnores("plex", Date.parse(startedAt));
  try {
    const config = await readPlexProviders();
    if (config && mappings.length) {
      await recheckCoverageHealth(providerClient, config);
      coverageRevision = coverageState().revision;
      mappings = listCoverageMappings();
    }
    if (!config) throw new Error("Configure Plex, TMDB, and TVDB credentials before scanning.");
    const sections = await plexJson("/library/sections", config.plexUrl, config.plexToken);
    const showSections = (sections.MediaContainer?.Directory || []).filter((section) => section.type === "show" && section.key);
    const libraries = await Promise.all(showSections.map((section) => plexJson(`/library/sections/${section.key}/all?type=2&includeGuids=1`, config.plexUrl, config.plexToken)));
    const physicalShows = libraries.flatMap((library) => library.MediaContainer?.Metadata || []);
    const allShows = groupPlexShows(physicalShows);
    const ignoredKeys = ignoredPlexKeys(settings.ignoredShows, Date.parse(startedAt));
    const shows = allShows.filter((show) => !ignoredKeys.has(show.identity));
    if (targetRatingKey && !shows.some((show) => show.identity === targetRatingKey)) throw new Error("That show is not available in the current Plex libraries.");
    const candidates = targetRatingKey ? shows.filter((show) => show.identity === targetRatingKey) : shows;
    logger.info("plex.library.refreshed", { libraries: showSections.length, plexRecords: physicalShows.length, shows: shows.length, ignored: allShows.length - shows.length, mergedRecords: physicalShows.length - allShows.length });
    let tvdbAuthenticationError: unknown;
    const token = await authenticateTvdb(providerClient, config.tvdbApiKey, config.tvdbPin).then(token=>{resolveCoverageIssue("provider-authentication:TVDB");return token;}).catch(error=>{
      tvdbAuthenticationError = error;
      setCoverageIssue({id:"provider-authentication:TVDB",operation:"provider-authentication",provider:"TVDB",scope:"library",...providerLookupContext(error,{source:[],requested:{provider:"TVDB",kind:"authentication"},impact:"TVDB catalogue downloads and freshness could not be verified. Available last-good data was retained."})});
      return "";
    });
    const traktCredentials = await validTraktCredentials().then(credentials=>{resolveCoverageIssue("provider-authentication:Trakt");return credentials;}).catch((error) => {
      const explanation = providerLookupContext(error,{source:[],requested:{provider:"Trakt",kind:"authentication"},impact:"Trakt episode identity checks could not be verified. TMDB fallback checks remain available."});
      setCoverageIssue({id:"provider-authentication:Trakt",operation:"provider-authentication",provider:"Trakt",scope:"library",...explanation});
      logger.warn("plex.crosswalk.trakt-unavailable", { error: explanation.cause });
      return null;
    });
    logger.info("plex.crosswalk.providers", { traktConfigured: Boolean(traktCredentials), tmdbFallback: true });
    const inputs = readPlexInputs();
    const utcDate = startedAt.slice(0, 10);
    // A scan belongs to its planned UTC start date, even when it finishes after midnight.
    const upcomingFullScan = {utcDate, count: (inputs.completedFullScans?.utcDate === utcDate ? inputs.completedFullScans.count : 0) + 1};
    // Scans 5, 10, ... require today's TMDB change list; an earlier unfinished one stays due today.
    const safeguardDue = !targetRatingKey && (upcomingFullScan.count % 5 === 0 || Boolean(inputs.pendingSafeguards[utcDate]));
    const prior = getPlexReport();
    const rawCheckpoint = readPlexCheckpoint() as PlexCheckpoint | null;
    const checkpoint = !targetRatingKey && (rawCheckpoint?.coverageRevision || 0) === coverageRevision && checkpointIsUsable(rawCheckpoint, autoCompoundEpisodes) ? rawCheckpoint : null;
    if (checkpoint) logger.info("plex.checkpoint.resume", { savedAt: checkpoint.savedAt, shows: checkpoint.shows.length, cacheEntries: Object.keys(checkpoint.scanCache).length });
    else if (rawCheckpoint && !targetRatingKey) { logger.warn("plex.checkpoint.discarded", { savedAt: rawCheckpoint.savedAt, cacheVersion: rawCheckpoint.cacheVersion, reason: "expired-or-incompatible" }); clearPlexCheckpoint(); }
    const cacheUsable = (prior?.coverageRevision || 0) === coverageRevision && plexReportCacheIsUsable(prior, CACHE_VERSION, autoCompoundEpisodes);
    let tmdbChanges: Set<number> | null = null;
    let tvdbChanges: Set<number> | null = null;
    // Each provider verifies from its own position; targeted scans never consult or advance them.
    const {tmdb: tmdbPosition, tvdb: tvdbPosition} = inputs.verification;
    // TMDB verification recovery: catalogues its change feed cannot cover are treated as changed.
    const tmdbPlan = targetRatingKey ? {recover: []} : tmdbVerificationPlan(tmdbPosition, Object.values(inputs.tmdb).flatMap(catalogue => usableProviderCatalogue(catalogue) ? [{id: catalogue.show.id, downloadedAt: catalogue.downloadedAt}] : []), startedAt);
    const tmdbRecovery = new Set(tmdbPlan.recover);
    if (!targetRatingKey) {
      tmdbChanges = await (tmdbPlan.feedFrom ? tmdbChangedShows(tmdbPlan.feedFrom, config.tmdbToken, startedAt) : Promise.resolve(new Set<number>())).then(changes => changes && new Set([...changes, ...tmdbRecovery])).catch((error) => {
        setProviderVerificationIssue("TMDB", error);
        logger.warn("plex.cache.tmdb-changes-unavailable", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
    }
    // Without TVDB history, verification starts at each saved catalogue's own successful download.
    const tvdbFeedFrom = tvdbVerificationFrom(tvdbPosition, Object.values(inputs.tvdb).flatMap(catalogue => usableProviderCatalogue(catalogue) ? [catalogue.downloadedAt] : []), startedAt);
    if (!targetRatingKey) {
      tvdbChanges = await (!tvdbFeedFrom ? Promise.resolve(new Set<number>()) : tvdbAuthenticationError ? Promise.reject(tvdbAuthenticationError) : tvdbChangedShows(tvdbFeedFrom, token)).catch((error) => {
        setProviderVerificationIssue("TVDB", error, tvdbAuthenticationError && error === tvdbAuthenticationError ? ["provider-authentication:TVDB"] : undefined);
        logger.warn("plex.cache.tvdb-updates-unavailable", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
    }
    // Recovery work is retained even when the feed fails, so it stays due until each refresh succeeds.
    retainVerifiedChanges(inputs, tmdbChanges ?? tmdbRecovery, tvdbChanges);
    if (tmdbChanges !== null) {
      resolveCoverageIssue("provider-verification:TMDB");
      fulfilOverdueSafeguards(inputs, utcDate);
    }
    if (tvdbChanges !== null) resolveCoverageIssue("provider-verification:TVDB");
    // A multi-day feed may contain older changes: only today's list overrides same-day reuse.
    const safeguardChanges = safeguardDue
      ? tmdbPosition?.slice(0, 10) === utcDate ? tmdbChanges
        : await tmdbChangedShows(startedAt, config.tmdbToken, startedAt).catch(error => {
          setProviderVerificationIssue("TMDB", error);
          return null;
        })
      : null;
    if (safeguardDue) retainSafeguard(inputs, utcDate, safeguardChanges, candidates);
    const tmdbCatalogueChanges = new Set([...(tmdbChanges || []), ...Object.keys(inputs.deferredTmdbChanges).map(Number)]);
    // Retained TVDB changes stay due even while the feed itself is unavailable.
    const tvdbCatalogueChanges = new Set([...(tvdbChanges || []), ...Object.keys(inputs.pendingTvdbChanges).map(Number)]);
    const tvdbVerifiedChanges = tvdbChanges === null ? null : tvdbCatalogueChanges;
    const results: PlexShowResult[] = [];
    const scanCache: Record<string, PlexCacheEntry> = {};
    if (targetRatingKey) {
      const carried = targetedScanCarryOver({ cacheUsable, shows: prior?.shows || [], cache: prior?.scanCache || {}, currentIdentities: new Set(shows.map((show) => show.identity)), targetRatingKey });
      results.push(...carried.shows);
      Object.assign(scanCache, carried.cache);
    }
    const queue: PlexShowGroup[] = [];
    const localResponsesByRatingKey = new Map<string, PlexContainer>();
    const inventoryFailureCauses: string[] = [];
    currentTotal = candidates.length;
    await runWorkerPool(allShows, PLEX_SCAN_WORKERS, async (group) => {
      const responses = await Promise.allSettled(group.records.map(async (record) => ({
        ratingKey: record.ratingKey,
        response: await plexJson(`/library/metadata/${record.ratingKey}/allLeaves?includeGuids=1`, config.plexUrl, config.plexToken),
      })));
      for (const [index,result] of responses.entries()) {
        const issueId = `inventory:${group.identity}:${group.records[index].ratingKey}`;
        if (result.status === "fulfilled") {
          const { ratingKey, response } = result.value;
          if (ratingKey) localResponsesByRatingKey.set(ratingKey, response);
          resolveCoverageIssue(issueId);
        } else {
          inventoryFailureCauses.push(issueId);
          setCoverageIssue({id:issueId,operation:"inventory",provider:"Plex",scope:"show",show:{ratingKey:group.identity,title:group.records[0]?.title},...providerLookupContext(result.reason,{source:[],requested:{provider:"Plex",kind:"show episode inventory"},impact:"This show’s library inventory and episode coverage could not be verified. Available last-good results were retained."})});
          logger.warn("plex.library.inventory-prefetch-failed", { ratingKey: group.identity, title: group.records[0]?.title, error: coverageIssueCause(result.reason) });
        }
      }
    });
    const manualInventory: CoverageEvidence[] = [];
    for (const group of allShows) for (const record of group.records) {
      for (const item of localResponsesByRatingKey.get(record.ratingKey || "")?.MediaContainer?.Metadata || []) {
        const ids = idsFromGuids(item.Guid);
        manualInventory.push({
          ratingKey: item.ratingKey || "", showKey: group.identity,
          identities: [
            ...(ids.tmdbId ? [{ provider: "TMDB" as const, id: ids.tmdbId }] : []),
            ...(ids.tvdbId ? [{ provider: "TVDB" as const, id: ids.tvdbId }] : []),
          ],
        });
      }
    }
    if (coverageState().revision === coverageRevision) saveCoverageEvidence(manualInventory);
    inputs.inventory = {capturedAt: startedAt, complete: allShows.every(group => group.records.every(record => localResponsesByRatingKey.has(record.ratingKey || ""))), groups: allShows, items: Object.fromEntries([...localResponsesByRatingKey].map(([key,value]) => [key,value.MediaContainer?.Metadata || []])), evidence: manualInventory};
    savePlexInventory(inputs.inventory);
    // Catalogue reuse does not certify ownership. Rebuild every comparison against this inventory.
    queue.push(...candidates);
    logger.info("plex.scan.plan", { total: candidates.length, reused: processed, refreshing: queue.length, tmdbChanged: tmdbChanges?.size, tvdbChanged: tvdbChanges?.size, cacheUsable, targetRatingKey });
    updateStatus({ status: "running", processed, total: candidates.length });
    const {libraryTmdbEpisodeIds, libraryTvdbEpisodeIds, libraryImdbEpisodeIds} = libraryInventoryIndex(allShows, inputs.inventory.items, ignoredKeys);
    logger.info("plex.library.episode-identities", { tmdb: libraryTmdbEpisodeIds.size, tvdb: libraryTvdbEpisodeIds.size, imdb: libraryImdbEpisodeIds.size });
    let lastCheckpointProcessed = processed;
    let lastCheckpointAt = Date.now();
    await runTrackedWorkerPool(queue, PLEX_SCAN_WORKERS, activeWork, (group) => ({ key: group.identity, show: group.records[0]?.title || "Unknown show" }), async (group) => {
      const primary = group.records[0];
      const ratingKey = group.identity;
      const retainComparison = (message: string) => {
        const previous = prior?.shows.find(show=>show.ratingKey===ratingKey);
        results.push(previous ? {...previous,warning:message} : {ratingKey,title:primary.title || "Unknown show",plexEpisodes:0,missing:[],warning:message});
        if (prior?.scanCache?.[ratingKey]) scanCache[ratingKey] = prior.scanCache[ratingKey];
        processed += 1;
        updateStatus({status:"running",processed,total:candidates.length});
      };
      const priorCacheEntry = checkpoint?.scanCache[ratingKey] || prior?.scanCache?.[ratingKey];
      let cachedTvdbEpisodeImdbIds = { ...(inputs.comparisons[ratingKey]?.tvdbEpisodeImdbIds || priorCacheEntry?.tvdbEpisodeImdbIds || {}) };
      const showStarted = Date.now();
      const phaseTimings: Record<string, number> = {};
      logger.info("plex.show.start", { ratingKey, title: primary.title || "Unknown show", plexRecords: group.records.length });
      setHeartbeat(ratingKey, primary.title || "Unknown show", "plex-inventory");
      let phaseStarted = Date.now();
      let details: PlexMetadata[];
      let localResponses: PlexContainer[];
      let metadataLoaded = false;
      try {
        details = await Promise.all(group.records.map(async (record) => (await plexJson(`/library/metadata/${record.ratingKey}?includeGuids=1`, config.plexUrl, config.plexToken)).MediaContainer?.Metadata?.[0] || record));
        metadataLoaded = true;
        resolveCoverageIssue(`inventory-details:${ratingKey}`);
        if (!inputs.inventory?.complete) throw new Error("The library inventory is incomplete; coverage cannot be verified against unavailable items.");
        localResponses = group.records.map(record=>localResponsesByRatingKey.get(record.ratingKey || "")!);
      } catch (error) {
        const message = `Plex inventory could not be loaded: ${error instanceof Error ? error.message : String(error)} This show will be checked again next scan.`;
        const causedBy = [...inventoryFailureCauses,...(!metadataLoaded ? [`inventory-details:${ratingKey}`] : [])];
        setCoverageIssue({id:`comparison-inputs:${ratingKey}`,operation:"comparison",provider:"Plex",scope:"show",show:{ratingKey,title:primary.title},...(causedBy.length ? {causedBy} : {}),cause:message,action:"Run a Plex scan with a complete accessible library inventory."});
        if (!metadataLoaded) setCoverageIssue({id:`inventory-details:${ratingKey}`,operation:"inventory",provider:"Plex",scope:"show",show:{ratingKey,title:primary.title},...providerLookupContext(error,{source:[],requested:{provider:"Plex",kind:"show metadata"},impact:"This show’s library inventory and episode coverage could not be verified. Available last-good results were retained."})});
        retainComparison(message);
        return;
      }
      let { tmdbId, tvdbId } = idsFromGuids(details.flatMap((detail) => detail.Guid || []));
      let tmdbSource: LookupSourceStep[] = tmdbId ? [{provider:"Plex",kind:"TMDB show",id:tmdbId}] : tvdbId ? [{provider:"Plex",kind:"TVDB series",id:tvdbId}] : [];
      let tvdbSource: LookupSourceStep[] = tvdbId ? [{provider:"Plex",kind:"TVDB series",id:tvdbId}] : [];
      const selectTmdbIdentity = (show:TmdbShow, cached:boolean) => {
        if (!tmdbId) tmdbSource = [...tmdbSource,{provider:"TMDB",kind:"resolved show",id:show.id,cached}];
        tmdbId = show.id;
        if (!tvdbId && show.external_ids?.tvdb_id) {
          tvdbId = show.external_ids.tvdb_id;
          tvdbSource = [...tmdbSource,{provider:"TMDB",kind:"external TVDB ID",id:tvdbId,cached}];
        }
      };
      const localMetadata = localResponses.flatMap((local) => local.MediaContainer?.Metadata || []);
      const {localEpisodes,localProviderEpisodes,localTmdbEpisodeIds}=localComparisonInventory(localMetadata);
      const localTvdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.tvdbEpisodeId ? [episode.tvdbEpisodeId] : []));
      const localImdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.imdbEpisodeId ? [episode.imdbEpisodeId] : []));
      phaseTimings.plexInventoryMs = Date.now() - phaseStarted;
      let warning: string | undefined;
      let cacheable = true;
      const addWarning = (message: string) => { warning = warning ? `${warning} ${message}` : message; cacheable = false; };
      const providerEpisodes: ProviderEpisode[] = [];
      let tmdbShow: TmdbShow | null = null;
      let tvdbResolved = false;
      let tvdbCatalogueReused = false;
      let tmdbSeriesMatches: TmdbShow[] = [];
      let tvdbSeriesMatches: TvdbShow[] = [];
      let tvdbSlug: string | undefined;
      const savedComparison = inputs.comparisons[ratingKey];
      const refresh = {...savedComparison?.refresh};
      inputs.comparisons[ratingKey] = savedComparison ? {...savedComparison,refresh} : {group, details, localMetadata, tmdbId, tvdbId, relationships:{}, tmdbAliases:[], tvdbAliases:[], complete:false, refresh};
      savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
      let tmdbCatalogueReused = false;
      const unavailableCatalogueCauses: string[] = [];
      const savedTmdb = inputs.tmdb[String(tmdbId || (tvdbId === savedComparison?.tvdbId ? savedComparison?.tmdbId : undefined))];
      try {
        setHeartbeat(ratingKey, primary.title || "Unknown show", "tmdb-show-and-seasons");
        phaseStarted = Date.now();
        const reuseTmdb = reuseProviderCatalogue({provider:"tmdb",now:startedAt,downloadedAt:savedTmdb?.downloadedAt,usable:usableProviderCatalogue(savedTmdb),mandatory:!!refresh.tmdb,targeted:!!targetRatingKey,changed:!!savedTmdb && tmdbCatalogueChanges.has(savedTmdb.show.id)});
        tmdbCatalogueReused = reuseTmdb;
        if (reuseTmdb && tmdbCatalogueChanges.has(savedTmdb.show.id)) {
          inputs.deferredTmdbChanges[String(savedTmdb.show.id)] = true;
          saveDeferredTmdbChanges(inputs.deferredTmdbChanges);
        }
        tmdbShow = reuseTmdb ? savedTmdb.show : await getTmdbShow(tmdbId, tvdbId, config.tmdbToken, id => {
          tmdbSource = [...tmdbSource,{provider:"TMDB",kind:"resolved show",id,cached:false}];
          tmdbId = id;
        });
        if (tmdbShow) {
          selectTmdbIdentity(tmdbShow,reuseTmdb);
          const episodes = reuseTmdb ? savedTmdb.episodes : await tmdbEpisodes(tmdbShow, config.tmdbToken);
          providerEpisodes.push(...episodes);
          if (!reuseTmdb) {
            inputs.tmdb[String(tmdbShow.id)] = {version:1, downloadedAt:new Date().toISOString(), show:tmdbShow, episodes};
            savePlexCatalogue("tmdb", tmdbShow.id, inputs.tmdb[String(tmdbShow.id)]);
            delete refresh.tmdb;
            delete inputs.deferredTmdbChanges[String(tmdbShow.id)];
            saveDeferredTmdbChanges(inputs.deferredTmdbChanges);
            savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
          }
        }
        resolveCoverageIssue(`catalogue-refresh:TMDB:${ratingKey}`);
        phaseTimings.tmdbMs = Date.now() - phaseStarted;
      } catch (error) {
        refresh.tmdb = true;
        setCoverageIssue({id:`catalogue-refresh:TMDB:${ratingKey}`,operation:"catalogue-refresh",provider:"TMDB",scope:"show",show:{ratingKey,title:primary.title,tmdbId,tvdbId},...providerLookupContext(error,{source:tmdbSource,requested:{provider:"TMDB",kind:tmdbId ? "show" : "TVDB ID search",id:tmdbId || tvdbId},impact:`TMDB episode coverage could not be fully verified. ${usableProviderCatalogue(savedTmdb) ? "Last-good catalogue data was retained." : "No previous catalogue data is available."} ${savedComparison?.complete ? "Last-good comparison results remain available." : "No previous comparison results are available."}`})});
        if (usableProviderCatalogue(savedTmdb)) {
          tmdbShow = savedTmdb.show;
          selectTmdbIdentity(tmdbShow,true);
          providerEpisodes.push(...savedTmdb.episodes);
        } else { tmdbShow = null; unavailableCatalogueCauses.push(`catalogue-refresh:TMDB:${ratingKey}`); }
        savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
        addWarning(error instanceof Error ? error.message : "TMDB lookup failed.");
      }
      try {
        if (tvdbId) {
          setHeartbeat(ratingKey, primary.title || "Unknown show", "tvdb-series-and-episodes");
          phaseStarted = Date.now();
          const savedTvdb = inputs.tvdb[String(tvdbId)];
          const reuseTvdb = reuseProviderCatalogue({provider:"tvdb",now:startedAt,downloadedAt:savedTvdb?.downloadedAt,usable:usableProviderCatalogue(savedTvdb),mandatory:!!refresh.tvdb,targeted:!!targetRatingKey,changed:tvdbCatalogueChanges.has(tvdbId)});
          tvdbCatalogueReused = reuseTvdb;
          if (!reuseTvdb && tvdbAuthenticationError) throw tvdbAuthenticationError;
          const tvdb = reuseTvdb ? {episodes:savedTvdb.episodes,slug:savedTvdb.show.slug,name:savedTvdb.show.name} : await tvdbSeries(tvdbId, token, undefined, primary.title || "Unknown show");
          if (!reuseTvdb) {
            inputs.tvdb[String(tvdbId)] = {version:1, downloadedAt:new Date().toISOString(), show:{id:tvdbId, name:tvdb.name, slug:tvdb.slug}, episodes:tvdb.episodes};
            delete refresh.tvdb;
            if (inputs.pendingTvdbChanges[String(tvdbId)]) {
              delete inputs.pendingTvdbChanges[String(tvdbId)];
              savePendingTvdbChanges(inputs.pendingTvdbChanges);
            }
            savePlexCatalogue("tvdb", tvdbId, inputs.tvdb[String(tvdbId)]);
            savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
          }
          tvdbResolved = true;
          tvdbSlug = tvdb.slug;
          providerEpisodes.push(...tvdb.episodes);
          phaseTimings.tvdbMs = Date.now() - phaseStarted;
        }
        resolveCoverageIssue(`catalogue-refresh:TVDB:${ratingKey}`);
        if (!tmdbId && !tvdbId) addWarning("No TMDB or TVDB ID was exposed by Plex.");
      } catch (error) {
        refresh.tvdb = true;
        setCoverageIssue({id:`catalogue-refresh:TVDB:${ratingKey}`,...(tvdbAuthenticationError && error === tvdbAuthenticationError ? {causedBy:["provider-authentication:TVDB"]} : {}),operation:"catalogue-refresh",provider:"TVDB",scope:"show",show:{ratingKey,title:primary.title,tmdbId,tvdbId},...providerLookupContext(error,{source:tvdbSource,requested:{provider:"TVDB",kind:"series",id:tvdbId},impact:`TVDB episode coverage could not be fully verified. ${usableProviderCatalogue(inputs.tvdb[String(tvdbId)]) ? "Last-good catalogue data was retained." : "No previous catalogue data is available."} ${savedComparison?.complete ? "Last-good comparison results remain available." : "No previous comparison results are available."}`})});
        const savedTvdb = inputs.tvdb[String(tvdbId)];
        if (usableProviderCatalogue(savedTvdb)) { tvdbResolved = true; tvdbSlug = savedTvdb.show.slug; providerEpisodes.push(...savedTvdb.episodes); }
        else unavailableCatalogueCauses.push(`catalogue-refresh:TVDB:${ratingKey}`);
        savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
        addWarning(error instanceof Error ? error.message : "Provider lookup failed.");
        logger.warn("plex.show.provider-error", { ratingKey, title: primary.title || "Unknown show", error: warning });
      }
      if ((tmdbId && !tmdbShow) || (tvdbId && !tvdbResolved) || (!tmdbId && !tvdbId)) {
        const cause = `Episode comparison could not be checked because complete provider catalogue inputs are unavailable. ${savedComparison?.complete ? "Last-good comparison results were retained." : "No previous comparison results are available."}`;
        setCoverageIssue({id:`comparison-inputs:${ratingKey}`,operation:"comparison",scope:"show",show:{ratingKey,title:primary.title,tmdbId,tvdbId},...(unavailableCatalogueCauses.length ? {causedBy:unavailableCatalogueCauses} : {}),cause,action:"Run a Plex scan to refresh the missing provider catalogue inputs; check any reported lookup failure first."});
        if (savedComparison) { inputs.comparisons[ratingKey] = {...savedComparison,refresh}; savePlexComparison(ratingKey,inputs.comparisons[ratingKey]); }
        retainComparison(warning || cause);
        return;
      }
      resolveCoverageIssue(`comparison-inputs:${ratingKey}`);
      const tmdbAliases = savedComparison?.tmdbAliases || [];
      const tvdbAliases = savedComparison?.tvdbAliases || [];
      const stale = savedComparison?.staleRelationships;
      // Retained changes count too: a deferred primary change is consumed by this scan's download.
      const reuseTmdbRelationships = !targetRatingKey && !stale?.tmdb && !tmdbAliases.some(id => tmdbCatalogueChanges.has(id) && !(id === tmdbShow?.id && tmdbCatalogueReused)) && tvdbId === savedComparison?.tvdbId;
      const reuseTvdbRelationships = !targetRatingKey && !stale?.tvdb && (tvdbVerifiedChanges === null || !tvdbAliases.some(id => tvdbVerifiedChanges.has(id)));
      const tmdbEpisodeAliases = new Set(savedComparison?.tmdbEpisodeAliases || []);
      const relationships = Object.fromEntries(Object.entries(savedComparison?.relationships || {}).filter(([,value]) => value.provider === "TMDB" ? reuseTmdbRelationships : value.provider === "TVDB" ? reuseTvdbRelationships : reuseTmdbRelationships && reuseTvdbRelationships));
      try {
      await comparisonIssueScope.run({ratingKey,title:primary.title,tmdbId,tvdbId,tmdbSource,tvdbSource,providerEpisodes,tmdbCached:tmdbCatalogueReused,tvdbCached:tvdbCatalogueReused,tvdbAuthenticationError}, () => relationshipScope.run(relationships, async () => {
        const compared = await compareLoadedPlexShow({group,details,localMetadata,tmdbId,tvdbId,tmdbShow,tvdbResolved,tvdbSlug,providerEpisodes,tmdbEpisodeAliases,cachedTvdbEpisodeImdbIds,libraryTmdbEpisodeIds,libraryTvdbEpisodeIds,libraryImdbEpisodeIds,mappings,manualInventory,autoCompoundEpisodes,config,token,traktCredentials,tvdbChanges:tvdbVerifiedChanges,logger,addWarning,setHeartbeat});
        ({tmdbSeriesMatches,tvdbSeriesMatches,cachedTvdbEpisodeImdbIds}=compared);
        results.push({...compared.result,...(warning ? {warning} : {})});
        inputs.comparisons[ratingKey] = !cacheable && savedComparison?.complete ? {...savedComparison,refresh} : {group,details,localMetadata,tmdbId,tvdbId,relationships,tmdbAliases:tmdbSeriesMatches.map(show=>show.id),tvdbAliases:tvdbSeriesMatches.map(show=>show.id),tmdbEpisodeAliases:[...tmdbEpisodeAliases],tvdbEpisodeImdbIds:cachedTvdbEpisodeImdbIds,complete:cacheable,refresh};
        savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
      }));
      resolveCoverageIssue(`comparison-failure:${ratingKey}`);
      } catch (error) {
        const cause = coverageIssueCause(error);
        setCoverageIssue({id:`comparison-failure:${ratingKey}`,operation:"comparison",scope:"show",show:{ratingKey,title:primary.title,tmdbId,tvdbId},cause,action:"Retry this comparison; run a Plex scan if saved inputs are incomplete."});
        if (savedComparison) {inputs.comparisons[ratingKey] = {...savedComparison,refresh};savePlexComparison(ratingKey,inputs.comparisons[ratingKey]);}
        retainComparison(cause);
        return;
      }
      const fingerprint = plexFingerprint(group);
      const episodeFingerprint = plexEpisodeFingerprint(localMetadata);
      cachedTvdbEpisodeImdbIds = pruneEpisodeIdentityCache(cachedTvdbEpisodeImdbIds, providerEpisodes.filter((episode) => episode.source === "TVDB").flatMap((episode) => episode.providerEpisodeId ? [episode.providerEpisodeId] : []));
      if (cacheable) scanCache[ratingKey] = { ...(fingerprint ? { plexFingerprint: fingerprint } : {}), ...(episodeFingerprint ? { plexEpisodeFingerprint: episodeFingerprint } : {}), ...(tmdbId ? { tmdbId } : {}), ...(tvdbId ? { tvdbId } : {}), ...(Object.keys(cachedTvdbEpisodeImdbIds).length ? { tvdbEpisodeImdbIds: cachedTvdbEpisodeImdbIds } : {}), localTmdbEpisodeIds: [...localTmdbEpisodeIds], localTvdbEpisodeIds: [...localTvdbEpisodeIds], localImdbEpisodeIds: [...localImdbEpisodeIds], lastCheckedAt: new Date().toISOString() };
      logger.info("plex.show.complete", { ratingKey, title: primary.title || "Unknown show", plexRecords: group.records.length, tmdbId, tvdbId, plexEpisodes: localEpisodes.size, missing: results.find(show => show.ratingKey === ratingKey)?.missing.length, phaseWallMs: phaseTimings, elapsedMs: Date.now() - showStarted });
      processed += 1;
      updateStatus({ status: "running", processed, total: candidates.length });
      if (!targetRatingKey && shouldSaveCheckpoint(processed, lastCheckpointProcessed, Date.now(), lastCheckpointAt)) {
        const savedAt = new Date().toISOString();
        if (coverageState().revision === coverageRevision) writePlexCheckpoint({ shows: checkpointShowsWithCache(results, scanCache), scanCache, cacheVersion: CACHE_VERSION, savedAt, autoCompoundEpisodes, coverageRevision });
        logger.info("plex.checkpoint.saved", { savedAt, processed, total: candidates.length, shows: results.length, cacheEntries: Object.keys(scanCache).length });
        lastCheckpointProcessed = processed;
        lastCheckpointAt = Date.now();
      }
    });
    const finishedAt = new Date().toISOString();
    const coverageGroups=coverageGroupsForResults(results,manualInventory);
    const report: PlexReport = { coverageGroups, shows: results.sort((a, b) => a.title.localeCompare(b.title)), lastScan: targetRatingKey ? prior?.lastScan || finishedAt : finishedAt, startedAt: targetRatingKey ? prior?.startedAt || startedAt : startedAt, finishedAt: targetRatingKey ? prior?.finishedAt || finishedAt : finishedAt, scanCache, cacheVersion: CACHE_VERSION, autoCompoundEpisodes, coverageRevision };
    if (coverageState().revision !== coverageRevision) return;
    writePlexReport(report);
    const inventoryComplete = !mappings.length || allShows.every(group => group.records.every(record => localResponsesByRatingKey.has(record.ratingKey || "")));
    if (inventoryComplete) resolveCoverageIssue("comparison-inputs:initial");
    if (!targetRatingKey) {
      // Verified changes and recovery work were retained before processing, so isolated failures cannot hold a position back.
      saveProviderVerification({
        ...inputs.verification,
        ...(tmdbChanges !== null ? {tmdb: startedAt} : {}),
        ...(tvdbChanges !== null ? {tvdb: startedAt} : {}),
      });
      // Isolated download, comparison, and verification issues do not prevent a Completed full scan from counting.
      if (inputs.inventory?.complete) saveCompletedFullScan(startedAt, upcomingFullScan);
    }
    completeCoverageRecheck(coverageRevision);
    if (!targetRatingKey) clearPlexCheckpoint();
    else if (rawCheckpoint) {
      const nextCheckpoint = checkpointWithoutRatingKey(rawCheckpoint, targetRatingKey);
      if (nextCheckpoint) writePlexCheckpoint(nextCheckpoint); else clearPlexCheckpoint();
    }
    resolveCoverageIssue("scan-failure");
    replaceStatus({ status: "completed", processed, total: candidates.length, startedAt, finishedAt });
    logger.info("plex.scan.complete", { finishedAt, shows: candidates.length, reused: candidates.length - queue.length, refreshed: queue.length, missing: results.reduce((sum, show) => sum + show.missing.length, 0), targetRatingKey, providerMetrics: providerClient.metrics(), elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt) });
  } catch (error) {
    setCoverageIssue({id:"scan-failure",operation:"inventory",provider:"Plex",scope:"library",...providerLookupContext(error,{source:[],requested:{provider:"Plex",kind:"library inventory"},impact:"Library inventory and episode coverage could not be verified. Available last-good results were retained."})});
    updateStatus({ status: "error", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "The Plex scan failed.", rateLimitPaused: false, rateLimitProvider: undefined });
    logger.error("plex.scan.error", { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, providerMetrics: providerClient.metrics() });
  } finally {
    finishIgnoreTracking();
    clearInterval(heartbeatTimer);
    global.__shelfcheckPlexLogger = undefined;
  }
}

export function getPlexScanStatus(): PlexScanStatus {
  const status = readPlexScanStatus() as PlexScanStatus | null;
  if (status?.status === "running" && !(globalThis as ScanGlobal).__shelfcheckPlexScan) {
    const lastActivity = Date.parse(status.heartbeatAt || status.startedAt || "");
    if (Number.isFinite(lastActivity) && Date.now() - lastActivity > 90_000) {
      const interrupted: PlexScanStatus = { ...status, status: "error", finishedAt: new Date().toISOString(), error: `The previous Plex scan was interrupted during ${status.currentPhase || "processing"}${status.currentShow ? ` (${status.currentShow})` : ""}. Start a new scan to resume from its checkpoint.` };
      setCoverageIssue({id:"scan-failure",operation:"scan",scope:"library",cause:interrupted.error!,action:"Start a new Plex scan to resume verification."});
      writePlexScanStatus(interrupted);
      return interrupted;
    }
  }
  return status || { status: "idle", processed: 0, total: 0 };
}

export function getPlexReport(): PlexReport | null {
  const report = readPlexReport() as PlexReport | null;
  return report;
}

export function clearPlexScanCache(ratingKey?: string): { cleared: number } {
  if ((globalThis as ScanGlobal).__shelfcheckPlexScan) throw new Error("Wait for the current Plex scan to finish before clearing the cache.");
  const report = readPlexReport() as PlexReport | null;
  clearPlexInputs(ratingKey);
  if (ratingKey) {
    const hadReportCache = Boolean(report?.scanCache?.[ratingKey]);
    if (report?.scanCache) {
      const remainingCache = { ...report.scanCache };
      delete remainingCache[ratingKey];
      writePlexReport({ ...report, scanCache: remainingCache });
    }
    const checkpoint = readPlexCheckpoint() as PlexCheckpoint | null;
    const hadCheckpointCache = Boolean(checkpoint?.scanCache?.[ratingKey]);
    if (checkpoint?.scanCache) {
      const remainingCache = { ...checkpoint.scanCache };
      delete remainingCache[ratingKey];
      writePlexCheckpoint({ ...checkpoint, scanCache: remainingCache, shows: checkpoint.shows.filter((show) => show.ratingKey !== ratingKey) });
    }
    return { cleared: hadReportCache || hadCheckpointCache ? 1 : 0 };
  }
  const cleared = Object.keys(report?.scanCache || {}).length;
  clearPlexReport();
  return { cleared };
}

export function startPlexScan(targetRatingKey?: string): PlexScanStatus {
  const global = globalThis as ScanGlobal;
  if (global.__shelfcheckPlexScan) return getPlexScanStatus();
  if (targetRatingKey) {
    const settings = parsePlexPreferences(readPlexSettings());
    if (!plexReportCacheIsUsable(getPlexReport(), CACHE_VERSION, settings.autoCompoundEpisodes !== false)) {
      throw new Error("Run a full Plex search before force-checking one show because the scan settings or cache format changed.");
    }
  }
  global.__shelfcheckPlexScan = runPlexScan(targetRatingKey).finally(() => { global.__shelfcheckPlexScan = undefined; });
  return { status: "running", processed: 0, total: 0, startedAt: new Date().toISOString() };
}

export type CoverageImpact = {members: CoverageMember[]};
export function captureCoverageImpact(ids: string[]): CoverageImpact {
  return {members:listCoverageMappings().filter(mapping=>ids.includes(mapping.id)).flatMap(mapping=>mapping.members)};
}
function coverageGroupsForResults(results: PlexShowResult[], manualInventory: CoverageEvidence[]): CoverageGroup[] {
  return listCoverageMappings().flatMap(mapping=>{
    const outcomes=results.flatMap(show=>(show.coverageOutcomes || []).filter(outcome=>mapping.members.some(member=>member.provider===outcome.provider && member.id===outcome.id)).map(outcome=>({...outcome,showKey:show.ratingKey})));
    const missing=outcomes.filter(outcome=>outcome.status==="missing");
    if (!missing.length) return [];
    return [{mappingId:mapping.id,health:mapping.health,missing,members:mapping.members.map(member=>{
      const direct=manualInventory.some(item=>item.identities.some(identity=>identity.provider===member.provider && identity.id===member.id));
      const matched=outcomes.filter(outcome=>outcome.provider===member.provider && outcome.id===member.id);
      // Explicit and derived missing status outrank direct ownership and every collected outcome.
      const missingParts=missingPartsOf(mapping.members,member);
      const status=member.reportMissing ? "reported-missing" : missingParts.length ? "incomplete" : direct ? "direct" : matched.some(o=>o.status==="missing") ? "missing" : matched.some(o=>o.status==="automatic") ? "automatic" : matched.some(o=>o.status==="manual") ? "manual" : "alternative";
      return {...member,status,...(status==="incomplete" ? {missingParts} : {})};
    })}];
  });
}
/** Whether a Manual Match member belongs to a saved show comparison, by provider show or catalogue episode. */
function memberInComparison(inputs: PlexGeneratedInputs, input: SavedPlexComparison, member: CoverageMember) {
  return member.provider==="TMDB"
    ? input.tmdbId===member.showId || input.tmdbAliases.includes(member.showId) || Boolean(input.tmdbEpisodeAliases?.includes(member.showId)) || Boolean(inputs.tmdb[String(input.tmdbId)]?.episodes.some(episode=>episode.providerEpisodeId===member.id))
    : input.tvdbId===member.showId || input.tvdbAliases.includes(member.showId) || Boolean(inputs.tvdb[String(input.tvdbId)]?.episodes.some(episode=>episode.providerEpisodeId===member.id));
}

/** A newly applied Plex Ignore: a whole show, or only the selected seasons of it. */
export type IgnoreScope = {ratingKey: string; seasons?: number[]};

/**
 * Manual Match members inside an Ignore scope. A member belongs to the ignored
 * show when that show's saved comparison lists its provider show or episode, or
 * when one of the show's Plex items carries its identity. A season Ignore also
 * requires the member's provider season (from the saved catalogue, else the
 * saved member) to be one of the selected seasons.
 */
function membersInIgnoreScopes(scopes: IgnoreScope[]): CoverageMember[] {
  if (!scopes.length) return [];
  const inputs=readPlexInputs();
  // Provider season of every catalogued episode, built once per cleanup.
  const seasons=new Map<string,number>();
  for (const [provider,catalogues] of [["TMDB",inputs.tmdb],["TVDB",inputs.tvdb]] as const)
    for (const catalogue of Object.values(catalogues)) for (const episode of catalogue.episodes)
      if (episode.providerEpisodeId) seasons.set(`${provider}:${episode.providerEpisodeId}`,episode.season);
  // The member's own provider show only, not aliases or Plex GUIDs, so a
  // mis-tagged item or shared alias never reaches another show's flags.
  const ownShow=(input: SavedPlexComparison, member: CoverageMember) => member.provider==="TMDB"
    ? input.tmdbId===member.showId || Boolean(input.tmdbId && inputs.tmdb[String(input.tmdbId)]?.episodes.some(episode=>episode.providerEpisodeId===member.id))
    : input.tvdbId===member.showId || Boolean(input.tvdbId && inputs.tvdb[String(input.tvdbId)]?.episodes.some(episode=>episode.providerEpisodeId===member.id));
  return listCoverageMappings().flatMap(mapping=>mapping.members).filter(member=>scopes.some(scope=>{
    const input=inputs.comparisons[scope.ratingKey];
    // Without a saved comparison, fall back to the show's own Plex items.
    const inShow=input ? ownShow(input,member)
      : Boolean(inputs.inventory?.evidence.some(item=>item.showKey===scope.ratingKey && item.identities.some(identity=>identity.provider===member.provider && identity.id===member.id)));
    return inShow && (!scope.seasons || scope.seasons.includes(seasons.get(`${member.provider}:${member.id}`) ?? member.season));
  }));
}

/**
 * Apply Ignore authoritatively over Report Missing. Deletes explicit flags of
 * Manual Match members inside the newly ignored scopes, saves the Ignore rule
 * (`save`) in the same transaction, then rechecks the affected cached shows so
 * derived effects elsewhere are withdrawn immediately. Flags outside the scopes
 * and every other mapping are preserved. Restore or expiry never recreates them.
 * Rejects while a Plex scan is running only when there are flags to delete.
 */
export async function applyIgnoreReportMissingCleanup(scopes: IgnoreScope[], save: () => void): Promise<number | undefined> {
  const impact=clearReportMissingFlags(membersInIgnoreScopes(scopes),save);
  if (!impact.length) return undefined;
  await requestCoverageRecheck({members:impact});
  // The coverage revision whose rechecked report the client must display.
  return coverageState().revision;
}

let coverageRecheckQueue: Promise<void> = Promise.resolve();
/** Reconcile only affected comparisons. No client credentials, enumeration or HTTP is permitted here. */
export function requestCoverageRecheck(impact: CoverageImpact): Promise<void> {
  // Every mutation must finish its comparison against the preceding published report.
  // Keep later work runnable even when an earlier recheck fails.
  const recheck = coverageRecheckQueue.then(() => recheckCoverage(impact));
  coverageRecheckQueue = recheck.catch(() => {});
  return recheck;
}
async function recheckCoverage(impact: CoverageImpact) {
  const inputs=readPlexInputs(), prior=getPlexReport(), revision=coverageState().revision;
  const settings=parsePlexPreferences(readPlexSettings());
  const ignored=ignoredPlexKeys(settings.ignoredShows,Date.now());
  const targets=new Set<string>();
  for (const [key,input] of Object.entries(inputs.comparisons)) {
    if (impact.members.some(member=>memberInComparison(inputs,input,member))) targets.add(key);
  }
  // Persist obligations first. A failed local comparison must never consume them.
  for (const key of targets) {
    const input=inputs.comparisons[key];
    if (input) {input.refresh={...input.refresh,...(input.tmdbId ? {tmdb:true} : {}),...(input.tvdbId ? {tvdb:true} : {})};savePlexComparison(key,input);}
  }
  if (!prior || !inputs.inventory?.complete) {
    const keys=targets.size ? [...targets] : [undefined];
    for (const key of keys) setCoverageIssue({id:key ? `comparison-inputs:${key}` : "comparison-inputs:initial",operation:"comparison",scope:key ? "show" : "library",...(key ? {show:{ratingKey:key}} : {}),cause:!prior ? "Saved Plex report is missing; no prior comparison is available." : "Saved Plex library inventory is missing or incomplete.",action:"Run an explicit full Plex scan to capture complete library and provider inputs."});
    if (prior) writePlexReport({...prior,coverageGroups:coverageGroupsForResults(prior.shows,inputs.inventory?.evidence || []),coverageRevision:revision});
    completeCoverageRecheck(revision);
    return;
  }
  const inventory=inputs.inventory;
  const {libraryTmdbEpisodeIds, libraryTvdbEpisodeIds, libraryImdbEpisodeIds} = libraryInventoryIndex(inventory.groups, inventory.items, ignored);
  const results=[...prior.shows];
  const mappings=listCoverageMappings();
  for (const key of targets) {
    if (ignored.has(key)) continue;
    const input=inputs.comparisons[key];
    try {
      if (!input?.complete) throw new Error("Saved show comparison inputs are missing or incomplete. Run a Plex scan to rebuild this show’s saved comparison.");
      const tmdb=inputs.tmdb[String(input.tmdbId)],tvdb=inputs.tvdb[String(input.tvdbId)];
      if (input.tmdbId && !usableProviderCatalogue(tmdb)) throw new Error("Saved TMDB catalogue is missing or incomplete. Run a Plex scan to download the TMDB catalogue.");
      if (input.tvdbId && !usableProviderCatalogue(tvdb)) throw new Error("Saved TVDB catalogue is missing or incomplete. Run a Plex scan to download the TVDB catalogue.");
      const replay={missing:new Set<string>()};
      const compared=await replayScope.run(replay,()=>comparisonIssueScope.run({ratingKey:key,title:input.group.records[0]?.title,tmdbId:input.tmdbId,tvdbId:input.tvdbId},()=>relationshipScope.run(input.relationships,()=>compareLoadedPlexShow({
        ...input,tmdbShow:tmdb?.show || null,tvdbResolved:Boolean(tvdb),tvdbSlug:tvdb?.show.slug,
        providerEpisodes:[...(tmdb?.episodes || []),...(tvdb?.episodes || [])],tmdbEpisodeAliases:new Set(input.tmdbEpisodeAliases || []),cachedTvdbEpisodeImdbIds:{...input.tvdbEpisodeImdbIds},
        libraryTmdbEpisodeIds,libraryTvdbEpisodeIds,libraryImdbEpisodeIds,mappings,manualInventory:inventory.evidence,autoCompoundEpisodes:settings.autoCompoundEpisodes!==false,
        config:{tmdbToken:""},token:"",traktCredentials:Object.values(input.relationships).some(relationship=>relationship.provider==="Trakt") ? {clientId:"",accessToken:""} : null,
        tvdbChanges:new Set(),logger:{info:()=>{},warn:()=>{}},addWarning:()=>{},setHeartbeat:()=>{},
      }))));
      if (replay.missing.size) throw new Error(`Saved provider identity relationships are incomplete (${[...replay.missing].join(", ")}).`);
      const index=results.findIndex(show=>show.ratingKey===key);
      if (index>=0) results[index]=compared.result; else results.push(compared.result);
      resolveCoverageIssue(`comparison-inputs:${key}`);
      resolveCoverageIssue(`comparison-failure:${key}`);
    } catch (error) {
      // A cached recheck cannot reevaluate a failed download. Preserve the
      // dependency established by that scan until its inputs can be evaluated.
      const previous = getCoverageIssue(`comparison-inputs:${key}`);
      if (!input?.complete && previous?.causedBy?.length && previous.causedBy.every(id=>getCoverageIssue(id))) continue;
      setCoverageIssue({id:`comparison-inputs:${key}`,operation:"comparison",scope:"show",show:{ratingKey:key,title:input?.group.records[0]?.title,tmdbId:input?.tmdbId,tvdbId:input?.tvdbId},cause:coverageIssueCause(error),action:"Run an explicit Plex scan to rebuild saved comparison inputs."});
    }
  }
  resolveCoverageIssue("comparison-inputs:initial");
  writePlexReport({...prior,shows:results,coverageGroups:coverageGroupsForResults(results,inventory.evidence),coverageRevision:revision});
  completeCoverageRecheck(revision);
}
