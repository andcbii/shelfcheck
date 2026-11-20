import { tmdbFeedCovers, tmdbVerificationPlan, tvdbVerificationFrom } from "@/lib/plex-catalogue-policy";
import { setCoverageIssue, resolveCoverageIssue, getCoverageIssue, coverageIssueCause, providerLookupContext, type LookupSourceStep } from "@/lib/coverage-issues";
import { AsyncLocalStorage } from "node:async_hooks";
import { isPlexScanActive } from "@/lib/plex-scan-active";
import { scanRuns, type ScanRunMode, type ScanRunOwner } from "@/lib/scan-run";
import { usableProviderCatalogue, readPlexInputs, savePlexComparison, savePlexInventory, saveDeferredTmdbChanges, savePendingTvdbChanges, savePendingSafeguards, saveProviderVerification, saveCompletedFullScan, clearPlexInputs, readSharedTmdbCrosswalk, saveSharedTmdbCrosswalk, invalidateSharedTmdbCrosswalk, tmdbFindRelationshipKey, type PlexGeneratedInputs, type SavedPlexComparison } from "@/lib/plex-catalogues";
import { authenticateTvdb } from "@/lib/tvdb-auth";
import { recheckCoverageHealth } from "@/lib/manual-coverage-health";
import { coverageState, beginCoverageRecheck, clearReportMissingFlags, completeCoverageRecheck, listCoverageMappings, saveCoverageEvidence } from "@/lib/manual-coverage";
import { missingPartsOf, type CoverageMember, type CoverageEvidence, type CoverageIdentity, type CoverageOutcome, type CoverageGroup } from "@/lib/manual-coverage-model";
import "server-only";

import { readPlexProviders } from "@/lib/server-config";
import { createScanLogger, type ScanLogger } from "@/lib/scan-log";
import { savedScanState, trackScanIgnores } from "@/lib/sqlite";
import { TraktRunCredentials } from "@/lib/trakt-auth";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { episodeReference, type CompoundCoverage, type LocalCompoundEpisode } from "@/lib/compound-episodes";
import { comparePlexShow, type EpisodeCheckFailure, type EpisodeCrosswalk, type ProviderEpisode } from "@/lib/plex-comparison";
import { compoundMatchingCausesRecorded, reconcileEpisodeCheckIssues, recordedEpisodeCrosswalkFailures } from "@/lib/episode-check-issues";
import { withTitleRecovery, type TitleRecoveryState } from "@/lib/tvdb-title-recovery";
import { normaliseTmdbRecords, normaliseTvdbRecords, type MalformedCatalogueRecord, type NormalisedCatalogue } from "@/lib/catalogue-records";
import { ignoredPlexKeys } from "@/lib/ignored-shows";
import { parsePlexPreferences } from "@/lib/preferences";
import { PLEX_SCAN_WORKERS, type ProviderName } from "@/lib/provider-policy";
import { runTrackedWorkerPool, runWorkerPool, type ActiveScanWork } from "@/lib/scan-concurrency";
import { groupPlexShows, hasPlexEpisodeCoordinate, idsFromGuids, plexEpisodeFingerprint, plexFingerprint, showProviderIds, type PlexMetadata, type PlexShowGroup } from "@/lib/plex-inventory";
import { clearCatalogueUse, observeCatalogueCandidates, readShowCatalogueSelection, recordCatalogueCandidateNames, recordCatalogueUse, type CatalogueUse, type ShowCatalogueSelection } from "@/lib/catalogue-selection-store";
import { PROVIDER_ID_FIELD, PROVIDER_NAME, PROVIDERS, type CatalogueProvider } from "@/lib/catalogue-selection";
import { ProgressPersistenceError, resolveComparisonCatalogues, type ComparisonCatalogueSource, type PriorSelection, type ProviderRequest } from "@/lib/comparison-catalogue-resolver";
import { downloadCatalogueSource, type DownloadCataloguePayloads } from "@/lib/download-catalogue-source";
import { patchSavedObligation, PREFERRED_REQUIRED, savedObligation } from "@/lib/refresh-obligation";
import { savedCatalogueSource } from "@/lib/saved-catalogue-source";
import { isProviderLoginFailure, ProviderResponseError, type ProviderAuth } from "@/lib/provider-client";
import { scanProviderClient } from "@/lib/scan-provider-client";
import { checkpointIsUsable, checkpointShowsWithCache, checkpointWithoutRatingKey, plexReportCacheIsUsable, PLEX_CACHE_VERSION, pruneEpisodeIdentityCache, targetedScanCarryOver, type PlexScanCacheEntry } from "@/lib/plex-scan-cache";
import { isRecord } from "@/lib/value-guards";
import type { CoverageProvider } from "@/lib/manual-coverage-model";
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

const TMDB = "https://api.themoviedb.org/3";
const TVDB = "https://api4.thetvdb.com/v4";
const TRAKT = "https://api.trakt.tv";
const CACHE_VERSION = PLEX_CACHE_VERSION;

/**
 * The Plex saved scan state. Its options are the Plex Settings and Ignore
 * Preferences together, stored unparsed; readPlexPreferences reads them parsed.
 */
export const plexSavedState = savedScanState<PlexReport, PlexCheckpoint, PlexScanStatus, Record<string, unknown>>("plex");

/** The saved Plex Settings and Ignore Preferences, parsed. */
export function readPlexPreferences() {
  return parsePlexPreferences(plexSavedState.options.read());
}

/**
 * The Plex scan mode's adapter to the scan run lifecycle: its status and
 * Resume point stores, log event prefix and Interrupted scan wording. The
 * scan-failure Coverage Issue is raised once when an Interrupted scan is recorded.
 */
const plexScanMode: ScanRunMode<PlexScanStatus, PlexCheckpoint> = {
  kind: "plex",
  eventPrefix: "plex",
  failureMessage: "The Plex scan failed.",
  vetoedError: "Manual Matches changed while this scan was running. Start a new Plex scan to include them.",
  status: plexSavedState.status,
  interruptedError: (status) => `The previous Plex scan was interrupted during ${status.currentPhase || "processing"}${status.currentShow ? ` (${status.currentShow})` : ""}. Start a new scan to resume from its checkpoint.`,
  onInterrupted: (status) => setCoverageIssue({id:"scan-failure",operation:"scan",scope:"library",cause:status.error!,action:"Start a new Plex scan to resume verification."}),
  resumePoint: {
    ...plexSavedState.resumePoint,
    resumeDetails: (checkpoint) => ({ savedAt: checkpoint.savedAt, shows: checkpoint.shows.length, cacheEntries: Object.keys(checkpoint.scanCache).length }),
    discardDetails: (checkpoint) => ({ savedAt: checkpoint.savedAt, cacheVersion: checkpoint.cacheVersion, reason: "expired-or-incompatible" }),
  },
};


/** The saved relationship key of one provider request: its provider and URL. */
function relationshipKey(provider: ProviderName, url: string) { return `${provider}:${url}`; }
function relationshipProvider(key: string) { return key.slice(0, key.indexOf(":")); }
/** The Provider Lookup cause of a rejected relationship request for one show. */
function episodeIdentityIssueId(ratingKey: string | undefined, relationship: string) { return `episode-identity:${ratingKey}:${relationship}`; }

const comparisonIssueScope = new AsyncLocalStorage<{ratingKey:string;title?:string;tmdbId?:number;tvdbId?:number;tmdbSource?:LookupSourceStep[];tvdbSource?:LookupSourceStep[];providerEpisodes?:ProviderEpisode[];tmdbCached?:boolean;tvdbCached?:boolean;tvdbAuthenticationError?:unknown}>();
const lookupSourceScope = new AsyncLocalStorage<LookupSourceStep[]>();
/**
 * An offline recheck: the saved relationships it found missing, and the TMDB crosswalk answers it
 * recovered from shared crosswalk evidence after this show's own failed lookup, by relationship
 * key, with the failed-request issue each one resolves once the recovered answer is saved.
 */
const replayScope = new AsyncLocalStorage<{missing:Set<string>; recovered:Map<string,string>}>();
/** Set while one TVDB episode's crosswalk lookup runs: its saved relationships are episode-scoped. */
const crosswalkLookupScope = new AsyncLocalStorage<true>();
/**
 * An offline replay found no saved response for one episode's crosswalk. No request was
 * attempted; the failure stays with that episode instead of discarding the show comparison.
 */
class SavedRelationshipUnavailableError extends Error {
  constructor(readonly relationship: string) { super(`The saved ${relationshipProvider(relationship)} response for this episode is not available to the offline recheck; no request was made.`); }
}
const relationshipScope = new AsyncLocalStorage<SavedPlexComparison["relationships"]>();
function relationshipIsReusable(key:string) {
  const relationships = relationshipScope.getStore();
  const show = comparisonIssueScope.getStore();
  return Boolean(relationships && Object.hasOwn(relationships,key) && (replayScope.getStore() || !getCoverageIssue(episodeIdentityIssueId(show?.ratingKey, key))));
}
/** Thrown for a Trakt lookup skipped because the run's Trakt login cannot be recovered; it is not a failure of that lookup. */
class TraktLoginUnavailableError extends Error {
  constructor(readonly reason: unknown) { super("Trakt lookups are unavailable for this scan: the Trakt login could not be recovered."); }
}

/** One library-scoped Coverage Issue for the Trakt login, with the actual cause and status. */
function raiseTraktLoginIssue(error: unknown) {
  setCoverageIssue({id:"provider-authentication:Trakt",operation:"provider-authentication",provider:"Trakt",scope:"library",...providerLookupContext(error,{source:[],requested:{provider:"Trakt",kind:"authentication"},impact:"Trakt episode identity checks could not be verified. TMDB fallback checks remain available."})});
}

async function checkedJson<T>(url: string, init: RequestInit, provider: ProviderName, episodeIdentity?: {provider:"TMDB"|"TVDB";id:number}, auth?: ProviderAuth): Promise<T> {
  const relationships = relationshipScope.getStore();
  const key = relationshipKey(provider, url);
  const show = comparisonIssueScope.getStore();
  const issueId = episodeIdentityIssueId(show?.ratingKey, key);
  if (relationships && relationshipIsReusable(key)) return relationships[key].value as T;
  const replay=replayScope.getStore();
  if (replay && crosswalkLookupScope.getStore()) throw new SavedRelationshipUnavailableError(key);
  if (replay) { replay.missing.add(key); throw new Error(`Saved provider identity relationship is missing: ${key}`); }
  const endpoint = new URL(url);
  const tvdbEpisodeId = endpoint.pathname.match(/\/(?:episodes|search\/tvdb)\/(\d+)/)?.[1];
  const findId = endpoint.pathname.match(/\/find\/(\d+)/)?.[1];
  const coordinate = endpoint.pathname.match(/\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)/);
  const matching = Boolean(tvdbEpisodeId || findId || coordinate || provider === "Trakt");
  // One TVDB episode's TMDB external-ID crosswalk: its request is shared with every comparison needing it.
  const sharedCrosswalk = provider === "TMDB" && findId && episodeIdentity?.provider === "TVDB" ? Number(findId) : undefined;
  let value: T;
  let receivedAt: string;
  try {
    if (provider === "TVDB" && show?.tvdbAuthenticationError) throw show.tvdbAuthenticationError;
    if (sharedCrosswalk !== undefined) ({value, receivedAt} = await requestTmdbCrosswalk(sharedCrosswalk, () => scanProviderClient.json<T>(url, init, provider)));
    else { value = await scanProviderClient.json<T>(url, init, provider, auth); receivedAt = new Date().toISOString(); }
  }
  catch (error) {
    // A login that cannot be recovered is one library issue, not a failure of each lookup it stops.
    if (provider === "Trakt" && auth && isProviderLoginFailure("Trakt", error)) { raiseTraktLoginIssue(error); throw new TraktLoginUnavailableError(error); }
    if (show && matching) {
      const externalId = episodeIdentity?.id;
      setCoverageIssue({id:issueId,failedAt:new Date().toISOString(),...(provider === "TVDB" && error === show.tvdbAuthenticationError ? {causedBy:["provider-authentication:TVDB"]} : {}),operation:findId && !episodeIdentity ? "provider-association" : "episode-identity",provider,scope:tvdbEpisodeId || externalId || coordinate ? "episode" : "show",show:{ratingKey:show.ratingKey,title:show.title,tmdbId:show.tmdbId,tvdbId:show.tvdbId},
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
  // Only a successful Trakt lookup shows the login works again.
  if (provider === "Trakt" && auth) resolveCoverageIssue("provider-authentication:Trakt");
  if (relationships) relationships[key] = {provider, value, receivedAt};
  return value;
}
/** In-flight TMDB external-ID crosswalk requests, by TVDB episode. */
const tmdbCrosswalkRequests = new Map<number, Promise<{value: unknown; receivedAt: string}>>();
/**
 * Requests one TVDB episode's TMDB external-ID crosswalk once for every comparison waiting on
 * it, and records the outcome as shared crosswalk evidence before any caller resumes: a usable
 * response with its receipt time, or a rejection for a failed request or unreadable response.
 */
function requestTmdbCrosswalk<T>(tvdbEpisodeId: number, request: () => Promise<T>): Promise<{value: T; receivedAt: string}> {
  const pending = tmdbCrosswalkRequests.get(tvdbEpisodeId);
  if (pending) return pending as Promise<{value: T; receivedAt: string}>;
  const started = request().then(value => {
    const receivedAt = new Date().toISOString();
    saveSharedTmdbCrosswalk(tvdbEpisodeId, readableTmdbCrosswalk(value) ? {value, receivedAt} : {value, rejectedAt: receivedAt});
    return {value, receivedAt};
  }, error => {
    saveSharedTmdbCrosswalk(tvdbEpisodeId, {rejectedAt: new Date().toISOString()});
    throw error;
  }).finally(() => tmdbCrosswalkRequests.delete(tvdbEpisodeId));
  tmdbCrosswalkRequests.set(tvdbEpisodeId, started);
  return started;
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

/** Offline rechecks answer every Trakt lookup from saved relationships, so they never send this login. */
const savedRelationshipsOnly: ProviderAuth = {
  ready: async () => { throw new Error("An offline recheck does not contact Trakt."); },
  credential: () => { throw new Error("An offline recheck does not contact Trakt."); },
  recover: async () => {},
};

/** A Trakt request with the run's Trakt login, which the client refreshes once if Trakt rejects it. */
async function traktJson<T>(path: string, traktAuth: ProviderAuth): Promise<T> {
  return checkedJson<T>(`${TRAKT}${path}`, { headers: { Accept: "application/json" } }, "Trakt", undefined, traktAuth);
}

async function requestTmdbShow(tmdbId: number, token: string): Promise<TmdbShow | null> {
  return tmdbJson<TmdbShow>(`/tv/${tmdbId}?append_to_response=external_ids`, token);
}

/** TMDB's first TV result for a TVDB series, if any. */
async function requestTmdbShowForTvdb(tvdbId: number, token: string): Promise<TmdbShow | undefined> {
  return (await tmdbJson<{ tv_results?: TmdbShow[] }>(`/find/${tvdbId}?external_source=tvdb_id`, token)).tv_results?.[0];
}

async function tmdbEpisodes(show: TmdbShow, token: string): Promise<NormalisedCatalogue> {
  if (!Number.isFinite(show.id) || !Array.isArray(show.seasons)) throw new Error("TMDB returned an incomplete show catalogue.");
  const seasons = show.seasons;
  const responses = await Promise.all(seasons.map(async (season) => {
    const response = await tmdbJson<{ episodes?: unknown[] }>(`/tv/${show.id}/season/${season.season_number}`, token);
    if (!Array.isArray(response.episodes)) throw new ProviderResponseError("TMDB",{provider:"TMDB",kind:`show ${show.id} season`,id:season.season_number});
    return { season: season.season_number, episodes: response.episodes };
  }));
  const catalogue: NormalisedCatalogue = { episodes: [], malformed: [] };
  for (const response of responses) normaliseTmdbRecords(show, response.season, response.episodes, catalogue);
  return usableCatalogue("TMDB", show.id, catalogue);
}

/**
 * A successful identity/crosswalk response that cannot be interpreted. Distinct from a
 * rejected request: the request policy succeeded, so it is never a provider outage.
 */
class CrosswalkResponseError extends Error {
  constructor(readonly provider: ProviderName, detail: string) { super(`${provider} returned a successful response that could not be interpreted (${detail}).`); }
}
/** An optional list of records in a successful response; absent means none. */
function responseRecords<T>(provider: ProviderName, body: unknown, field: string): T[] {
  if (!isRecord(body)) throw new CrosswalkResponseError(provider, "the response is not an object");
  const list = body[field];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || !list.every(isRecord)) throw new CrosswalkResponseError(provider, `${field} is not a list of records`);
  return list as T[];
}
const usableTmdbShow = (value: unknown): value is TmdbShow => isRecord(value) && typeof value.id === "number";
/** The saved relationship key of one TVDB episode's crosswalk request. */
function crosswalkRelationshipKey(crosswalk: EpisodeCrosswalk, tvdbEpisodeId: number) {
  return crosswalk === "IMDb" ? relationshipKey("TVDB", `${TVDB}/episodes/${tvdbEpisodeId}/extended`) : crosswalk === "Trakt" ? relationshipKey("Trakt", `${TRAKT}/search/tvdb/${tvdbEpisodeId}?type=episode`) : tmdbFindRelationshipKey(tvdbEpisodeId);
}
function readableTmdbCrosswalk(value: unknown) {
  try { responseRecords("TMDB", value, "tv_episode_results"); return true; } catch { return false; }
}
/**
 * How a live scan reaches TMDB external-ID crosswalks: its start, whether this comparison
 * overrides same-day reuse, and the TVDB episodes whose lookups this scan has requested.
 */
type TmdbCrosswalkScan = {startedAt: string; forced: boolean; requested: Set<number>};
/**
 * Episode crosswalk freshness with shared crosswalk evidence: when a live scan reaches one TVDB
 * episode's TMDB external-ID crosswalk, the shared response replaces this comparison's saved
 * copy if it is current; otherwise the copy is discarded so the lookup is requested (or joins
 * the request already in flight), and this returns true. An ordinary lookup accepts a usable
 * response received on or after the scan's starting UTC date. A forced lookup (single-show
 * rescan, provider-change invalidation, or a retry of this show's failed crosswalk) accepts
 * only a usable response this scan requested. Neither renews the receipt time, and no receipt
 * date is ever inferred.
 */
function tmdbCrosswalkNeedsRequest(tvdbEpisodeId: number, scan: TmdbCrosswalkScan) {
  const relationships = relationshipScope.getStore();
  if (!relationships) return false;
  const key = crosswalkRelationshipKey("TMDB", tvdbEpisodeId);
  const shared = readSharedTmdbCrosswalk(tvdbEpisodeId);
  const received = Date.parse(shared?.receivedAt || "");
  const current = Number.isFinite(received) && !shared!.invalidatedAt && (scan.forced ? scan.requested.has(tvdbEpisodeId) : new Date(received).toISOString().slice(0, 10) >= scan.startedAt.slice(0, 10));
  if (!current) { delete relationships[key]; return true; }
  relationships[key] = {provider: "TMDB", value: shared!.value, receivedAt: shared!.receivedAt};
  // A usable response to this exact lookup resolves this show's failed request for it.
  resolveCoverageIssue(episodeIdentityIssueId(comparisonIssueScope.getStore()?.ratingKey, key));
  return false;
}
/** The TVDB episode whose TMDB external-ID crosswalk a saved relationship key names, if any. */
function tmdbCrosswalkEpisode(relationship: string) {
  const tvdbEpisodeId = Number(relationship.match(/\/find\/(\d+)\?/)?.[1]);
  return Number.isSafeInteger(tvdbEpisodeId) && relationship === crosswalkRelationshipKey("TMDB", tvdbEpisodeId) ? tvdbEpisodeId : undefined;
}
/**
 * An offline recheck replays this comparison's saved crosswalk response, unless the shared
 * outcome is newer (an undated copy counts as older): a later live refresh, possibly in another
 * show's comparison, replaced or rejected it. A replacing usable response is replayed with its
 * original receipt time; a rejection grants nothing, and only an unreadable payload is kept to
 * explain the failure. Without a saved copy, a usable shared response fills the gap only when
 * this show's own live request for the lookup failed (its failed request is still recorded)
 * before that response was received; it then resolves that failed request, as live reuse does.
 * A copy missing for any other reason stays unavailable. Replay makes no request and renews nothing.
 */
function replayedTmdbCrosswalk(tvdbEpisodeId: number) {
  const relationships = relationshipScope.getStore();
  const shared = readSharedTmdbCrosswalk(tvdbEpisodeId);
  const outcomeAt = Date.parse(shared?.receivedAt || shared?.rejectedAt || "");
  if (!relationships || !shared || !Number.isFinite(outcomeAt)) return;
  const key = crosswalkRelationshipKey("TMDB", tvdbEpisodeId);
  if (!Object.hasOwn(relationships, key)) {
    const issueId = episodeIdentityIssueId(comparisonIssueScope.getStore()?.ratingKey, key);
    const failedAt = Date.parse(getCoverageIssue(issueId)?.failedAt || "");
    if (!shared.receivedAt || !Number.isFinite(failedAt) || outcomeAt <= failedAt) return;
    relationships[key] = {provider: "TMDB", value: shared.value, receivedAt: shared.receivedAt};
    // Resolved only after the recheck saves the recovered answer, so it stays recoverable.
    replayScope.getStore()?.recovered.set(key, issueId);
    return;
  }
  const savedAt = Date.parse(relationships[key].receivedAt || "");
  if (Number.isFinite(savedAt) && savedAt >= outcomeAt) return;
  if (shared.receivedAt) relationships[key] = {provider: "TMDB", value: shared.value, receivedAt: shared.receivedAt};
  else if (Object.hasOwn(shared, "value")) relationships[key] = {provider: "TMDB", value: shared.value};
  // A rejection without an unreadable payload leaves no saved response.
  else delete relationships[key];
}
/**
 * A failed live check of one TVDB episode's TMDB external-ID crosswalk rejects its saved
 * evidence. A failed request leaves no saved response; an unreadable successful response is
 * kept only so offline rechecks can explain the failure, without a receipt time, so it is
 * never current and never grants coverage.
 */
function rejectTmdbCrosswalk(tvdbEpisodeId: number) {
  const saved = relationshipScope.getStore()?.[crosswalkRelationshipKey("TMDB", tvdbEpisodeId)];
  if (saved) delete saved.receivedAt;
}
/**
 * A last-good comparison retained after a failed live scan keeps its saved evidence, except
 * that the outcomes of the TMDB external-ID crosswalks this scan checked (`checked`) replace
 * it: a rejected expired response is not retained, and a response this scan used replaces the
 * older one. Other provider relationships received during the scan are not merged. Offline
 * rechecks therefore cannot revive evidence the live scan rejected.
 */
function withLiveCrosswalkOutcomes(saved: SavedPlexComparison, live: SavedPlexComparison["relationships"], checked: Set<string>): SavedPlexComparison {
  const relationships = {...saved.relationships};
  for (const key of checked) if (Object.hasOwn(live, key)) relationships[key] = live[key]; else delete relationships[key];
  return {...saved, relationships};
}
/** A failed request or interpretation within one episode's crosswalk, with the saved relationship it concerns. */
type CrosswalkCause = { error: unknown; relationship: string };
/** When one crosswalk has causes of several kinds, the most actionable kind names it. */
const crosswalkFailureKinds: EpisodeCheckFailure["kind"][] = ["request-failed", "unreadable-response", "relationship-unavailable", "exception"];

async function findTmdbEpisodeByTvdbId(tvdbEpisodeId: number, token: string): Promise<TmdbEpisodeFindResult[]> {
  const found = await tmdbJson<unknown>(`/find/${tvdbEpisodeId}?external_source=tvdb_id`, token, {provider:"TVDB",id:tvdbEpisodeId});
  return responseRecords<TmdbEpisodeFindResult>("TMDB", found, "tv_episode_results");
}

async function tmdbShowsForTvdbId(tvdbShowId: number, token: string): Promise<TmdbShow[]> {
  const found = await tmdbJson<unknown>(`/find/${tvdbShowId}?external_source=tvdb_id`, token);
  return responseRecords<TmdbShow>("TMDB", found, "tv_results").filter(usableTmdbShow);
}

async function tvdbShow(seriesId: number, token: string): Promise<TvdbShow | null> {
  const response = await checkedJson<{ data?: { id?: number; name?: string; slug?: string; year?: string } }>(`${TVDB}/series/${seriesId}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
  return response.data ? { id: response.data.id || seriesId, name: response.data.name, slug: response.data.slug, year: response.data.year } : null;
}

/**
 * `retry`: a previous Trakt crosswalk for this episode failed, so saved validation responses
 * are requested again instead of reused. `validationFailures` are failed validation lookups.
 */
async function findEpisodeViaTrakt(tvdbEpisodeId: number, equivalentTmdbIds: Set<number>, tvdbShowId: number, localTmdbEpisodeIds: Set<number>, traktAuth: ProviderAuth, tmdbToken: string, retry = false) {
  const cached = relationshipIsReusable(crosswalkRelationshipKey("Trakt", tvdbEpisodeId));
  const results = await traktJson<unknown>(`/search/tvdb/${tvdbEpisodeId}?type=episode`, traktAuth);
  if (!Array.isArray(results)) throw new CrosswalkResponseError("Trakt", "the episode search result is not a list");
  const sameShow = (results.filter(isRecord) as TraktEpisodeSearchResult[]).filter((result) => result.type === "episode" && Number.isFinite(result.show?.ids?.tmdb) && equivalentTmdbIds.has(result.show!.ids!.tmdb as number) && result.show?.ids?.tvdb === tvdbShowId);
  const completeMappings = sameShow.filter((result) => result.episode?.ids?.tvdb === tvdbEpisodeId && Number.isFinite(result.episode.ids.tmdb) && Number.isFinite(result.episode.season) && Number.isFinite(result.episode.number));
  if (!completeMappings.length) return { validated: false, owned: false, validationFailed: 0, traktTmdbIds: [] as number[], validatedTmdbIds: [] as number[], validationFailures: [] as CrosswalkCause[] };
  const validations = await Promise.allSettled(completeMappings.map(async (result) => {
    const episode = result.episode!;
    const matchedTmdbShowId = result.show!.ids!.tmdb as number;
    const origin = comparisonIssueScope.getStore();
    const path = `/tv/${matchedTmdbShowId}/season/${episode.season}/episode/${episode.number}`;
    const relationship = relationshipKey("TMDB", `${TMDB}${path}`);
    if (retry && !replayScope.getStore()) delete relationshipScope.getStore()?.[relationship];
    const details = await lookupSourceScope.run([
      ...(origin?.tvdbSource || []),{provider:"TVDB",kind:"catalogue episode",id:tvdbEpisodeId,cached:origin?.tvdbCached},
      {provider:"Trakt",kind:"external TMDB show ID",id:matchedTmdbShowId,cached},
      {provider:"Trakt",kind:"external TMDB episode ID",id:episode.ids!.tmdb as number,cached},
    ],()=>tmdbJson<unknown>(path, tmdbToken)).catch(error => { throw Object.assign(new Error("validation"), { cause: error, relationship }); });
    if (!isRecord(details)) throw Object.assign(new Error("validation"), { cause: new CrosswalkResponseError("TMDB", "the validating episode record is not an object"), relationship });
    return details.id === episode.ids!.tmdb ? details.id as number : undefined;
  }));
  const validatedIds = validations.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  const validationFailures = validations.flatMap((result) => result.status === "rejected" ? [{ error: (result.reason as { cause?: unknown }).cause ?? result.reason, relationship: (result.reason as { relationship?: string }).relationship || "" }] : []);
  return { validated: validatedIds.length > 0, owned: validatedIds.some((id) => localTmdbEpisodeIds.has(id)), ownedTmdbId: validatedIds.find((id) => localTmdbEpisodeIds.has(id)), validationFailed: validations.length - validatedIds.length, traktTmdbIds: completeMappings.map((result) => result.episode!.ids!.tmdb as number), validatedTmdbIds: validatedIds, validationFailures };
}

async function tvdbSeries(seriesId: number, token: string, cachedSlug?: string, showTitle?: string): Promise<NormalisedCatalogue & { slug?: string; name?: string }> {
  const catalogue: NormalisedCatalogue = { episodes: [], malformed: [] };
  const series = cachedSlug ? null : await checkedJson<{ data?: { slug?: string; name?: string } }>(`${TVDB}/series/${seriesId}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
  if (!cachedSlug && !series?.data) throw new Error("TVDB returned an incomplete series catalogue.");
  let page = 0;
  while (page < 100) {
    const body = await checkedJson<{ data?: { episodes?: unknown[] }; links?: { next?: string | null } }>(`${TVDB}/series/${seriesId}/episodes/default?page=${page}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
    if (!Array.isArray(body.data?.episodes)) throw new ProviderResponseError("TVDB",{provider:"TVDB",kind:"series episode catalogue",id:seriesId});
    // Specials (season 0) are kept so Report Missing can be evaluated on them; the
    // comparator still ignores unflagged specials, as before.
    normaliseTvdbRecords(seriesId, series?.data?.name || showTitle, page, body.data.episodes, catalogue);
    if (!body.links?.next) break;
    page += 1;
    if (page >= 100) throw new Error("TVDB episode catalogue exceeded the safe pagination limit.");
  }
  return { ...usableCatalogue("TVDB", seriesId, catalogue), slug: cachedSlug || series?.data?.slug, name: series?.data?.name };
}

/**
 * Individual malformed records are episode-scoped. A catalogue whose records are
 * all unusable is an unreadable catalogue, never an empty verified one.
 */
function usableCatalogue(provider: CoverageProvider, showId: number, catalogue: NormalisedCatalogue) {
  if (!catalogue.episodes.length && catalogue.malformed.length) throw new ProviderResponseError(provider,{provider,kind:provider === "TMDB" ? "show episode catalogue" : "series episode catalogue",id:showId});
  return catalogue;
}

async function tvdbEpisodeImdbIds(episodeId: number, token: string) {
  const body = await checkedJson<unknown>(`${TVDB}/episodes/${episodeId}/extended`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
  if (!isRecord(body) || !isRecord(body.data)) throw new CrosswalkResponseError("TVDB", "the episode record is missing");
  const remoteIds = body.data.remoteIds;
  if (remoteIds !== undefined && remoteIds !== null && !Array.isArray(remoteIds)) throw new CrosswalkResponseError("TVDB", "remoteIds is not a list");
  // Remote IDs of other sources may use other shapes; only IMDb episode IDs are read.
  return new Set(((remoteIds || []) as unknown[]).flatMap((remote) => isRecord(remote) && typeof remote.id === "string" && /^tt\d+$/i.test(remote.id) ? [remote.id.toLowerCase()] : []));
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
 * saved TMDB catalogue holds a durable specific requirement for the compared TMDB catalogue, added
 * beside any work already open; otherwise it stays pending.
 */
function retainSafeguard(inputs: PlexGeneratedInputs, utcDate: string, changes: Set<number> | null, candidates: PlexShowGroup[]) {
  if (changes === null) {
    if (!inputs.pendingSafeguards[utcDate]) { inputs.pendingSafeguards[utcDate] = true; savePendingSafeguards(inputs.pendingSafeguards); }
    return;
  }
  for (const group of candidates) {
    const comparison = inputs.comparisons[group.identity];
    if (!comparison?.tmdbId || !changes.has(comparison.tmdbId) || !inputs.tmdb[String(comparison.tmdbId)]) continue;
    if (savedObligation(comparison.refresh, "tmdb").specificIds?.includes(comparison.tmdbId)) continue;
    comparison.refresh = patchSavedObligation({...comparison.refresh}, "tmdb", {add: {specificIds: [comparison.tmdbId]}});
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
  providerEpisodes: ProviderEpisode[];
  /** Individual catalogue records that could not be used in full; mapped records with an ID but no numbering are still checked by ID. */
  malformedRecords: MalformedCatalogueRecord[];
  tmdbEpisodeAliases: Set<number>; cachedTvdbEpisodeImdbIds: Record<string,string[]>;
  libraryTmdbEpisodeIds: Set<number>; libraryTvdbEpisodeIds: Set<number>; libraryImdbEpisodeIds: Set<string>;
  mappings: ReturnType<typeof listCoverageMappings>; manualInventory: CoverageEvidence[]; autoCompoundEpisodes: boolean;
  config: {tmdbToken:string}; token: string; traktAuth: ProviderAuth | null;
  tvdbChanges: Set<number> | null; logger: Pick<ScanLogger,"info"|"warn">;
  setHeartbeat: (key:string,title:string,phase:string)=>void;
  /** A live scan's TMDB external-ID crosswalk policy; absent in an offline replay. */
  tmdbCrosswalkScan?: TmdbCrosswalkScan;
  /** Collects the saved relationship keys of TMDB external-ID crosswalks this live scan checked. */
  checkedTmdbCrosswalks?: Set<string>;
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
/**
 * Manual Match members this show's saved provider catalogue lacks as comparable
 * episodes, rebuilt from the saved member records:
 * - specials (season 0): catalogues saved before specials were kept have none, so
 *   without this a saved Report Missing decision on a special would stay hidden
 *   until the next download;
 * - catalogue records with an ID but no usable numbering (`unnumbered`): their
 *   ID-based checks (Report Missing, direct ownership, Manual Match) still apply,
 *   using the numbering saved with the member rather than an invented one.
 * Only resolved catalogues of this show's own provider IDs are supplemented; real
 * catalogue records always win.
 */
export function mappedMembersMissingFromCatalogue(catalogueEpisodes: ProviderEpisode[], mappings: { members: CoverageMember[] }[], show: { tmdbId?: number; tvdbId?: number }, unnumbered: MalformedCatalogueRecord[] = []): ProviderEpisode[] {
  const present = new Set(catalogueEpisodes.flatMap(episode => episode.providerEpisodeId ? [`${episode.source}:${episode.providerEpisodeId}`] : []));
  const unnumberedIds = new Set(unnumbered.flatMap(record => record.id !== undefined && record.season === undefined ? [`${record.provider}:${record.id}`] : []));
  const added = new Set<string>();
  return mappings.flatMap(mapping => mapping.members).flatMap(member => {
    const key = `${member.provider}:${member.id}`;
    const ownShow = member.provider === "TMDB" ? show.tmdbId === member.showId : show.tvdbId === member.showId;
    if ((member.season !== 0 && !unnumberedIds.has(key)) || !ownShow || present.has(key) || added.has(key)) return [];
    added.add(key);
    return [{ showTitle: member.show, season: member.season, episode: member.episode, title: member.title, providerEpisodeId: member.id, source: member.provider }];
  });
}

/** Resolve automatic evidence once, using either live saved relationships or strict saved-input replay. */
async function compareLoadedPlexShow(input: LoadedComparison) {
  const {group,details,localMetadata,tmdbId,tvdbId,tmdbShow,tvdbResolved,tvdbSlug,tmdbEpisodeAliases,libraryTmdbEpisodeIds,libraryTvdbEpisodeIds,libraryImdbEpisodeIds,mappings,manualInventory,autoCompoundEpisodes,config,token,traktAuth,tvdbChanges,logger,setHeartbeat}=input;
  let {cachedTvdbEpisodeImdbIds}=input;
  const providerEpisodes=[...input.providerEpisodes,...mappedMembersMissingFromCatalogue(input.providerEpisodes,mappings,{tmdbId:tmdbShow ? tmdbShow.id : undefined,tvdbId:tvdbResolved ? tvdbId : undefined},input.malformedRecords)];
  let warning: string | undefined;
  const primary=group.records[0], ratingKey=group.identity;
  const plexGuids=[...new Set(details.flatMap(d=>d.guid?.startsWith("plex://show/") ? [d.guid] : []))];
  // Every reported series ID stays identity evidence; only the selected one supplies the catalogue.
  const {tmdb:plexTmdbIds,tvdb:plexTvdbIds}=showProviderIds(details.flatMap(d=>d.Guid || []));
  const {localEpisodes,localProviderEpisodes,localTmdbEpisodeIds}=localComparisonInventory(localMetadata);
  let tmdbSeriesMatches: TmdbShow[]=[], tvdbSeriesMatches: TvdbShow[]=[], equivalentTmdbIds=new Set<number>();
  const autoMatchEvidence=new Map<number,{method:PlexAutoMatchMethod;tmdbEpisodeId:number;tmdbEpisode?:TmdbEpisodeFindResult}>();
  const phaseTimings: Record<string,number>={};
  // Failed episode crosswalks are episode-scoped: they are explained on the show result but
  // never make its saved comparison incomplete, so cached rechecks can still replay it.
  const recordWarning=(message:string)=>{warning=warning ? `${warning} ${message}` : message;};
        // Episode-scoped identity/crosswalk failures (GLOSSARY): each failed lookup or
        // unreadable successful response stays with its TVDB episode. It grants no
        // coverage, and later independent methods and sibling episodes still run.
        const crosswalkFailures: EpisodeCheckFailure[] = [];
        const crosswalksAttempted = new Set<string>();
        const tvdbEpisodeOf = (id: number) => providerEpisodes.find((episode) => episode?.source === "TVDB" && episode.providerEpisodeId === id);
        const crosswalkEpisode = (id: number) => episodeReference("TVDB", { ...tvdbEpisodeOf(id), providerEpisodeId: id });
        /** One failed request or interpretation within a crosswalk: a rejected request has its own Provider Lookup cause; anything else is never relabelled as one. */
        const crosswalkCause = ({ error, relationship }: CrosswalkCause) => {
          const requestIssue = episodeIdentityIssueId(ratingKey, relationship);
          // A replay without a saved response keeps the scan's rejected-request cause when there is one.
          const kind: EpisodeCheckFailure["kind"] = error instanceof CrosswalkResponseError ? "unreadable-response" : getCoverageIssue(requestIssue) ? "request-failed" : error instanceof SavedRelationshipUnavailableError ? "relationship-unavailable" : "exception";
          return kind === "request-failed" ? { kind, reason: `the ${relationshipProvider(relationship)} request failed.`, requestIssue } : { kind, reason: coverageIssueCause(error) };
        };
        /** Record one episode's failed crosswalk with every cause found for it (e.g. each failed Trakt validation). */
        const failCrosswalk = (crosswalk: EpisodeCrosswalk, tvdbEpisodeId: number, causes: CrosswalkCause[]): EpisodeCheckFailure => {
          const found = causes.map(crosswalkCause);
          const causedBy = [...new Set(found.flatMap(cause => cause.requestIssue ? [cause.requestIssue] : []))];
          const failure: EpisodeCheckFailure = { operation: "episode-crosswalk", crosswalk, episode: crosswalkEpisode(tvdbEpisodeId),
            kind: crosswalkFailureKinds.find(kind => found.some(cause => cause.kind === kind))!,
            reason: [...new Set(found.map(cause => cause.reason))].join(" "),
            ...(causedBy.length ? { causedBy } : {}) };
          crosswalkFailures.push(failure);
          return failure;
        };
        const failedLookup = (crosswalk: EpisodeCrosswalk, tvdbEpisodeId: number, error: unknown) => failCrosswalk(crosswalk, tvdbEpisodeId, [{ error, relationship: crosswalkRelationshipKey(crosswalk, tvdbEpisodeId) }]);
        /** Run one crosswalk per TVDB episode; a failure is recorded against its episode only. */
        const settleCrosswalks = async <T,>(crosswalk: EpisodeCrosswalk, ids: number[], lookup: (tvdbEpisodeId: number) => Promise<T>) => {
          const settled = await Promise.allSettled(ids.map((tvdbEpisodeId) => { crosswalksAttempted.add(`${crosswalk}:${tvdbEpisodeId}`); return crosswalkLookupScope.run(true, () => lookup(tvdbEpisodeId)); }));
          const fulfilled: { tvdbEpisodeId: number; value: T }[] = [];
          const requestFailures: string[] = [];
          settled.forEach((result, index) => {
            if (result.status === "fulfilled") fulfilled.push({ tvdbEpisodeId: ids[index], value: result.value });
            // Skipped for the run's Trakt login: not a lookup, so any earlier failure of it stays as it was.
            else if (result.reason instanceof TraktLoginUnavailableError) crosswalksAttempted.delete(`${crosswalk}:${ids[index]}`);
            else if (failedLookup(crosswalk, ids[index], result.reason).kind === "request-failed") requestFailures.push(coverageIssueCause(result.reason));
          });
          return { fulfilled, requestFailures };
        };
        /** Interpret one episode's crosswalk evidence; an unexpected exception stays with that episode. */
        const interpret = (crosswalk: EpisodeCrosswalk, tvdbEpisodeId: number, run: () => void) => {
          try { run(); } catch (error) { failedLookup(crosswalk, tvdbEpisodeId, error); }
        };
        // A failed crosswalk is requested again on the next scan instead of reusing its saved response.
        const recordedCrosswalkFailures = recordedEpisodeCrosswalkFailures(ratingKey);
        const retryCrosswalks = new Set(recordedCrosswalkFailures.map(({ crosswalk, tvdbEpisodeId }) => `${crosswalk}:${tvdbEpisodeId}`));
        if (!replayScope.getStore()) for (const { crosswalk, tvdbEpisodeId } of recordedCrosswalkFailures) {
          delete relationshipScope.getStore()?.[crosswalkRelationshipKey(crosswalk, tvdbEpisodeId)];
          if (crosswalk === "IMDb") delete cachedTvdbEpisodeImdbIds[String(tvdbEpisodeId)];
        }
        if (tvdbId) {
          tmdbSeriesMatches = await tmdbShowsForTvdbId(tvdbId, config.tmdbToken).catch((error) => {
            logger.warn("plex.show.tmdb-equivalent-series-unavailable", { ratingKey, tmdbShowId: tmdbShow?.id, tvdbShowId: tvdbId, error: coverageIssueCause(error) });
            return [];
          });
        }
        const knownTmdbIds = new Set(tmdbSeriesMatches.map((show) => show.id));
        const extraTmdbShows = await Promise.allSettled(plexTmdbIds.filter((id) => !knownTmdbIds.has(id) && id !== tmdbShow?.id).map((id) => tmdbJson<unknown>(`/tv/${id}`, config.tmdbToken)));
        tmdbSeriesMatches = [...tmdbSeriesMatches, ...(tmdbShow ? [tmdbShow] : []), ...extraTmdbShows.flatMap((result) => result.status === "fulfilled" && usableTmdbShow(result.value) ? [result.value] : [])].filter((show, index, matches) => matches.findIndex((candidate) => candidate.id === show.id) === index);
        // Episode-discovered aliases describe provider relationships, independently of
        // whether the current library still owns one of their episodes.
        const savedAliasSummaries = await Promise.allSettled([...tmdbEpisodeAliases].filter(id => !tmdbSeriesMatches.some(show => show.id === id)).map(id => tmdbJson<unknown>(`/tv/${id}?append_to_response=external_ids`, config.tmdbToken)));
        tmdbSeriesMatches.push(...savedAliasSummaries.flatMap(result => result.status === "fulfilled" && usableTmdbShow(result.value) ? [result.value] : []));
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
          const imdbLookups = await settleCrosswalks("IMDb", [...coordinateMissingTvdbIds].filter((id) => !locallySatisfiedTvdbIds.has(id)), async (tvdbEpisodeId) => {
            const cached = canReuseTvdbEpisodeIds ? cachedTvdbEpisodeImdbIds[String(tvdbEpisodeId)] : undefined;
            const imdbIds = cached ? new Set(cached) : await tvdbEpisodeImdbIds(tvdbEpisodeId, token);
            cachedTvdbEpisodeImdbIds[String(tvdbEpisodeId)] = [...imdbIds];
            return imdbIds;
          });
          const failedImdbLookups = imdbLookups.requestFailures.length;
          if (failedImdbLookups) recordWarning(`${failedImdbLookups} TVDB IMDb identity ${failedImdbLookups === 1 ? "lookup" : "lookups"} failed; ${failedImdbLookups === 1 ? "it is" : "they are"} requested again on the next scan.`);
          for (const { tvdbEpisodeId, value: imdbIds } of imdbLookups.fulfilled) interpret("IMDb", tvdbEpisodeId, () => {
            if (![...imdbIds].some((id) => libraryImdbEpisodeIds.has(id))) return;
            const localMatch = localProviderEpisodes.find((episode) => episode.tmdbEpisodeId && episode.imdbEpisodeId && imdbIds.has(episode.imdbEpisodeId));
            locallySatisfiedTvdbIds.add(tvdbEpisodeId);
            directImdbSatisfied.add(tvdbEpisodeId);
            if (localMatch?.tmdbEpisodeId) autoMatchEvidence.set(tvdbEpisodeId, { method: "Matched via IMDb", tmdbEpisodeId: localMatch.tmdbEpisodeId });
            logger.info("plex.show.episode-crosswalk-decision", { ratingKey, tvdbShowId: tvdbId, tvdbEpisodeId, imdbEpisodeIds: [...imdbIds], outcome: "reconciled-by-direct-imdb-guid" });
          });
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
          if (traktAuth && tvdbId) {
            const traktCrosswalks = await settleCrosswalks("Trakt", [...crosswalkCandidateTvdbIds], (tvdbEpisodeId) => findEpisodeViaTrakt(tvdbEpisodeId, equivalentTmdbIds, tvdbId!, libraryTmdbEpisodeIds, traktAuth, config.tmdbToken, retryCrosswalks.has(`Trakt:${tvdbEpisodeId}`)));
            traktFailed = traktCrosswalks.requestFailures.length;
            for (const reason of traktCrosswalks.requestFailures) traktFailureReasons.add(reason);
            for (const { tvdbEpisodeId, value: result } of traktCrosswalks.fulfilled) interpret("Trakt", tvdbEpisodeId, () => {
              traktValidationFailed += result.validationFailed;
              crosswalkDetails.set(tvdbEpisodeId, { traktTmdbIds: result.traktTmdbIds, validatedTmdbIds: result.validatedTmdbIds });
              // A validation that could not be completed is a failed check, even when another
              // validation succeeds; a mismatch is not.
              if (result.validationFailures.length) failCrosswalk("Trakt", tvdbEpisodeId, result.validationFailures);
              if (!result.validated) {
                traktInvalid += 1;
                crosswalkDecisions.set(tvdbEpisodeId, "trakt-invalid-tmdb-fallback");
                return;
              }
              if (result.owned) {
                tmdbFallbackIds.delete(tvdbEpisodeId);
                locallySatisfiedTvdbIds.add(tvdbEpisodeId);
                traktSatisfied.add(tvdbEpisodeId);
                if (result.ownedTmdbId) autoMatchEvidence.set(tvdbEpisodeId, { method: "Matched via Trakt", tmdbEpisodeId: result.ownedTmdbId });
                traktReconciled += 1;
                crosswalkDecisions.set(tvdbEpisodeId, "reconciled-by-validated-trakt");
              } else { traktValidatedNotOwned += 1; crosswalkDecisions.set(tvdbEpisodeId, "trakt-not-owned-tmdb-fallback"); }
            });
            if (traktFailed) recordWarning(`${traktFailed} Trakt episode identity ${traktFailed === 1 ? "lookup" : "lookups"} failed; ${traktFailed === 1 ? "it is" : "they are"} requested again on the next scan.`);
          }
          const crosswalks = await settleCrosswalks("TMDB", [...tmdbFallbackIds], (tvdbEpisodeId) => {
            if (!replayScope.getStore()) input.checkedTmdbCrosswalks?.add(crosswalkRelationshipKey("TMDB", tvdbEpisodeId));
            const scan = input.tmdbCrosswalkScan;
            if (replayScope.getStore()) replayedTmdbCrosswalk(tvdbEpisodeId);
            else if (scan && tmdbCrosswalkNeedsRequest(tvdbEpisodeId, {...scan, forced: scan.forced || retryCrosswalks.has(`TMDB:${tvdbEpisodeId}`)})) {
              // Recorded once settled, so a forced lookup never adopts the older response this request replaces.
              return findTmdbEpisodeByTvdbId(tvdbEpisodeId, config.tmdbToken).finally(() => scan.requested.add(tvdbEpisodeId));
            }
            return findTmdbEpisodeByTvdbId(tvdbEpisodeId, config.tmdbToken);
          });
          const unknownTmdbShowIds = [...new Set(crosswalks.fulfilled.flatMap(({ value: matches }) => matches.flatMap((episode) => typeof episode.show_id === "number" && !equivalentTmdbIds.has(episode.show_id) ? [episode.show_id] : [])))];
          for (const id of unknownTmdbShowIds) tmdbEpisodeAliases.add(id);
          const aliasChecks = await Promise.allSettled(unknownTmdbShowIds.map((showId) => tmdbJson<unknown>(`/tv/${showId}?append_to_response=external_ids`, config.tmdbToken)));
          for (const alias of aliasChecks) if (alias.status === "fulfilled" && usableTmdbShow(alias.value)) {
            // The episode-level /find result is already an explicit provider link.
            // Fetching the show only enriches reporting; it does not validate or veto that link.
            if (!tmdbSeriesMatches.some((show) => show.id === (alias.value as TmdbShow).id)) tmdbSeriesMatches.push(alias.value);
            if (tvdbId && tmdbShowLinksToTvdb(alias.value, tvdbId)) equivalentTmdbIds.add(alias.value.id);
          }
          let rejectedOtherShow = 0;
          let unmatched = 0;
          for (const { tvdbEpisodeId, value: matches } of crosswalks.fulfilled) interpret("TMDB", tvdbEpisodeId, () => {
            const sameShowMatches = matches.filter((episode) => episode.show_id && equivalentTmdbIds.has(episode.show_id));
            crosswalkDetails.set(tvdbEpisodeId, { ...crosswalkDetails.get(tvdbEpisodeId), tmdbFindIds: matches.flatMap((episode) => episode.id ? [episode.id] : []) });
            const ownedTmdbMatch = ownedTmdbEpisodeMatch(matches, libraryTmdbEpisodeIds);
            if (ownedTmdbMatch?.id) {
              locallySatisfiedTvdbIds.add(tvdbEpisodeId); tmdbSatisfied.add(tvdbEpisodeId); autoMatchEvidence.set(tvdbEpisodeId, { method: "Matched via TMDB External ID", tmdbEpisodeId: ownedTmdbMatch.id, tmdbEpisode: ownedTmdbMatch }); crosswalkDecisions.set(tvdbEpisodeId, "reconciled-by-tmdb-find");
              // No parent-series agreement or secondary lookup is required: Plex owns
              // the exact TMDB episode returned for this TVDB episode external ID.
            }
            else if (matches.length && !sameShowMatches.length) rejectedOtherShow += 1;
            else unmatched += 1;
            if (!crosswalkDecisions.has(tvdbEpisodeId)) crosswalkDecisions.set(tvdbEpisodeId, matches.length && !sameShowMatches.length ? "tmdb-cross-show-rejected" : "reported-missing");
          });
          if (!replayScope.getStore()) for (const failure of crosswalkFailures) if (failure.crosswalk === "TMDB" && failure.episode.id !== undefined) rejectTmdbCrosswalk(failure.episode.id);
          const failedCrosswalks = crosswalks.requestFailures.length;
          if (failedCrosswalks) recordWarning(`${failedCrosswalks} TMDB TVDB-ID ${failedCrosswalks === 1 ? "lookup" : "lookups"} failed; ${failedCrosswalks === 1 ? "it is" : "they are"} requested again on the next scan.`);
          logger.info("plex.show.episode-crosswalk", { ratingKey, strategy: traktAuth ? "trakt-validate-with-tmdb-then-find" : "tmdb-find-by-tvdb-episode-id", equivalentTmdbShowIds: [...equivalentTmdbIds], tvdbCandidates: crosswalkCandidateTvdbIds.size, traktReconciled, traktValidatedNotOwned, traktValidationFailed, traktInvalid, traktFailed, ...(traktFailureReasons.size ? { traktFailureReasons: [...traktFailureReasons].slice(0, 3) } : {}), tmdbFallback: tmdbFallbackIds.size, reconciled: locallySatisfiedTvdbIds.size, rejectedOtherShow, unmatched, failed: failedCrosswalks, crosswalkFailures: crosswalkFailures.length });
          for (const tvdbEpisodeId of crosswalkCandidateTvdbIds) logger.info("plex.show.episode-crosswalk-decision", { ratingKey, tmdbShowId: tmdbShow.id, tvdbShowId: tvdbId, tvdbEpisodeId, ...crosswalkDetails.get(tvdbEpisodeId), outcome: crosswalkDecisions.get(tvdbEpisodeId) || "lookup-failed" });
          phaseTimings.crosswalkMs = Date.now() - crosswalkStarted;
        }
        // A recorded crosswalk failure that was not looked up again (another method made it
        // unnecessary) stays unresolved while its episode remains in the catalogue.
        for (const { crosswalk, tvdbEpisodeId } of recordedCrosswalkFailures) if (!crosswalksAttempted.has(`${crosswalk}:${tvdbEpisodeId}`) && tvdbEpisodeOf(tvdbEpisodeId)) {
          crosswalkFailures.push({ operation: "episode-crosswalk", crosswalk, episode: crosswalkEpisode(tvdbEpisodeId), kind: "exception", reason: "not checked again", existingOnly: "carry" });
        }
        const { missing, coverageOutcomes, autoMatches, compoundCoverage, manualCoverage, diagnostics, episodeFailures } = comparePlexShow({
          ratingKey, primary, tmdbShow, tvdbId, tvdbSlug, tmdbSeriesMatches, providerEpisodes,
          localEpisodes, localProviderEpisodes, localTmdbEpisodeIds, libraryTmdbEpisodeIds,
          coordinateMissingTvdbIds, directTvdbSatisfied, directImdbSatisfied, traktSatisfied,
          tmdbSatisfied, autoMatchEvidence, mappings, manualInventory, autoCompoundEpisodes, crosswalkFailures,
          compoundCausesRecorded: compoundMatchingCausesRecorded(ratingKey),
        });
        for (const { event, data } of diagnostics) logger.info(event, data);
        for (const failure of episodeFailures) logger[failure.existingOnly === "refresh" ? "info" : "warn"]("plex.show.episode-check-failed", { ratingKey, tmdbShowId: tmdbShow?.id, tvdbShowId: tvdbId, ...failure });
        const linkedTvdbIds = [...new Set(tmdbSeriesMatches.flatMap((show) => show.external_ids?.tvdb_id ? [show.external_ids.tvdb_id] : []))];
        const missingTvdbSummaries = linkedTvdbIds.filter((id) => !tvdbSeriesMatches.some((show) => show.id === id));
        const linkedTvdbSummaries = await Promise.allSettled(missingTvdbSummaries.map((id) => tvdbShow(id, token)));
        tvdbSeriesMatches.push(...linkedTvdbSummaries.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []));
        const providerMatches: PlexProviderMatches = {
          tmdb: tmdbSeriesMatches.map((show) => ({ id: show.id, name: show.name, ...(show.first_air_date ? { year: Number(show.first_air_date.slice(0, 4)) } : {}) })),
          tvdb: tvdbSeriesMatches.map((show) => ({ id: show.id, name: show.name, slug: show.slug, ...(show.year && Number.isFinite(Number(show.year)) ? { year: Number(show.year) } : {}) })),
        };
        const result: PlexShowResult = { ratingKey, plexGuid: group.plexGuid, ...(plexGuids.length ? { plexGuids } : {}), plexRatingKeys: group.records.flatMap((record) => record.ratingKey ? [record.ratingKey] : []), title: primary.title || "Unknown show", year: primary.year, thumb: details.find((detail) => detail.thumb)?.thumb || primary.thumb, tmdbId, tvdbId, tvdbSlug, plexEpisodes: localEpisodes.size, providerResolution: { tmdb: Boolean(tmdbShow), tvdb: tvdbResolved }, providerMatches, coverageOutcomes, missing, ...(autoMatches.length ? { autoMatches } : {}), ...(compoundCoverage.length ? { compoundCoverage } : {}), ...(manualCoverage.length ? { manualCoverage } : {}), ...(warning ? { warning } : {}) };
  return {result,tmdbSeriesMatches,tvdbSeriesMatches,cachedTvdbEpisodeImdbIds,episodeFailures};
}

/**
 * One Plex Scan run through the scan run lifecycle. The lifecycle owns status,
 * heartbeat, logger and Resume point policy; the hooks keep what is Plex's own:
 * coverage recheck begin and complete, the coverage-revision veto and the
 * scan-failure Coverage Issue.
 */
function runPlexScan(owner: ScanRunOwner, targetRatingKey?: string) {
  let coverageRevision = coverageState().revision;
  let mappings = listCoverageMappings();
  const settings = readPlexPreferences();
  const autoCompoundEpisodes = settings.autoCompoundEpisodes !== false;
  let finishIgnoreTracking: (() => void) | undefined;
  return scanRuns.run(owner, plexScanMode, {
    fullRun: !targetRatingKey,
    createLogger: () => createScanLogger(settings.diagnosticsEnabled !== false, "shelfcheck-plex"),
    startDetails: { version: SHELFCHECK_VERSION, mode: targetRatingKey ? "single-show" : "full", targetRatingKey, autoCompoundEpisodes },
    phase: "initializing",
    pruneResumePoint: (checkpoint) => checkpointWithoutRatingKey(checkpoint, targetRatingKey!),
    hooks: {
      begin: () => {
        // Ignore tracking spans every report and Resume point write, including a forced failure save.
        finishIgnoreTracking = trackScanIgnores("plex", Date.parse(owner.startedAt));
        if (mappings.length) beginCoverageRecheck(coverageRevision);
        scanProviderClient.startRun();
      },
      // Only the coverage revision this run snapshotted may be committed, as a report or a Resume point.
      veto: () => coverageState().revision !== coverageRevision,
      committed: () => completeCoverageRecheck(coverageRevision),
      succeeded: () => resolveCoverageIssue("scan-failure"),
      failed: (error) => setCoverageIssue({id:"scan-failure",operation:"inventory",provider:"Plex",scope:"library",...providerLookupContext(error,{source:[],requested:{provider:"Plex",kind:"library inventory"},impact:"Library inventory and episode coverage could not be verified. Available last-good results were retained."})}),
      failureDetails: () => ({ providerMetrics: scanProviderClient.metrics() }),
      ended: () => finishIgnoreTracking?.(),
    },
  }, async (run) => {
  const { startedAt, logger, activeWork } = run;
  let processed = 0;
  const setHeartbeat = (key: string, show: string, phase: string) => activeWork.update(key, show, phase);
  const config = await readPlexProviders();
  if (config && mappings.length) {
    await recheckCoverageHealth(scanProviderClient, config);
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
  const token = await authenticateTvdb(scanProviderClient, config.tvdbApiKey, config.tvdbPin).then(token=>{resolveCoverageIssue("provider-authentication:TVDB");return token;}).catch(error=>{
    tvdbAuthenticationError = error;
    setCoverageIssue({id:"provider-authentication:TVDB",operation:"provider-authentication",provider:"TVDB",scope:"library",...providerLookupContext(error,{source:[],requested:{provider:"TVDB",kind:"authentication"},impact:"TVDB catalogue downloads and freshness could not be verified. Available last-good data was retained."})});
    return "";
  });
  // The run's Trakt login: read once, and refreshed now if it is about to expire. Logged out, there is no Trakt login to fix.
  const traktAuth = await TraktRunCredentials.open().then(async credentials=>{if (credentials) await credentials.ready(); else resolveCoverageIssue("provider-authentication:Trakt");return credentials;}).catch((error) => {
    raiseTraktLoginIssue(error);
    logger.warn("plex.crosswalk.trakt-unavailable", { error: coverageIssueCause(error) });
    return null;
  });
  logger.info("plex.crosswalk.providers", { traktConfigured: Boolean(traktAuth), tmdbFallback: true });
  const inputs = readPlexInputs();
  const utcDate = startedAt.slice(0, 10);
  // A scan belongs to its planned UTC start date, even when it finishes after midnight.
  const upcomingFullScan = {utcDate, count: (inputs.completedFullScans?.utcDate === utcDate ? inputs.completedFullScans.count : 0) + 1};
  // Scans 5, 10, ... require today's TMDB change list; an earlier unfinished one stays due today.
  const safeguardDue = !targetRatingKey && (upcomingFullScan.count % 5 === 0 || Boolean(inputs.pendingSafeguards[utcDate]));
  const prior = getPlexReport();
  // Loaded after coverage preparation and the revision snapshot, so the revision check is current.
  const { usable: checkpoint } = run.resumePoint.load((saved) => (saved.coverageRevision || 0) === coverageRevision && checkpointIsUsable(saved, autoCompoundEpisodes));
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
  // TMDB external-ID crosswalks this scan requested, which forced lookups may share.
  const requestedTmdbCrosswalks = new Set<number>();
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
  run.progress(processed, candidates.length);
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
  run.progress(processed, candidates.length);
  const {libraryTmdbEpisodeIds, libraryTvdbEpisodeIds, libraryImdbEpisodeIds} = libraryInventoryIndex(allShows, inputs.inventory.items, ignoredKeys);
  logger.info("plex.library.episode-identities", { tmdb: libraryTmdbEpisodeIds.size, tvdb: libraryTvdbEpisodeIds.size, imdb: libraryImdbEpisodeIds.size });
  // Initialization is over: between active shows the heartbeat now shows "processing".
  run.setPhase(undefined);
  run.resumePoint.startIntervals();
  // The Resume point holds only completed shows whose cache entry is usable.
  run.resumePoint.provideSnapshot((savedAt) => ({
    point: { shows: checkpointShowsWithCache(results, scanCache), scanCache, cacheVersion: CACHE_VERSION, savedAt, autoCompoundEpisodes, coverageRevision },
    details: { shows: results.length, cacheEntries: Object.keys(scanCache).length },
  }));
  await runTrackedWorkerPool(queue, PLEX_SCAN_WORKERS, activeWork, (group) => ({ key: group.identity, show: group.records[0]?.title || "Unknown show" }), async (group) => {
    const primary = group.records[0];
    const ratingKey = group.identity;
    const retainComparison = (message: string) => {
      const previous = prior?.shows.find(show=>show.ratingKey===ratingKey);
      results.push(previous ? {...previous,warning:message} : {ratingKey,title:primary.title || "Unknown show",plexEpisodes:0,missing:[],warning:message});
      if (prior?.scanCache?.[ratingKey]) scanCache[ratingKey] = prior.scanCache[ratingKey];
      processed += 1;
      run.progress(processed, candidates.length);
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
    let metadataComplete = false;
    try {
      const metadata = await Promise.all(group.records.map(async (record) => (await plexJson(`/library/metadata/${record.ratingKey}?includeGuids=1`, config.plexUrl, config.plexToken)).MediaContainer?.Metadata?.[0]));
      details = metadata.map((detail, index) => detail || group.records[index]);
      // A record without usable metadata falls back to its library listing, which cannot establish removed series IDs.
      metadataComplete = metadata.every(detail => Array.isArray(detail?.Guid));
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
    const plexSelection = observeCatalogueCandidates(ratingKey, showProviderIds(details.flatMap((detail) => detail.Guid || [])), metadataComplete);
    let tmdbId = plexSelection.tmdb.preferredId, tvdbId = plexSelection.tvdb.preferredId;
    let tmdbSource: LookupSourceStep[] = tmdbId ? [{provider:"Plex",kind:"TMDB show",id:tmdbId}] : tvdbId ? [{provider:"Plex",kind:"TVDB series",id:tvdbId}] : [];
    let tvdbSource: LookupSourceStep[] = tvdbId ? [{provider:"Plex",kind:"TVDB series",id:tvdbId}] : [];
    const localMetadata = localResponses.flatMap((local) => local.MediaContainer?.Metadata || []);
    const {localEpisodes,localProviderEpisodes,localTmdbEpisodeIds}=localComparisonInventory(localMetadata);
    const localTvdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.tvdbEpisodeId ? [episode.tvdbEpisodeId] : []));
    const localImdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.imdbEpisodeId ? [episode.imdbEpisodeId] : []));
    phaseTimings.plexInventoryMs = Date.now() - phaseStarted;
    let warning: string | undefined;
    let cacheable = true;
    const addWarning = (message: string) => { warning = warning ? `${warning} ${message}` : message; cacheable = false; };
    const providerEpisodes: ProviderEpisode[] = [];
    // Individual catalogue records that could not be used, from whichever catalogue was compared.
    const malformedRecords: MalformedCatalogueRecord[] = [];
    // English title fallback outcome for the compared TVDB catalogue; `carried` when not attempted this scan.
    let titleRecovery: {state: TitleRecoveryState; carried: boolean} = {state: {}, carried: false};
    let tmdbShow: TmdbShow | null = null;
    let tvdbResolved = false;
    let tvdbCatalogueReused = false;
    let tmdbSeriesMatches: TmdbShow[] = [];
    let tvdbSeriesMatches: TvdbShow[] = [];
    let tvdbSlug: string | undefined;
    const savedComparison = inputs.comparisons[ratingKey];
    const refresh = {...savedComparison?.refresh};
    // A specific requirement is dropped only when this complete observation removes its ID from the
    // reported candidates; on hold otherwise, it is kept for when its catalogue is compared again.
    for (const provider of PROVIDERS) if (plexSelection[provider].removed.length) patchSavedObligation(refresh, provider, {remove: {specificIds: plexSelection[provider].removed}});
    inputs.comparisons[ratingKey] = savedComparison ? {...savedComparison,refresh} : {group, details, localMetadata, tmdbId, tvdbId, relationships:{}, tmdbAliases:[], tvdbAliases:[], complete:false, refresh};
    savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
    let tmdbCatalogueReused = false;
    const unavailableCatalogueCauses: string[] = [];
    const tmdbCandidates = plexSelection.tmdb.candidates, tvdbCandidates = plexSelection.tvdb.candidates;
    const catalogueUse: Partial<Record<"tmdb" | "tvdb", CatalogueUse>> = {};
    const catalogueSource = downloadCatalogueSource({
      inputs, now: startedAt, targeted: !!targetRatingKey, tmdbChanges: tmdbCatalogueChanges, tvdbChanges: tvdbCatalogueChanges, tvdbAuthenticationError,
      requests: {
        tmdbShow: id => requestTmdbShow(id, config.tmdbToken),
        tmdbShowForTvdb: tvdbId => requestTmdbShowForTvdb(tvdbId, config.tmdbToken),
        tmdbEpisodes: show => tmdbEpisodes(show, config.tmdbToken),
        tvdbSeries: (id, showTitle) => tvdbSeries(id, token, undefined, showTitle),
        tvdbEnglishTitle: tvdbEpisodeId => scanProviderClient.json(`${TVDB}/episodes/${tvdbEpisodeId}/translations/eng`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB"),
      },
      show: { ratingKey, title: primary.title },
      previousComparison: savedComparison,
      titles: { autoCompoundEpisodes, localEpisodes: localProviderEpisodes },
      logger,
    });
    // The comparison catalogue module chooses both providers' catalogues through the download source,
    // and the scan applies what follows. Each provider's obligation patch is saved before the other
    // provider's work starts.
    // Each provider attempt reports its provider's phase first, TMDB's association request included.
    const phase: Record<CatalogueProvider, string> = {tmdb:"tmdb-show-and-seasons", tvdb:"tvdb-series-and-episodes"};
    const reportPhase = (provider: CatalogueProvider) => setHeartbeat(ratingKey, primary.title || "Unknown show", phase[provider]);
    const source: ComparisonCatalogueSource<DownloadCataloguePayloads> = {
      ...catalogueSource,
      loadCatalogue(provider, id, settings) {
        reportPhase(provider);
        return catalogueSource.loadCatalogue(provider, id, settings);
      },
      tmdbSeriesForTvdb(tvdbId, settings) {
        reportPhase("tmdb");
        return catalogueSource.tmdbSeriesForTvdb(tvdbId, settings);
      },
    };
    phaseStarted = Date.now();
    const resolution = await resolveComparisonCatalogues<DownloadCataloguePayloads>({
      context: {kind:"live-scan"}, show: {ratingKey, title: primary.title}, resolvedAt: startedAt,
      ...(savedComparison ? {previousComparison: {tmdbId: savedComparison.tmdbId, tvdbId: savedComparison.tvdbId, complete: !!savedComparison.complete}} : {}),
      tmdb: {candidates: tmdbCandidates, preferredId: plexSelection.tmdb.preferredId, refreshObligation: savedObligation(refresh, "tmdb"), lookupSource: tmdbSource},
      tvdb: {candidates: tvdbCandidates, preferredId: plexSelection.tvdb.preferredId, refreshObligation: savedObligation(refresh, "tvdb"), lookupSource: tvdbSource},
      }, {source, onProviderResolved: async progress => {
      // The provider-scoped patch changes only its own parts of the saved obligation.
      patchSavedObligation(refresh, progress.provider, progress.obligation);
      savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
      phaseTimings[`${progress.provider}Ms`] = Date.now() - phaseStarted;
      phaseStarted = Date.now();
      // A reused TVDB catalogue asks again for an English title only when the TMDB episodes chosen make it title-dependent.
      if (progress.provider === "tmdb") catalogueSource.compareTitlesWith(progress.catalogue?.catalogue.episodes ?? []);
  }}).catch(error => {
      // Saved progress that cannot be written fails the show with the save's own error, not as a provider failure.
      throw error instanceof ProgressPersistenceError ? error.cause : error;
    });
    const {tmdb, tvdb, resolutionOrder} = resolution;
    for (const provider of resolutionOrder) {
      const {issues, use} = resolution[provider];
      for (const action of issues) {
        if (action.action === "set") setCoverageIssue(action.issue);
        else if (action.action === "resolve") resolveCoverageIssue(action.id);
      }
      if (use.action === "set") catalogueUse[provider] = use.use;
    }
    for (const message of resolution.warnings) addWarning(message);
    // A single-catalogue TVDB series that could not be loaded logs the show's warnings.
    if (tvdb.warning && tvdb.singleCatalogue) logger.warn("plex.show.provider-error", { ratingKey, title: primary.title || "Unknown show", error: warning });
    tmdbId = tmdb.identity; tvdbId = tvdb.identity;
    tmdbSource = tmdb.lookupSource; tvdbSource = tvdb.lookupSource;
    unavailableCatalogueCauses.push(...resolution.unavailableCauses);
    // TVDB chosen before TMDB recovered its titles without TMDB's episodes: the preparation step asks again for those TMDB now makes title-dependent.
    const tmdbCatalogue = tmdb.catalogue;
    const tvdbCatalogue = tvdb.catalogue && resolutionOrder[0] === "tvdb"
      ? await catalogueSource.prepareTitlesNeeded(tvdb.catalogue, [...(tmdbCatalogue?.catalogue.episodes ?? []), ...tvdb.catalogue.catalogue.episodes])
      : tvdb.catalogue;
    tmdbShow = tmdbCatalogue?.catalogue.show ?? null;
    tmdbCatalogueReused = tmdbCatalogue?.origin === "reused";
    tvdbCatalogueReused = tvdbCatalogue?.origin === "reused";
    if (tvdbCatalogue) {
      tvdbResolved = true;
      tvdbSlug = tvdbCatalogue.catalogue.slug;
      titleRecovery = tvdbCatalogue.catalogue.titleRecovery;
    }
    // Comparison order is TMDB, then TVDB; unusable records are listed in the order the catalogues were chosen.
    providerEpisodes.push(...(tmdbCatalogue?.catalogue.episodes ?? []), ...(tvdbCatalogue?.catalogue.episodes ?? []));
    const chosen: Record<CatalogueProvider, {catalogue: {malformed: MalformedCatalogueRecord[]}} | undefined> = {tmdb: tmdbCatalogue, tvdb: tvdbCatalogue};
    for (const provider of resolutionOrder) malformedRecords.push(...(chosen[provider]?.catalogue.malformed ?? []));
    /**
     * Publish the catalogues in use once a comparison completes. Kept last-good results keep the
     * uses they compared, so the new preference reads as pending; only a provider with no usable
     * catalogue records that, since it names no catalogue in use.
     */
    const publishCatalogueUse = (completed: boolean) => {
      for (const provider of PROVIDERS) {
        const use = catalogueUse[provider];
        if (!completed) { if (use?.state === "unavailable") recordCatalogueUse(ratingKey, provider, use); }
        else if (use) recordCatalogueUse(ratingKey, provider, use);
        else clearCatalogueUse(ratingKey, provider);
      }
    };
    if ((tmdbId && !tmdbShow) || (tvdbId && !tvdbResolved) || (!tmdbId && !tvdbId)) {
      const cause = `Episode comparison could not be checked because complete provider catalogue inputs are unavailable. ${savedComparison?.complete ? "Last-good comparison results were retained." : "No previous comparison results are available."}`;
      setCoverageIssue({id:`comparison-inputs:${ratingKey}`,operation:"comparison",scope:"show",show:{ratingKey,title:primary.title,tmdbId,tvdbId},...(unavailableCatalogueCauses.length ? {causedBy:unavailableCatalogueCauses} : {}),cause,action:"Run a Plex scan to refresh the missing provider catalogue inputs; check any reported lookup failure first."});
      if (savedComparison) { inputs.comparisons[ratingKey] = {...savedComparison,refresh}; savePlexComparison(ratingKey,inputs.comparisons[ratingKey]); }
      publishCatalogueUse(false);
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
    // Another TVDB candidate's saved TMDB association is kept for an offline recheck that switches to it; this scan never reads it.
    const otherTvdbAssociations = new Set(tvdbCandidates.filter(id => id !== tvdbId).map(id => tmdbFindRelationshipKey(id)));
    const relationships = Object.fromEntries(Object.entries(savedComparison?.relationships || {}).filter(([key,value]) => otherTvdbAssociations.has(key) || (value.provider === "TMDB" ? reuseTmdbRelationships : value.provider === "TVDB" ? reuseTvdbRelationships : reuseTmdbRelationships && reuseTvdbRelationships)));
    const checkedTmdbCrosswalks = new Set<string>();
    const retainedComparison = (saved: SavedPlexComparison) => ({...withLiveCrosswalkOutcomes(saved,relationships,checkedTmdbCrosswalks),refresh});
    try {
    await comparisonIssueScope.run({ratingKey,title:primary.title,tmdbId,tvdbId,tmdbSource,tvdbSource,providerEpisodes,tmdbCached:tmdbCatalogueReused,tvdbCached:tvdbCatalogueReused,tvdbAuthenticationError}, () => relationshipScope.run(relationships, async () => {
      const compared = await compareLoadedPlexShow({group,details,localMetadata,tmdbId,tvdbId,tmdbShow,tvdbResolved,tvdbSlug,providerEpisodes,malformedRecords,tmdbEpisodeAliases,cachedTvdbEpisodeImdbIds,libraryTmdbEpisodeIds,libraryTvdbEpisodeIds,libraryImdbEpisodeIds,mappings,manualInventory,autoCompoundEpisodes,config,token,traktAuth,tvdbChanges:tvdbVerifiedChanges,logger,setHeartbeat,tmdbCrosswalkScan:{startedAt,forced:!reuseTmdbRelationships,requested:requestedTmdbCrosswalks},checkedTmdbCrosswalks});
      ({tmdbSeriesMatches,tvdbSeriesMatches,cachedTvdbEpisodeImdbIds}=compared);
      recordCatalogueCandidateNames(ratingKey,"tmdb",tmdbSeriesMatches);
      recordCatalogueCandidateNames(ratingKey,"tvdb",tvdbSeriesMatches);
      // Episode-scoped failures are isolated: they neither fail the show nor make its comparison incomplete.
      reconcileEpisodeCheckIssues({ratingKey,title:primary.title,tmdbId,tvdbId},withTitleRecovery(ratingKey,compared.episodeFailures,titleRecovery.state,providerEpisodes,titleRecovery.carried),malformedRecords);
      for (const record of malformedRecords) logger.warn("plex.show.catalogue-record-unusable", { ratingKey, ...record });
      results.push({...compared.result,...(warning ? {warning} : {})});
      inputs.comparisons[ratingKey] = !cacheable && savedComparison?.complete ? retainedComparison(savedComparison) : {group,details,localMetadata,tmdbId,tvdbId,relationships,tmdbAliases:tmdbSeriesMatches.map(show=>show.id),tvdbAliases:tvdbSeriesMatches.map(show=>show.id),tmdbEpisodeAliases:[...tmdbEpisodeAliases],tvdbEpisodeImdbIds:cachedTvdbEpisodeImdbIds,complete:cacheable,refresh};
      savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
    }));
    publishCatalogueUse(true);
    resolveCoverageIssue(`comparison-failure:${ratingKey}`);
    } catch (error) {
      const cause = coverageIssueCause(error);
      setCoverageIssue({id:`comparison-failure:${ratingKey}`,operation:"comparison",scope:"show",show:{ratingKey,title:primary.title,tmdbId,tvdbId},cause,action:"Retry this comparison; run a Plex scan if saved inputs are incomplete."});
      if (savedComparison) {inputs.comparisons[ratingKey] = retainedComparison(savedComparison);savePlexComparison(ratingKey,inputs.comparisons[ratingKey]);}
      publishCatalogueUse(false);
      retainComparison(cause);
      return;
    }
    const fingerprint = plexFingerprint(group);
    const episodeFingerprint = plexEpisodeFingerprint(localMetadata);
    cachedTvdbEpisodeImdbIds = pruneEpisodeIdentityCache(cachedTvdbEpisodeImdbIds, providerEpisodes.filter((episode) => episode.source === "TVDB").flatMap((episode) => episode.providerEpisodeId ? [episode.providerEpisodeId] : []));
    if (cacheable) scanCache[ratingKey] = { ...(fingerprint ? { plexFingerprint: fingerprint } : {}), ...(episodeFingerprint ? { plexEpisodeFingerprint: episodeFingerprint } : {}), ...(tmdbId ? { tmdbId } : {}), ...(tvdbId ? { tvdbId } : {}), ...(Object.keys(cachedTvdbEpisodeImdbIds).length ? { tvdbEpisodeImdbIds: cachedTvdbEpisodeImdbIds } : {}), localTmdbEpisodeIds: [...localTmdbEpisodeIds], localTvdbEpisodeIds: [...localTvdbEpisodeIds], localImdbEpisodeIds: [...localImdbEpisodeIds], lastCheckedAt: new Date().toISOString() };
    logger.info("plex.show.complete", { ratingKey, title: primary.title || "Unknown show", plexRecords: group.records.length, tmdbId, tvdbId, plexEpisodes: localEpisodes.size, missing: results.find(show => show.ratingKey === ratingKey)?.missing.length, phaseWallMs: phaseTimings, elapsedMs: Date.now() - showStarted });
    processed += 1;
    run.progress(processed, candidates.length);
    run.resumePoint.checkpoint();
  });
  const finishedAt = new Date().toISOString();
  const coverageGroups=coverageGroupsForResults(results,manualInventory);
  const report: PlexReport = { coverageGroups, shows: results.sort((a, b) => a.title.localeCompare(b.title)), lastScan: targetRatingKey ? prior?.lastScan || finishedAt : finishedAt, startedAt: targetRatingKey ? prior?.startedAt || startedAt : startedAt, finishedAt: targetRatingKey ? prior?.finishedAt || finishedAt : finishedAt, scanCache, cacheVersion: CACHE_VERSION, autoCompoundEpisodes, coverageRevision };
  // A coverage-revision veto commits nothing and ends the run with an error status.
  run.complete({
    commit: () => {
      // A full scan saves its report and clears the Resume point in one write; a single-show scan keeps the point for the lifecycle to prune.
      if (targetRatingKey) plexSavedState.report.write(report); else plexSavedState.commitReport(report);
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
    },
    processed,
    total: candidates.length,
    finishedAt,
    details: { finishedAt, shows: candidates.length, reused: candidates.length - queue.length, refreshed: queue.length, missing: results.reduce((sum, show) => sum + show.missing.length, 0), targetRatingKey, providerMetrics: scanProviderClient.metrics(), elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt) },
  });
  });
}

/** The Plex scan status, with an Interrupted scan reconciled once by the scan run lifecycle. */
export function getPlexScanStatus(): PlexScanStatus {
  return scanRuns.readStatus(plexScanMode) || { status: "idle", processed: 0, total: 0 };
}

export function getPlexReport(): PlexReport | null {
  return plexSavedState.report.read();
}

export function clearPlexScanCache(ratingKey?: string): { cleared: number } {
  if (isPlexScanActive()) throw new Error("Wait for the current Plex scan to finish before clearing the cache.");
  const report = plexSavedState.report.read();
  // Clearing one show marks the usable shared crosswalk evidence it saved not current, so its next lookup is
  // requested again; offline rechecks still replay it and rejections stay, so no older copy is revived.
  for (const relationship of clearPlexInputs(ratingKey)) {
    const tvdbEpisodeId = tmdbCrosswalkEpisode(relationship);
    if (tvdbEpisodeId !== undefined) invalidateSharedTmdbCrosswalk(tvdbEpisodeId);
  }
  if (ratingKey) {
    const hadReportCache = Boolean(report?.scanCache?.[ratingKey]);
    if (report?.scanCache) {
      const remainingCache = { ...report.scanCache };
      delete remainingCache[ratingKey];
      plexSavedState.report.write({ ...report, scanCache: remainingCache });
    }
    const checkpoint = plexSavedState.resumePoint.read();
    const hadCheckpointCache = Boolean(checkpoint?.scanCache?.[ratingKey]);
    if (checkpoint?.scanCache) {
      const remainingCache = { ...checkpoint.scanCache };
      delete remainingCache[ratingKey];
      plexSavedState.resumePoint.write({ ...checkpoint, scanCache: remainingCache, shows: checkpoint.shows.filter((show) => show.ratingKey !== ratingKey) });
    }
    return { cleared: hadReportCache || hadCheckpointCache ? 1 : 0 };
  }
  const cleared = Object.keys(report?.scanCache || {}).length;
  plexSavedState.clearReportAndResumePoint();
  return { cleared };
}

/**
 * Starts a Plex Scan run, full or single-show. It claims the shared scan run
 * lock first; throws ScanRunConflictError, with no side effects, while any Scan
 * run is active. A single-show check that cannot use the saved cache throws
 * and releases the lock it claimed.
 */
export function startPlexScan(targetRatingKey?: string): PlexScanStatus {
  const { owner } = scanRuns.start("plex", (runOwner) => {
    if (targetRatingKey) {
      const settings = readPlexPreferences();
      if (!plexReportCacheIsUsable(getPlexReport(), CACHE_VERSION, settings.autoCompoundEpisodes !== false)) {
        throw new Error("Run a full Plex search before force-checking one show because the scan settings or cache format changed.");
      }
    }
    return runPlexScan(runOwner, targetRatingKey);
  });
  return { status: "running", processed: 0, total: 0, startedAt: owner.startedAt };
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
/**
 * Recheck one show after its catalogue override for `provider` was saved or cleared. The newly
 * preferred catalogue is compared from saved inputs only; when it was never downloaded or is too
 * old, last-good results stay with a pending comparison issue until the next scan. Never compares
 * another series' catalogue in its place, and never makes a provider request.
 */
export function requestCatalogueRecheck(identity: string, provider: CatalogueProvider): Promise<void> {
  const recheck = coverageRecheckQueue.then(() => recheckCatalogueSelection(identity, provider));
  coverageRecheckQueue = recheck.catch(() => {});
  return recheck;
}
async function recheckCatalogueSelection(identity: string, provider: CatalogueProvider) {
  const inputs=readPlexInputs(), prior=getPlexReport();
  const settings=readPlexPreferences();
  const ignored=ignoredPlexKeys(settings.ignoredShows,Date.now());
  const saved=inputs.comparisons[identity];
  // Persist the obligation first: the next scan downloads the newly preferred series.
  if (saved) {saved.refresh=patchSavedObligation({...saved.refresh},provider,PREFERRED_REQUIRED);savePlexComparison(identity,saved);}
  const pending=(cause: string) => setCoverageIssue({id:`comparison-inputs:${identity}`,operation:"comparison",scope:"show",show:{ratingKey:identity,title:saved?.group.records[0]?.title,tmdbId:saved?.tmdbId,tvdbId:saved?.tvdbId},cause,action:`Run a Plex scan to download the selected ${PROVIDER_NAME[provider]} catalogue and compare it.`});
  if (!prior || !inputs.inventory?.complete || !saved?.complete) {
    pending("Saved comparison inputs for this show are missing or incomplete, so the new catalogue selection could not be compared. Last-good results were kept.");
    return;
  }
  if (ignored.has(identity)) return;
  try {
    const compared=await recheckSavedShow(identity,saved,savedComparisonContext(inputs,settings,ignored),new Date().toISOString());
    const results=prior.shows.map(show=>show.ratingKey === identity ? compared.result : show);
    if (!results.some(show=>show.ratingKey === identity)) results.push(compared.result);
    plexSavedState.report.write({...prior,shows:results,coverageGroups:coverageGroupsForResults(results,inputs.inventory.evidence),coverageRevision:coverageState().revision});
  } catch (error) {
    pending(error instanceof PendingSavedComparison ? error.message : `The new catalogue selection could not be compared from saved inputs: ${coverageIssueCause(error)} Last-good results were kept.`);
  }
}
async function recheckCoverage(impact: CoverageImpact) {
  const inputs=readPlexInputs(), prior=getPlexReport(), revision=coverageState().revision;
  const settings=readPlexPreferences();
  const ignored=ignoredPlexKeys(settings.ignoredShows,Date.now());
  const targets=new Set<string>();
  for (const [key,input] of Object.entries(inputs.comparisons)) {
    if (impact.members.some(member=>memberInComparison(inputs,input,member))) targets.add(key);
  }
  // Persist obligations first. A failed local comparison must never consume them.
  for (const key of targets) {
    const input=inputs.comparisons[key];
    if (input) {
      const refresh={...input.refresh};
      for (const provider of PROVIDERS) if (input[PROVIDER_ID_FIELD[provider]]) patchSavedObligation(refresh,provider,PREFERRED_REQUIRED);
      input.refresh=refresh;savePlexComparison(key,input);
    }
  }
  if (!prior || !inputs.inventory?.complete) {
    const keys=targets.size ? [...targets] : [undefined];
    for (const key of keys) setCoverageIssue({id:key ? `comparison-inputs:${key}` : "comparison-inputs:initial",operation:"comparison",scope:key ? "show" : "library",...(key ? {show:{ratingKey:key}} : {}),cause:!prior ? "Saved Plex report is missing; no prior comparison is available." : "Saved Plex library inventory is missing or incomplete.",action:"Run an explicit full Plex scan to capture complete library and provider inputs."});
    if (prior) plexSavedState.report.write({...prior,coverageGroups:coverageGroupsForResults(prior.shows,inputs.inventory?.evidence || []),coverageRevision:revision});
    completeCoverageRecheck(revision);
    return;
  }
  const context=savedComparisonContext(inputs,settings,ignored);
  const results=[...prior.shows];
  // One recheck time for every 60-day usability decision.
  const now=new Date().toISOString();
  for (const key of targets) {
    if (ignored.has(key)) continue;
    const input=inputs.comparisons[key];
    try {
      if (!input?.complete) throw new Error("Saved show comparison inputs are missing or incomplete. Run a Plex scan to rebuild this show’s saved comparison.");
      const compared=await recheckSavedShow(key,input,context,now);
      const index=results.findIndex(show=>show.ratingKey===key);
      if (index>=0) results[index]=compared.result; else results.push(compared.result);
    } catch (error) {
      // A cached recheck cannot reevaluate a failed download. Preserve the
      // dependency established by that scan until its inputs can be evaluated.
      const previous = getCoverageIssue(`comparison-inputs:${key}`);
      if (!input?.complete && previous?.causedBy?.length && previous.causedBy.every(id=>getCoverageIssue(id))) continue;
      setCoverageIssue({id:`comparison-inputs:${key}`,operation:"comparison",scope:"show",show:{ratingKey:key,title:input?.group.records[0]?.title,tmdbId:input?.tmdbId,tvdbId:input?.tvdbId},cause:coverageIssueCause(error),action:"Run an explicit Plex scan to rebuild saved comparison inputs."});
    }
  }
  resolveCoverageIssue("comparison-inputs:initial");
  plexSavedState.report.write({...prior,shows:results,coverageGroups:coverageGroupsForResults(results,inputs.inventory.evidence),coverageRevision:revision});
  completeCoverageRecheck(revision);
}

type SavedComparisonContext = {
  inputs: PlexGeneratedInputs & {inventory: NonNullable<PlexGeneratedInputs["inventory"]>};
  settings: ReturnType<typeof parsePlexPreferences>;
  index: ReturnType<typeof libraryInventoryIndex>;
  mappings: ReturnType<typeof listCoverageMappings>;
};
function savedComparisonContext(inputs: PlexGeneratedInputs, settings: ReturnType<typeof parsePlexPreferences>, ignored: Set<string>): SavedComparisonContext {
  const inventory=inputs.inventory!;
  return {inputs:inputs as SavedComparisonContext["inputs"],settings,index:libraryInventoryIndex(inventory.groups,inventory.items,ignored),mappings:listCoverageMappings()};
}

/** Saved inputs cannot support an offline comparison yet; last-good results stay until the next scan. */
class PendingSavedComparison extends Error {}

/**
 * Choose the catalogues a cached recheck compares for one show through the comparison catalogue
 * resolver, from saved inputs only: the saved catalogue source never requests, and the recheck's
 * prior-selection history (each provider's recorded catalogue use and unresolved catalogue-refresh
 * issue) decides whether a preference has been tried. Throws `PendingSavedComparison` when saved
 * inputs cannot support the comparison, so last-good results stay.
 */
async function resolveSavedComparison(identity: string, saved: SavedPlexComparison, inputs: PlexGeneratedInputs, selection: ShowCatalogueSelection | undefined, now: string) {
  const history=(provider: CatalogueProvider): PriorSelection => {
    const issue=getCoverageIssue(`catalogue-refresh:${PROVIDER_NAME[provider]}:${identity}`);
    return {recordedUse:selection?.[provider].current,...(issue ? {refreshIssue:{seriesId:issue.show?.[PROVIDER_ID_FIELD[provider]],failedAt:issue.failedAt}} : {})};
  };
  const providerRequest=(provider: CatalogueProvider): ProviderRequest => ({
    candidates:selection?.[provider].candidates.map(candidate=>candidate.id) || [],preferredId:selection?.[provider].preferredId,
    refreshObligation:savedObligation(saved.refresh,provider),lookupSource:[],
  });
  const resolution=await resolveComparisonCatalogues({
    context:{kind:"cached-recheck",history:{tmdb:history("tmdb"),tvdb:history("tvdb")}},
    show:{ratingKey:identity,title:saved.group.records[0]?.title},resolvedAt:now,
    previousComparison:{tmdbId:saved.tmdbId,tvdbId:saved.tvdbId,complete:!!saved.complete},
    tmdb:providerRequest("tmdb"),tvdb:providerRequest("tvdb"),
  },{source:savedCatalogueSource(inputs,saved)});
  if (resolution.pendingWarning !== undefined) throw new PendingSavedComparison(resolution.pendingWarning);
  return {input:{...saved,tmdbId:resolution.tmdb.identity,tvdbId:resolution.tvdb.identity},resolution};
}

/**
 * Compare one show in a cached recheck from the saved inputs `resolveSavedComparison` selects, then publish the
 * catalogues it compared with the saved comparison and the catalogue uses, so reports and notices
 * never describe another catalogue. No request is made and no time or obligation is consumed.
 */
async function recheckSavedShow(identity: string, saved: SavedPlexComparison, context: SavedComparisonContext, now: string) {
  const selection=readShowCatalogueSelection(identity);
  const {input,resolution}=await resolveSavedComparison(identity,saved,context.inputs,selection,now);
  const compared=await compareSavedShow(identity,input,context);
  if (input.tmdbId !== saved.tmdbId || input.tvdbId !== saved.tvdbId)
    savePlexComparison(identity,{...readPlexInputs().comparisons[identity] || input,tmdbId:input.tmdbId,tvdbId:input.tvdbId,tmdbAliases:compared.tmdbSeriesMatches.map(show=>show.id),tvdbAliases:compared.tvdbSeriesMatches.map(show=>show.id)});
  // Catalogue issue actions (all preserved) and obligation changes (none) are not applied by a recheck.
  for (const provider of PROVIDERS) {
    const proposal=resolution[provider].use, current=selection?.[provider].current;
    if (proposal.action === "clear") clearCatalogueUse(identity,provider);
    else if (proposal.action === "set" && !sameCatalogueUse(current,proposal.use)) recordCatalogueUse(identity,provider,proposal.use);
  }
  return compared;
}
const CATALOGUE_USE_FIELDS = ["preferredId","usingId","state","preferredDownloadedAt","preferredUsableUntil","preferredFailedAt","usingDownloadedAt","usingFailedAt","derivedFrom"] as const;
function sameCatalogueUse(current: CatalogueUse | undefined, use: CatalogueUse) {
  return !!current && CATALOGUE_USE_FIELDS.every(field => current[field] === use[field]);
}

/**
 * Compare one show offline from its saved inputs and the saved catalogues of `input.tmdbId` and
 * `input.tvdbId`, which the caller has checked are usable. Plex-reported TMDB series summaries the
 * saved relationships lack are supplied from those series' saved catalogues (every Plex TVDB series
 * summary is saved by each scan). Throws when another show-level relationship is missing; episode
 * issues and resolved comparison issues are reconciled.
 */
async function compareSavedShow(key: string, input: SavedPlexComparison, {inputs,settings,index,mappings}: SavedComparisonContext) {
  const tmdb=input.tmdbId ? inputs.tmdb[String(input.tmdbId)] : undefined,tvdb=input.tvdbId ? inputs.tvdb[String(input.tvdbId)] : undefined;
  const replay={missing:new Set<string>(),recovered:new Map<string,string>()};
  const summaries=Object.fromEntries(showProviderIds(input.details.flatMap(detail=>detail.Guid || [])).tmdb.flatMap(id=>{
    const saved=inputs.tmdb[String(id)];
    return usableProviderCatalogue(saved) ? [[relationshipKey("TMDB",`${TMDB}/tv/${id}`),{provider:"TMDB" as const,value:saved.show,receivedAt:saved.downloadedAt}]] : [];
  }));
  const relationships={...summaries,...input.relationships};
  const compared=await replayScope.run(replay,()=>comparisonIssueScope.run({ratingKey:key,title:input.group.records[0]?.title,tmdbId:input.tmdbId,tvdbId:input.tvdbId},()=>relationshipScope.run(relationships,()=>compareLoadedPlexShow({
    ...input,tmdbShow:tmdb?.show || null,tvdbResolved:Boolean(tvdb),tvdbSlug:tvdb?.show.slug,
    providerEpisodes:[...(tmdb?.episodes || []),...(tvdb?.episodes || [])],malformedRecords:[...(tmdb?.malformed || []),...(tvdb?.malformed || [])],tmdbEpisodeAliases:new Set(input.tmdbEpisodeAliases || []),cachedTvdbEpisodeImdbIds:{...input.tvdbEpisodeImdbIds},
    ...index,mappings,manualInventory:inputs.inventory.evidence,autoCompoundEpisodes:settings.autoCompoundEpisodes!==false,
    config:{tmdbToken:""},token:"",traktAuth:Object.values(input.relationships).some(relationship=>relationship.provider==="Trakt") ? savedRelationshipsOnly : null,
    tvdbChanges:new Set(),logger:{info:()=>{},warn:()=>{}},setHeartbeat:()=>{},
  }))));
  if (replay.missing.size) throw new Error(`Saved provider identity relationships are incomplete (${[...replay.missing].join(", ")}).`);
  // The recheck saves only the answers it recovered after this show's own failed lookup; its other
  // replay changes stay in memory, so a later shared recovery remains adoptable offline.
  if (replay.recovered.size) {
    const savedRelationships={...input.relationships};
    for (const relationship of replay.recovered.keys()) savedRelationships[relationship]=relationships[relationship];
    savePlexComparison(key,{...input,relationships:savedRelationships});
    for (const issueId of replay.recovered.values()) resolveCoverageIssue(issueId);
  }
  reconcileEpisodeCheckIssues({ratingKey:key,title:input.group.records[0]?.title,tmdbId:input.tmdbId,tvdbId:input.tvdbId},withTitleRecovery(key,compared.episodeFailures,tvdb?.titleRecovery || {},tvdb?.episodes || [],true),[...(tmdb?.malformed || []),...(tvdb?.malformed || [])]);
  resolveCoverageIssue(`comparison-inputs:${key}`);
  resolveCoverageIssue(`comparison-failure:${key}`);
  return compared;
}
