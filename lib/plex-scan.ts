import { tmdbFeedCovers, tmdbVerificationPlan, tvdbVerificationFrom } from "@/lib/plex-catalogue-policy";
import { setCoverageIssue, resolveCoverageIssue, getCoverageIssue, coverageIssueCause, providerLookupContext, type LookupSourceStep } from "@/lib/coverage-issues";
import { isPlexScanActive } from "@/lib/plex-scan-active";
import { scanRuns, type ScanRunMode, type ScanRunOwner } from "@/lib/scan-run";
import { seriesNotFoundHistory } from "@/lib/series-not-found-history";
import { usableProviderCatalogue, readPlexInputs, savePlexComparison, savePlexInventory, saveDeferredTmdbChanges, savePendingTvdbChanges, savePendingSafeguards, saveProviderVerification, saveCompletedFullScan, clearPlexInputs, sharedTmdbCrosswalks, type PlexGeneratedInputs, type SavedPlexComparison } from "@/lib/plex-catalogues";
import { authenticateTvdb } from "@/lib/tvdb-auth";
import { recheckCoverageHealth } from "@/lib/manual-coverage-health";
import { coverageState, beginCoverageRecheck, carriedMembers, completeCoverageComparison,listCoverageMappings, saveCoverageEvidence, type CarriedMember } from "@/lib/manual-coverage";
import { memberStatus, type CoverageMember, type CoverageEvidence, type CoverageIdentity, type CoverageOutcome, type CoverageGroup } from "@/lib/manual-coverage-model";
import "server-only";

import { readPlexProviders } from "@/lib/server-config";
import { createScanLogger, type ScanLogger } from "@/lib/scan-log";
import { savedScanState, trackScanIgnores } from "@/lib/ignore-results";
import { TraktRunCredentials } from "@/lib/trakt-auth";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { episodeReference, type CompoundCoverage, type LocalCompoundEpisode } from "@/lib/compound-episodes";
import { comparePlexShow, type EpisodeCheckFailure, type EpisodeCrosswalk, type ProviderEpisode } from "@/lib/plex-comparison";
import { compoundMatchingCausesRecorded, reconcileEpisodeCheckIssues } from "@/lib/episode-check-issues";
import { lookupFailureRecord } from "@/lib/lookup-failure-record";
import { lookupDiagnostics } from "@/lib/lookup-diagnostics";
import { traktLoginDiagnostics, tvdbLoginDiagnostics } from "@/lib/provider-login-diagnostics";
import { withTitleRecovery, type TitleRecoveryState } from "@/lib/tvdb-title-recovery";
import { normaliseTmdbRecords, normaliseTvdbRecords, type MalformedCatalogueRecord, type NormalisedCatalogue } from "@/lib/catalogue-records";
import { ignoredPlexKeys } from "@/lib/ignored-shows";
import { parsePlexPreferences } from "@/lib/preferences";
import { PLEX_SCAN_WORKERS, type ProviderName } from "@/lib/provider-policy";
import { runTrackedWorkerPool, runWorkerPool, type ActiveScanWork } from "@/lib/scan-concurrency";
import { groupPlexShows, hasPlexEpisodeCoordinate, idsFromGuids, plexEpisodeFingerprint, plexFingerprint, showProviderIds, type PlexMetadata, type PlexShowGroup } from "@/lib/plex-inventory";
import { clearCatalogueUse, observeCatalogueCandidates, readShowCatalogueSelection, recordCatalogueCandidateNames, recordCatalogueUse, type CatalogueUse, type ProviderCatalogueSelection, type ShowCatalogueSelection } from "@/lib/catalogue-selection-store";
import { PROVIDER_ID_FIELD, PROVIDER_NAME, PROVIDERS, type CatalogueProvider } from "@/lib/catalogue-selection";
import { catalogueIssueIds, comparisonFailureIssueId, comparisonInputsIssueId, INITIAL_COMPARISON_INPUTS_ISSUE, inventoryDetailsIssueId, lookupFailureIssueId, plexInventoryIssueId, providerVerificationIssueId, SCAN_FAILURE_ISSUE, TVDB_AUTHENTICATION_ISSUE, type CoverageIssueId } from "@/lib/coverage-issue-ids";
import { ProgressPersistenceError, resolveComparisonCatalogues, type CataloguePayloads, type ComparisonCatalogueResolution, type ComparisonCatalogueSource, type PriorSelection, type ProviderLookupStatus, type ProviderRequest, type ShowMatchStatus } from "@/lib/comparison-catalogue-resolver";
import { downloadCatalogueSource, type DownloadCataloguePayloads } from "@/lib/download-catalogue-source";
import { droppedByRemoval, effectivePatch, patchSavedObligation, PREFERRED_REQUIRED, recordRequestedCandidate, savedObligation } from "@/lib/refresh-obligation";
import { savedCatalogueSource } from "@/lib/saved-catalogue-source";
import { ProviderResponseError, type ProviderAuth } from "@/lib/provider-client";
import { scanProviderClient } from "@/lib/scan-provider-client";
import { checkpointIsUsable, checkpointShowsWithCache, checkpointWithoutRatingKey, plexReportCacheIsUsable, PLEX_CACHE_VERSION, pruneEpisodeIdentityCache, targetedScanCarryOver, type PlexScanCacheEntry } from "@/lib/plex-scan-cache";
import { isEpisodeCoordinate, isProviderId, lookupKey, lookupProvider, lookupUrl, providerLookup, TMDB_API, TVDB_API, type ProviderLookup } from "@/lib/provider-lookup";
import { invalidateShowTmdbCrosswalks, saveRecoveredTmdbCrosswalks, tmdbCrosswalkScanRun } from "@/lib/tmdb-crosswalk-coordinator";
import type { CoverageProvider } from "@/lib/manual-coverage-model";
import type { TmdbFindEpisode } from "@/lib/plex-auto-match";
import { CrosswalkResponseError, crosswalkLookup, liveComparisonEvidence, SavedRelationshipUnavailableError, TraktLoginUnavailableError, type ComparisonEvidence, type LiveEvidenceScan, type LookupTransport, type TmdbShow, type TvdbShow } from "@/lib/comparison-evidence";
import { savedComparisonEvidence } from "@/lib/saved-comparison-evidence";
import { equivalentTmdbShowIds, ownedTmdbEpisodeMatch, tmdbShowLinksToTvdb } from "@/lib/tmdb-show-equivalence";

export type PlexScanStatus = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; startedAt?: string; finishedAt?: string; error?: string; rateLimitPaused?: boolean; rateLimitProvider?: ProviderName; currentShow?: string; currentPhase?: string; activeShows?: ActiveScanWork[]; heartbeatAt?: string };
export type PlexProviderShowMatch = { id: number; name?: string; year?: number; slug?: string };
export type PlexProviderMatches = { tmdb: PlexProviderShowMatch[]; tvdb: PlexProviderShowMatch[] };
export type PlexShow = { ratingKey: string; plexGuid?: string; plexGuids?: string[]; plexRatingKeys?: string[]; title: string; year?: number; thumb?: string; tmdbId?: number; tvdbId?: number; tvdbSlug?: string; plexEpisodes: number };
export type PlexMissingEpisode = { season: number; episode: number; title?: string; airDate?: string; tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: ("TMDB" | "TVDB")[]; reportedMissing?: ("TMDB" | "TVDB")[]; incomplete?: Partial<Record<"TMDB" | "TVDB", CoverageIdentity[]>> };
export type PlexAutoMatchMethod = "Matched via IMDb" | "Matched via Trakt" | "Matched via TMDB External ID" | "Shelfcheck Compound Match";
export type PlexAutoMatchEpisode = { id?: number; showId?: number; showSlug?: string; show: string; name?: string; season: number; episode: number; airDate?: string; url?: string };
export type PlexAutoMatch = { method: PlexAutoMatchMethod; tmdb: PlexAutoMatchEpisode; tvdb: PlexAutoMatchEpisode };
/**
 * Whether each provider's catalogue was compared, and, from scans since SHELFCHECK-27, the show's
 * match status and each provider's lookup status as the scan judged them (ADR-0006).
 */
export type PlexProviderResolution = { tmdb: boolean; tvdb: boolean; status?: ShowMatchStatus; providers?: Record<CatalogueProvider, ProviderLookupStatus> };

/** A show's provider resolution as its catalogue resolution judged it. */
function providerResolutionOf(resolution: Pick<ComparisonCatalogueResolution<CataloguePayloads>, "showStatus" | CatalogueProvider>): PlexProviderResolution {
  return { tmdb: !!resolution.tmdb.catalogue, tvdb: !!resolution.tvdb.catalogue, status: resolution.showStatus, providers: { tmdb: resolution.tmdb.status, tvdb: resolution.tvdb.status } };
}
export type PlexShowResult = PlexShow & { missing: PlexMissingEpisode[]; coverageOutcomes?: CoverageOutcome[]; providerResolution?: PlexProviderResolution; providerMatches?: PlexProviderMatches; autoMatches?: PlexAutoMatch[]; compoundCoverage?: CompoundCoverage[]; manualCoverage?: { mappingId: string; source: CoverageEvidence[] }[]; warning?: string };
type PlexCacheEntry = PlexScanCacheEntry;
export type PlexReport = { shows: PlexShowResult[]; coverageGroups?: CoverageGroup[]; lastScan: string; startedAt?: string; finishedAt?: string; scanCache?: Record<string, PlexCacheEntry>; cacheVersion?: number; autoCompoundEpisodes?: boolean; coverageRevision?: number };
type PlexCheckpoint = { shows: PlexShowResult[]; scanCache: Record<string, PlexCacheEntry>; cacheVersion: number; savedAt: string; autoCompoundEpisodes?: boolean; coverageRevision?: number };

type PlexContainer = { MediaContainer?: { size?: number; Directory?: PlexMetadata[]; Metadata?: PlexMetadata[] } };
type TmdbEpisodeFindResult = TmdbFindEpisode;

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
  onInterrupted: (status) => setCoverageIssue({id:SCAN_FAILURE_ISSUE,operation:"scan",scope:"library",cause:status.error!,action:"Start a new Plex scan to resume verification."}),
  resumePoint: {
    ...plexSavedState.resumePoint,
    resumeDetails: (checkpoint) => ({ savedAt: checkpoint.savedAt, shows: checkpoint.shows.length, cacheEntries: Object.keys(checkpoint.scanCache).length }),
    discardDetails: (checkpoint) => ({ savedAt: checkpoint.savedAt, cacheVersion: checkpoint.cacheVersion, reason: "expired-or-incompatible" }),
  },
};


/**
 * Plain transport (Plex inventory, catalogue pages and change feeds) and the catalogue download's typed
 * lookups: sent with the scan run's credentials, never answered from or saved as a comparison relationship.
 * A comparison's own lookups go through its evidence source instead.
 */
async function plexJson(path: string, url: string, token: string): Promise<PlexContainer> {
  const body = await scanProviderClient.json<PlexContainer>(`${url}${path}`, { headers: { Accept: "application/json", "X-Plex-Token": token, "X-Plex-Client-Identifier": "shelfcheck" } }, "Plex");
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

/** A TMDB typed lookup, or a plain transport path such as a catalogue season page. */
async function tmdbJson<T>(request: ProviderLookup | `/${string}`, token: string): Promise<T> {
  return scanProviderClient.json<T>(typeof request === "string" ? `${TMDB_API}${request}` : lookupUrl(request), { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }, "TMDB");
}
/** A TVDB plain transport request. */
async function tvdbJson<T>(url: string, token: string): Promise<T> {
  return scanProviderClient.json<T>(url, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
}

/**
 * The live scan run's transport for comparison evidence: each typed lookup is sent with the run's real
 * credentials, Trakt's with the run's Trakt login, which the client refreshes once if Trakt rejects it.
 */
function liveLookupTransport({tmdbToken, tvdbToken, traktAuth}: {tmdbToken: string; tvdbToken: string; traktAuth: ProviderAuth | null}): LookupTransport {
  return (lookup) => {
    const provider = lookupProvider(lookup);
    switch (provider) {
      case "TMDB": return tmdbJson(lookup, tmdbToken);
      case "TVDB": return tvdbJson(lookupUrl(lookup), tvdbToken);
      case "Trakt": return scanProviderClient.json(lookupUrl(lookup), { headers: { Accept: "application/json" } }, provider, traktAuth ?? undefined);
      case "Plex": throw new Error("Plex answers no typed lookup.");
    }
  };
}

async function requestTmdbShow(tmdbId: number, token: string): Promise<TmdbShow | null> {
  return tmdbJson<TmdbShow>(providerLookup.tmdbSeriesSummaryWithExternalIds(tmdbId), token);
}

/** TMDB's first TV result for a TVDB series, if any. */
async function requestTmdbShowForTvdb(tvdbId: number, token: string): Promise<TmdbShow | undefined> {
  return (await tmdbJson<{ tv_results?: TmdbShow[] }>(providerLookup.tmdbSeriesByTvdbSeries(tvdbId), token)).tv_results?.[0];
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

/** A failed request or interpretation within one episode's crosswalk, with the typed lookup it concerns (absent when unknown). */
type CrosswalkCause = { error: unknown; lookup?: ProviderLookup };
/** When one crosswalk has causes of several kinds, the most actionable kind names it. */
const crosswalkFailureKinds: EpisodeCheckFailure["kind"][] = ["request-failed", "unreadable-response", "relationship-unavailable", "exception"];

/**
 * A TVDB episode's Trakt crosswalk, validated against TMDB. A recorded failure of this crosswalk is
 * retried by the evidence source, its validations included. `validationFailures` are failed validation lookups.
 */
async function findEpisodeViaTrakt(evidence: ComparisonEvidence, tvdbEpisodeId: number, equivalentTmdbIds: Set<number>, tvdbShowId: number, localTmdbEpisodeIds: Set<number>) {
  const { results, cached } = await evidence.traktEpisodeSearch(tvdbEpisodeId);
  const sameShow = results.filter((result) => result.type === "episode" && Number.isFinite(result.show?.ids?.tmdb) && equivalentTmdbIds.has(result.show!.ids!.tmdb as number) && result.show?.ids?.tvdb === tvdbShowId);
  const completeMappings = sameShow.filter((result) => result.episode?.ids?.tvdb === tvdbEpisodeId && isProviderId(result.show!.ids!.tmdb) && Number.isFinite(result.episode.ids.tmdb) && isEpisodeCoordinate(result.episode.season) && isEpisodeCoordinate(result.episode.number));
  if (!completeMappings.length) return { validated: false, owned: false, validationFailed: 0, traktTmdbIds: [] as number[], validatedTmdbIds: [] as number[], validationFailures: [] as CrosswalkCause[] };
  const validations = await Promise.allSettled(completeMappings.map(async (result) => {
    const episode = result.episode!;
    const matchedTmdbShowId = result.show!.ids!.tmdb as number;
    const lookup = providerLookup.tmdbEpisodeByShowSeasonEpisode(matchedTmdbShowId, episode.season!, episode.number!);
    const details = await evidence.tmdbEpisodeDetails(lookup, { tvdbEpisodeId, tmdbEpisodeId: episode.ids!.tmdb as number, cached })
      .catch(error => { throw Object.assign(new Error("validation"), { cause: error, lookup }); });
    return details.id === episode.ids!.tmdb ? details.id as number : undefined;
  }));
  const validatedIds = validations.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  const validationFailures = validations.flatMap((result) => result.status === "rejected" ? [{ error: (result.reason as { cause?: unknown }).cause ?? result.reason, lookup: (result.reason as { lookup?: ProviderLookup }).lookup }] : []);
  return { validated: validatedIds.length > 0, owned: validatedIds.some((id) => localTmdbEpisodeIds.has(id)), ownedTmdbId: validatedIds.find((id) => localTmdbEpisodeIds.has(id)), validationFailed: validations.length - validatedIds.length, traktTmdbIds: completeMappings.map((result) => result.episode!.ids!.tmdb as number), validatedTmdbIds: validatedIds, validationFailures };
}

async function tvdbSeries(seriesId: number, token: string, cachedSlug?: string, showTitle?: string): Promise<NormalisedCatalogue & { slug?: string; name?: string }> {
  const catalogue: NormalisedCatalogue = { episodes: [], malformed: [] };
  const series = cachedSlug ? null : await tvdbJson<{ data?: { slug?: string; name?: string } }>(`${TVDB_API}/series/${seriesId}`, token);
  if (!cachedSlug && !series?.data) throw new Error("TVDB returned an incomplete series catalogue.");
  let page = 0;
  while (page < 100) {
    const body = await tvdbJson<{ data?: { episodes?: unknown[] }; links?: { next?: string | null } }>(`${TVDB_API}/series/${seriesId}/episodes/default?page=${page}`, token);
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
    const body = await tvdbJson<{ data?: { entityType?: string; recordId?: number; seriesId?: number }[]; links?: { next?: string | null } }>(`${TVDB_API}/updates?since=${timestamp}&page=${page}`, token);
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
function setProviderVerificationIssue(provider: "TMDB" | "TVDB", error: unknown, causedBy?: CoverageIssueId[]) {
  setCoverageIssue({id:providerVerificationIssueId(provider),...(causedBy ? {causedBy} : {}),operation:"provider-verification",provider,scope:"library",...providerLookupContext(error,{source:[],requested:{provider,kind:provider === "TMDB" ? "show change feed" : "series update feed"},impact:"Provider catalogue freshness could not be verified. Available saved data and successful-download timestamps were retained."})});
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
 * The Plex candidate the show's last comparison requested for a provider: the single candidate, or the
 * one the recorded use names among several. A derived catalogue is no candidate.
 */
function requestedCandidateId(prior: ProviderCatalogueSelection | undefined): number | undefined {
  const current = prior?.current;
  if (current?.state === "derived") return undefined;
  return prior?.candidates.length === 1 ? prior.candidates[0].id : current?.usingId;
}

/**
 * A safeguard is fulfilled once its change list is retrieved and each changed library show with a
 * saved TMDB catalogue holds a durable specific requirement for the compared TMDB catalogue, added
 * beside any work already open; otherwise it stays pending. The compared catalogue is named by the ID
 * it reported; when that differs from the Plex candidate requested, the candidate is recorded with it.
 */
function retainSafeguard(inputs: PlexGeneratedInputs, utcDate: string, changes: Set<number> | null, candidates: PlexShowGroup[]) {
  if (changes === null) {
    if (!inputs.pendingSafeguards[utcDate]) { inputs.pendingSafeguards[utcDate] = true; savePendingSafeguards(inputs.pendingSafeguards); }
    return;
  }
  for (const group of candidates) {
    const comparison = inputs.comparisons[group.identity];
    if (!comparison?.tmdbId || !changes.has(comparison.tmdbId) || !inputs.tmdb[String(comparison.tmdbId)]) continue;
    const change = effectivePatch(savedObligation(comparison.refresh, "tmdb"), {add: {specificIds: [comparison.tmdbId]}});
    if (!change.add) continue;
    const refresh = {...comparison.refresh};
    patchSavedObligation(refresh, "tmdb", change);
    const requestedId = requestedCandidateId(readShowCatalogueSelection(group.identity)?.tmdb);
    if (requestedId !== undefined) recordRequestedCandidate(refresh, "tmdb", comparison.tmdbId, requestedId);
    comparison.refresh = refresh;
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
  tmdbEpisodeAliases: Set<number>;
  libraryTmdbEpisodeIds: Set<number>; libraryTvdbEpisodeIds: Set<number>; libraryImdbEpisodeIds: Set<string>;
  mappings: ReturnType<typeof listCoverageMappings>; manualInventory: CoverageEvidence[]; autoCompoundEpisodes: boolean;
  logger: Pick<ScanLogger,"info"|"warn">;
  setHeartbeat: (key:string,title:string,phase:string)=>void;
  /** The comparison's provider relationships, live or saved: its only way to look up evidence. */
  evidence: ComparisonEvidence;
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

/** Resolve automatic evidence once, from the comparison's evidence source, live or saved. */
async function compareLoadedPlexShow(input: LoadedComparison) {
  const {group,details,localMetadata,tmdbId,tvdbId,tmdbShow,tvdbResolved,tvdbSlug,tmdbEpisodeAliases,libraryTmdbEpisodeIds,libraryTvdbEpisodeIds,libraryImdbEpisodeIds,mappings,manualInventory,autoCompoundEpisodes,logger,setHeartbeat,evidence}=input;
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
        // This show's recorded lookup failures, read through the read port.
        const failureRecord = lookupFailureRecord(ratingKey);
        const crosswalksAttempted = new Set<string>();
        const tvdbEpisodeOf = (id: number) => providerEpisodes.find((episode) => episode?.source === "TVDB" && episode.providerEpisodeId === id);
        const crosswalkEpisode = (id: number) => episodeReference("TVDB", { ...tvdbEpisodeOf(id), providerEpisodeId: id });
        /** One failed request or interpretation within a crosswalk: a rejected request has its own Provider Lookup cause; anything else is never relabelled as one. */
        const crosswalkCause = ({ error, lookup }: CrosswalkCause) => {
          // A replay without a saved response keeps the scan's rejected-request cause when there is one.
          const kind: EpisodeCheckFailure["kind"] = error instanceof CrosswalkResponseError ? "unreadable-response" : lookup && failureRecord.failure(lookup) ? "request-failed" : error instanceof SavedRelationshipUnavailableError ? "relationship-unavailable" : "exception";
          return kind === "request-failed" && lookup ? { kind, reason: `the ${lookupProvider(lookup)} request failed.`, requestIssue: lookupFailureIssueId(ratingKey, lookup) } : { kind, reason: coverageIssueCause(error) };
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
        const failedLookup = (crosswalk: EpisodeCrosswalk, tvdbEpisodeId: number, error: unknown) => failCrosswalk(crosswalk, tvdbEpisodeId, [{ error, lookup: crosswalkLookup(crosswalk, tvdbEpisodeId) }]);
        /** Run one crosswalk per TVDB episode; a failure, even one thrown before the lookup returns, is recorded against its episode only. */
        const settleCrosswalks = async <T,>(crosswalk: EpisodeCrosswalk, ids: number[], lookup: (tvdbEpisodeId: number) => Promise<T>) => {
          const settled = await Promise.allSettled(ids.map((tvdbEpisodeId) => { crosswalksAttempted.add(`${crosswalk}:${tvdbEpisodeId}`); return (async () => lookup(tvdbEpisodeId))(); }));
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
        // A failed crosswalk is looked up again (the evidence source decides how); one not looked up again is carried below.
        const recordedCrosswalkFailures = failureRecord.episodeCrosswalkFailures();
        if (tvdbId) {
          tmdbSeriesMatches = await evidence.tmdbSeriesByTvdb(tvdbId).catch((error) => {
            logger.warn("plex.show.tmdb-equivalent-series-unavailable", { ratingKey, tmdbShowId: tmdbShow?.id, tvdbShowId: tvdbId, error: coverageIssueCause(error) });
            return [];
          });
        }
        const knownTmdbIds = new Set(tmdbSeriesMatches.map((show) => show.id));
        const extraTmdbShows = await Promise.allSettled(plexTmdbIds.filter((id) => !knownTmdbIds.has(id) && id !== tmdbShow?.id).map((id) => evidence.tmdbSeriesSummary(id)));
        tmdbSeriesMatches = [...tmdbSeriesMatches, ...(tmdbShow ? [tmdbShow] : []), ...extraTmdbShows.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : [])].filter((show, index, matches) => matches.findIndex((candidate) => candidate.id === show.id) === index);
        // Episode-discovered aliases describe provider relationships, independently of
        // whether the current library still owns one of their episodes. A saved alias no series lookup
        // accepts names no series and is skipped.
        const savedAliasSummaries = await Promise.allSettled([...tmdbEpisodeAliases].filter(id => isProviderId(id) && !tmdbSeriesMatches.some(show => show.id === id)).map(id => evidence.tmdbSeriesSummaryWithExternalIds(id)));
        tmdbSeriesMatches.push(...savedAliasSummaries.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []));
        equivalentTmdbIds = tmdbShow?.id || tmdbId ? equivalentTmdbShowIds((tmdbShow?.id || tmdbId)!, tmdbSeriesMatches) : new Set<number>();
        const tvdbSummaries = await Promise.allSettled(plexTvdbIds.map((id) => evidence.tvdbSeriesSummary(id)));
        tvdbSeriesMatches = tvdbSummaries.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
        for (const id of plexTvdbIds) if (!tvdbSeriesMatches.some((show) => show.id === id)) tvdbSeriesMatches.push({ id });
        const coordinateMissingTvdbIds = new Set(providerEpisodes.filter((episode) => episode.source === "TVDB" && episode.season > 0 && episode.providerEpisodeId && !localEpisodes.has(`${episode.season}:${episode.episode}`)).map((episode) => episode.providerEpisodeId as number));
        const directTvdbSatisfied = new Set<number>([...coordinateMissingTvdbIds].filter((id) => libraryTvdbEpisodeIds.has(id)));
        const directImdbSatisfied = new Set<number>();
        const traktSatisfied = new Set<number>();
        const tmdbSatisfied = new Set<number>();
        const locallySatisfiedTvdbIds = new Set<number>(directTvdbSatisfied);
        for (const tvdbEpisodeId of locallySatisfiedTvdbIds) logger.info("plex.show.episode-crosswalk-decision", { ratingKey, tvdbShowId: tvdbId, tvdbEpisodeId, outcome: "reconciled-by-direct-plex-tvdb-guid" });
        if (libraryImdbEpisodeIds.size) {
          const imdbLookups = await settleCrosswalks("IMDb", [...coordinateMissingTvdbIds].filter((id) => !locallySatisfiedTvdbIds.has(id)), (tvdbEpisodeId) => evidence.tvdbEpisodeExtended(tvdbEpisodeId));
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
          if (evidence.traktAvailable && tvdbId) {
            const traktCrosswalks = await settleCrosswalks("Trakt", [...crosswalkCandidateTvdbIds], (tvdbEpisodeId) => findEpisodeViaTrakt(evidence, tvdbEpisodeId, equivalentTmdbIds, tvdbId!, libraryTmdbEpisodeIds));
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
          const crosswalks = await settleCrosswalks("TMDB", [...tmdbFallbackIds], (tvdbEpisodeId) => evidence.tmdbEpisodeByTvdb(tvdbEpisodeId));
          // A show ID no series lookup accepts is not an alias; the episode match itself still counts.
          const unknownTmdbShowIds = [...new Set(crosswalks.fulfilled.flatMap(({ value: matches }) => matches.flatMap((episode) => isProviderId(episode.show_id) && !equivalentTmdbIds.has(episode.show_id) ? [episode.show_id] : [])))];
          for (const id of unknownTmdbShowIds) tmdbEpisodeAliases.add(id);
          const aliasChecks = await Promise.allSettled(unknownTmdbShowIds.map((showId) => evidence.tmdbSeriesSummaryWithExternalIds(showId)));
          for (const aliasShow of aliasChecks.flatMap((alias) => alias.status === "fulfilled" && alias.value ? [alias.value] : [])) {
            // The episode-level /find result is already an explicit provider link.
            // Fetching the show only enriches reporting; it does not validate or veto that link.
            if (!tmdbSeriesMatches.some((show) => show.id === aliasShow.id)) tmdbSeriesMatches.push(aliasShow);
            if (tvdbId && tmdbShowLinksToTvdb(aliasShow, tvdbId)) equivalentTmdbIds.add(aliasShow.id);
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
          for (const failure of crosswalkFailures) if (failure.crosswalk === "TMDB" && failure.episode.id !== undefined) evidence.rejectTmdbEpisodeCrosswalk(failure.episode.id);
          const failedCrosswalks = crosswalks.requestFailures.length;
          if (failedCrosswalks) recordWarning(`${failedCrosswalks} TMDB TVDB-ID ${failedCrosswalks === 1 ? "lookup" : "lookups"} failed; ${failedCrosswalks === 1 ? "it is" : "they are"} requested again on the next scan.`);
          logger.info("plex.show.episode-crosswalk", { ratingKey, strategy: evidence.traktAvailable ? "trakt-validate-with-tmdb-then-find" : "tmdb-find-by-tvdb-episode-id", equivalentTmdbShowIds: [...equivalentTmdbIds], tvdbCandidates: crosswalkCandidateTvdbIds.size, traktReconciled, traktValidatedNotOwned, traktValidationFailed, traktInvalid, traktFailed, ...(traktFailureReasons.size ? { traktFailureReasons: [...traktFailureReasons].slice(0, 3) } : {}), tmdbFallback: tmdbFallbackIds.size, reconciled: locallySatisfiedTvdbIds.size, rejectedOtherShow, unmatched, failed: failedCrosswalks, crosswalkFailures: crosswalkFailures.length });
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
        const linkedTvdbSummaries = await Promise.allSettled(missingTvdbSummaries.map((id) => evidence.tvdbSeriesSummary(id)));
        tvdbSeriesMatches.push(...linkedTvdbSummaries.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []));
        const providerMatches: PlexProviderMatches = {
          tmdb: tmdbSeriesMatches.map((show) => ({ id: show.id, name: show.name, ...(show.first_air_date ? { year: Number(show.first_air_date.slice(0, 4)) } : {}) })),
          tvdb: tvdbSeriesMatches.map((show) => ({ id: show.id, name: show.name, slug: show.slug, ...(show.year && Number.isFinite(Number(show.year)) ? { year: Number(show.year) } : {}) })),
        };
        const result: PlexShowResult = { ratingKey, plexGuid: group.plexGuid, ...(plexGuids.length ? { plexGuids } : {}), plexRatingKeys: group.records.flatMap((record) => record.ratingKey ? [record.ratingKey] : []), title: primary.title || "Unknown show", year: primary.year, thumb: details.find((detail) => detail.thumb)?.thumb || primary.thumb, tmdbId, tvdbId, tvdbSlug, plexEpisodes: localEpisodes.size, providerResolution: { tmdb: Boolean(tmdbShow), tvdb: tvdbResolved }, providerMatches, coverageOutcomes, missing, ...(autoMatches.length ? { autoMatches } : {}), ...(compoundCoverage.length ? { compoundCoverage } : {}), ...(manualCoverage.length ? { manualCoverage } : {}), ...(warning ? { warning } : {}) };
  return {result,tmdbSeriesMatches,tvdbSeriesMatches,episodeFailures};
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
  // What a committed full scan covered: its saved inputs, and the shows it kept last-good results for.
  let scanInputs: PlexGeneratedInputs | undefined;
  const uncompared = new Set<string>();
  let scanIgnored: ReadonlySet<string> = new Set();
  /**
   * The carried members a committed full scan covered: none without a complete inventory, else
   * those of every show it compared. Every show of its inventory it did not ignore was compared
   * (saving its comparison) or is in `uncompared`, so a member still without a saved comparison
   * belongs to no compared show and is covered unless an uncompared show has no saved comparison.
   */
  const coveredByFullScan = () => scanInputs?.inventory?.complete
    ? coveredCarriedMembers(scanInputs, carriedMembers().filter(entry => entry.revision <= coverageRevision), uncompared, scanInputs.inventory.groups.map(group => group.identity).filter(key => !scanIgnored.has(key)))
    : [];
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
      // Only a committed full scan covers carried members, those of the shows it compared; a single-show scan covers none.
      committed: () => completeCoverageComparison(coverageRevision, targetRatingKey ? [] : coveredByFullScan()),
      succeeded: () => resolveCoverageIssue(SCAN_FAILURE_ISSUE),
      failed: (error) => setCoverageIssue({id:SCAN_FAILURE_ISSUE,operation:"inventory",provider:"Plex",scope:"library",...providerLookupContext(error,{source:[],requested:{provider:"Plex",kind:"library inventory"},impact:"Library inventory and episode coverage could not be verified. Available last-good results were retained."})}),
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
  scanIgnored = ignoredKeys;
  const shows = allShows.filter((show) => !ignoredKeys.has(show.identity));
  if (targetRatingKey && !shows.some((show) => show.identity === targetRatingKey)) throw new Error("That show is not available in the current Plex libraries.");
  const candidates = targetRatingKey ? shows.filter((show) => show.identity === targetRatingKey) : shows;
  logger.info("plex.library.refreshed", { libraries: showSections.length, plexRecords: physicalShows.length, shows: shows.length, ignored: allShows.length - shows.length, mergedRecords: physicalShows.length - allShows.length });
  let tvdbAuthenticationError: unknown;
  const token = await authenticateTvdb(scanProviderClient, config.tvdbApiKey, config.tvdbPin).then(token=>{tvdbLoginDiagnostics.resolve();return token;}).catch(error=>{
    tvdbAuthenticationError = error;
    tvdbLoginDiagnostics.raiseFailure(error);
    return "";
  });
  // The run's Trakt login: read once, and refreshed now if it is about to expire. Logged out, there is no Trakt login to fix.
  const traktAuth = await TraktRunCredentials.open().then(async credentials=>{if (credentials) await credentials.ready(); else traktLoginDiagnostics.resolve();return credentials;}).catch((error) => {
    traktLoginDiagnostics.raiseFailure(error);
    logger.warn("plex.crosswalk.trakt-unavailable", { error: coverageIssueCause(error) });
    return null;
  });
  logger.info("plex.crosswalk.providers", { traktConfigured: Boolean(traktAuth), tmdbFallback: true });
  const inputs = readPlexInputs();
  scanInputs = inputs;
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
      setProviderVerificationIssue("TVDB", error, tvdbAuthenticationError && error === tvdbAuthenticationError ? [TVDB_AUTHENTICATION_ISSUE] : undefined);
      logger.warn("plex.cache.tvdb-updates-unavailable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
  }
  // Recovery work is retained even when the feed fails, so it stays due until each refresh succeeds.
  retainVerifiedChanges(inputs, tmdbChanges ?? tmdbRecovery, tvdbChanges);
  if (tmdbChanges !== null) {
    resolveCoverageIssue(providerVerificationIssueId("TMDB"));
    fulfilOverdueSafeguards(inputs, utcDate);
  }
  if (tvdbChanges !== null) resolveCoverageIssue(providerVerificationIssueId("TVDB"));
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
  // One coordinator per scan run: its comparisons share in-flight crosswalk requests and what this scan requested.
  const liveEvidence: LiveEvidenceScan = {
    transport: liveLookupTransport({tmdbToken: config.tmdbToken, tvdbToken: token, traktAuth}),
    crosswalks: tmdbCrosswalkScanRun({store: sharedTmdbCrosswalks, now: () => new Date().toISOString(), startedAt}),
    traktLogin: Boolean(traktAuth),
    traktLoginDiagnostics,
  };
  const results: PlexShowResult[] = [];
  const scanCache: Record<string, PlexCacheEntry> = {};
  if (targetRatingKey) {
    const carried = targetedScanCarryOver({ cacheUsable, shows: prior?.shows || [], cache: prior?.scanCache || {}, currentIdentities: new Set(shows.map((show) => show.identity)), targetRatingKey });
    results.push(...carried.shows);
    Object.assign(scanCache, carried.cache);
  }
  const queue: PlexShowGroup[] = [];
  const localResponsesByRatingKey = new Map<string, PlexContainer>();
  const inventoryFailureCauses: CoverageIssueId[] = [];
  run.progress(processed, candidates.length);
  await runWorkerPool(allShows, PLEX_SCAN_WORKERS, async (group) => {
    const responses = await Promise.allSettled(group.records.map(async (record) => ({
      ratingKey: record.ratingKey,
      response: await plexJson(`/library/metadata/${record.ratingKey}/allLeaves?includeGuids=1`, config.plexUrl, config.plexToken),
    })));
    for (const [index,result] of responses.entries()) {
      // A record Plex lists without a rating key keeps the ID earlier versions saved for it, which reads "undefined".
      const issueId = plexInventoryIssueId(group.identity, group.records[index].ratingKey ?? "undefined");
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
    /** Keep the show's last-good result; `scanStatus` replaces its provider status with this scan's, which is never republished. */
    const retainComparison = (message: string, scanStatus?: Pick<PlexShowResult, "providerResolution" | "tmdbId" | "tvdbId">) => {
      uncompared.add(ratingKey);
      const previous = prior?.shows.find(show=>show.ratingKey===ratingKey);
      results.push({...(previous || {ratingKey,title:primary.title || "Unknown show",plexEpisodes:0,missing:[]}),...scanStatus,warning:message});
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
      resolveCoverageIssue(inventoryDetailsIssueId(ratingKey));
      if (!inputs.inventory?.complete) throw new Error("The library inventory is incomplete; coverage cannot be verified against unavailable items.");
      localResponses = group.records.map(record=>localResponsesByRatingKey.get(record.ratingKey || "")!);
    } catch (error) {
      const message = `Plex inventory could not be loaded: ${error instanceof Error ? error.message : String(error)} This show will be checked again next scan.`;
      const causedBy = [...inventoryFailureCauses,...(!metadataLoaded ? [inventoryDetailsIssueId(ratingKey)] : [])];
      setCoverageIssue({id:comparisonInputsIssueId(ratingKey),operation:"comparison",provider:"Plex",scope:"show",show:{ratingKey,title:primary.title},...(causedBy.length ? {causedBy} : {}),cause:message,action:"Run a Plex scan with a complete accessible library inventory."});
      if (!metadataLoaded) setCoverageIssue({id:inventoryDetailsIssueId(ratingKey),operation:"inventory",provider:"Plex",scope:"show",show:{ratingKey,title:primary.title},...providerLookupContext(error,{source:[],requested:{provider:"Plex",kind:"show metadata"},impact:"This show’s library inventory and episode coverage could not be verified. Available last-good results were retained."})});
      retainComparison(message);
      return;
    }
    // A specific requirement is dropped only when this complete observation removes its catalogue from the
    // reported candidates, saved in the observation's own transaction; on hold otherwise, it is kept.
    const plexSelection = observeCatalogueCandidates(ratingKey, showProviderIds(details.flatMap((detail) => detail.Guid || [])), metadataComplete, selections => {
      const saved = inputs.comparisons[ratingKey];
      if (!saved) return;
      const refresh = {...saved.refresh};
      for (const provider of PROVIDERS) patchSavedObligation(refresh, provider, {remove: {specificIds: droppedByRemoval(saved.refresh, provider, selections[provider].removed, selections[provider].candidates)}});
      savePlexComparison(ratingKey, {...saved, refresh});
      inputs.comparisons[ratingKey] = {...saved, refresh};
    });
    let tmdbId = plexSelection.tmdb.preferredId, tvdbId = plexSelection.tvdb.preferredId;
    const tmdbSource: LookupSourceStep[] = tmdbId ? [{provider:"Plex",kind:"TMDB show",id:tmdbId}] : tvdbId ? [{provider:"Plex",kind:"TVDB series",id:tvdbId}] : [];
    let tvdbSource: LookupSourceStep[] = tvdbId ? [{provider:"Plex",kind:"TVDB series",id:tvdbId}] : [];
    const localMetadata = localResponses.flatMap((local) => local.MediaContainer?.Metadata || []);
    const {localEpisodes,localProviderEpisodes,localTmdbEpisodeIds}=localComparisonInventory(localMetadata);
    const localTvdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.tvdbEpisodeId ? [episode.tvdbEpisodeId] : []));
    const localImdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.imdbEpisodeId ? [episode.imdbEpisodeId] : []));
    phaseTimings.plexInventoryMs = Date.now() - phaseStarted;
    let warning: string | undefined;
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
    inputs.comparisons[ratingKey] = savedComparison ? {...savedComparison,refresh} : {group, details, localMetadata, tmdbId, tvdbId, relationships:{}, tmdbAliases:[], tvdbAliases:[], complete:false, refresh};
    savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
    let tmdbCatalogueReused = false;
    const unavailableCatalogueCauses: CoverageIssueId[] = [];
    const tmdbCandidates = plexSelection.tmdb.candidates, tvdbCandidates = plexSelection.tvdb.candidates;
    const catalogueUse: Partial<Record<"tmdb" | "tvdb", CatalogueUse>> = {};
    const catalogueSource = downloadCatalogueSource({
      inputs, now: startedAt, targeted: !!targetRatingKey, tmdbChanges: tmdbCatalogueChanges, tvdbChanges: tvdbCatalogueChanges, tvdbAuthenticationError,
      requests: {
        tmdbShow: id => requestTmdbShow(id, config.tmdbToken),
        tmdbShowForTvdb: tvdbId => requestTmdbShowForTvdb(tvdbId, config.tmdbToken),
        tmdbEpisodes: show => tmdbEpisodes(show, config.tmdbToken),
        tvdbSeries: (id, showTitle) => tvdbSeries(id, token, undefined, showTitle),
        tvdbEnglishTitle: tvdbEpisodeId => scanProviderClient.json(`${TVDB_API}/episodes/${tvdbEpisodeId}/translations/eng`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB"),
      },
      show: { ratingKey, title: primary.title },
      previousComparison: savedComparison,
      titles: { autoCompoundEpisodes, localEpisodes: localProviderEpisodes },
      logger,
      seriesNotFound: seriesNotFoundHistory(),
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
    if (resolution.warnings.length) warning = resolution.warnings.join(" ");
    /**
     * A comparison made from every usable catalogue is complete for cached rechecks, even with a
     * provider that has no catalogue: that provider is still retried under its refresh obligation and
     * keeps its catalogue Coverage Issue. As before, only a single Plex ID's or derived series' saved
     * copy compared after a failed lookup keeps the last-good comparison for rechecks (ADR-0003).
     */
    const cacheable = !PROVIDERS.some(provider => resolution[provider].singleCatalogue && resolution[provider].catalogue?.origin === "saved");
    // A single-catalogue TVDB series that could not be loaded logs the show's warnings.
    if (tvdb.warning && tvdb.singleCatalogue) logger.warn("plex.show.provider-error", { ratingKey, title: primary.title || "Unknown show", error: warning });
    tmdbId = tmdb.identity; tvdbId = tvdb.identity;
    tvdbSource = tvdb.lookupSource;
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
    // This scan's provider status, recorded with whatever result the show ends with.
    const scanStatus = {providerResolution: providerResolutionOf(resolution), ...(tmdbId ? {tmdbId} : {}), ...(tvdbId ? {tvdbId} : {})};
    // Compared with whatever catalogues are usable: only an Unmatched show, or one whose series cannot be resolved yet, is not compared.
    if (resolution.outcome !== "comparable") {
      const reason = resolution.outcome === "unmatched" ? "no provider has a usable catalogue for this show" : "a provider's series could not be resolved yet";
      const cause = `Episode comparison could not be checked because ${reason}. ${savedComparison?.complete ? "Last-good comparison results were retained." : "No previous comparison results are available."}`;
      const action = resolution.outcome === "unmatched" ? "Check each provider's reported lookup failure, fix the show's Plex match if an ID is wrong or missing, then run a Plex scan." : "Run a Plex scan to resolve the provider's series.";
      setCoverageIssue({id:comparisonInputsIssueId(ratingKey),operation:"comparison",scope:"show",show:{ratingKey,title:primary.title,tmdbId,tvdbId},...(unavailableCatalogueCauses.length ? {causedBy:unavailableCatalogueCauses} : {}),cause,action});
      if (savedComparison) { inputs.comparisons[ratingKey] = {...savedComparison,refresh}; savePlexComparison(ratingKey,inputs.comparisons[ratingKey]); }
      publishCatalogueUse(false);
      retainComparison(warning || cause, scanStatus);
      return;
    }
    resolveCoverageIssue(comparisonInputsIssueId(ratingKey));
    const tmdbAliases = savedComparison?.tmdbAliases || [];
    const tvdbAliases = savedComparison?.tvdbAliases || [];
    const stale = savedComparison?.staleRelationships;
    // Retained changes count too: a deferred primary change is consumed by this scan's download.
    const reuseTmdbRelationships = !targetRatingKey && !stale?.tmdb && !tmdbAliases.some(id => tmdbCatalogueChanges.has(id) && !(id === tmdbShow?.id && tmdbCatalogueReused)) && tvdbId === savedComparison?.tvdbId;
    const reuseTvdbRelationships = !targetRatingKey && !stale?.tvdb && (tvdbVerifiedChanges === null || !tvdbAliases.some(id => tvdbVerifiedChanges.has(id)));
    const tmdbEpisodeAliases = new Set(savedComparison?.tmdbEpisodeAliases || []);
    // Another TVDB candidate's saved TMDB association is kept for a cached recheck that switches to it; this scan never reads it.
    const otherTvdbAssociations = new Set(tvdbCandidates.filter(id => id !== tvdbId && isProviderId(id)).map(id => lookupKey(providerLookup.tmdbSeriesByTvdbSeries(id))));
    const relationships = Object.fromEntries(Object.entries(savedComparison?.relationships || {}).filter(([key,value]) => otherTvdbAssociations.has(key) || (value.provider === "TMDB" ? reuseTmdbRelationships : value.provider === "TVDB" ? reuseTvdbRelationships : reuseTmdbRelationships && reuseTvdbRelationships)));
    /** Built inside the comparison's failure boundary: it reads the show's recorded failures. */
    let evidence: ComparisonEvidence | undefined;
    // Without an evidence source nothing was checked, so the last-good relationships stay as saved.
    const retainedComparison = (saved: SavedPlexComparison) => ({...saved,relationships:evidence ? evidence.changes().retained(saved.relationships) : {...saved.relationships},refresh});
    try {
      const show = {ratingKey,title:primary.title,tmdbId,tvdbId,tvdbSource,providerEpisodes,tvdbCached:tvdbCatalogueReused,tvdbAuthenticationError};
      evidence = liveComparisonEvidence({
        scan: liveEvidence, show, failures: lookupFailureRecord(ratingKey), diagnostics: lookupDiagnostics(show),
        saved: {relationships, tvdbEpisodeImdbIds: cachedTvdbEpisodeImdbIds, reuseImdbIds: Boolean(tvdbId && tvdbVerifiedChanges !== null && !tvdbVerifiedChanges.has(tvdbId))},
        forced: !reuseTmdbRelationships,
      });
      const compared = await compareLoadedPlexShow({group,details,localMetadata,tmdbId,tvdbId,tmdbShow,tvdbResolved,tvdbSlug,providerEpisodes,malformedRecords,tmdbEpisodeAliases,libraryTmdbEpisodeIds,libraryTvdbEpisodeIds,libraryImdbEpisodeIds,mappings,manualInventory,autoCompoundEpisodes,logger,setHeartbeat,evidence});
      const changes = evidence.changes();
      ({tmdbSeriesMatches,tvdbSeriesMatches}=compared);
      cachedTvdbEpisodeImdbIds = changes.tvdbEpisodeImdbIds;
      recordCatalogueCandidateNames(ratingKey,"tmdb",tmdbSeriesMatches);
      recordCatalogueCandidateNames(ratingKey,"tvdb",tvdbSeriesMatches);
      // Episode-scoped failures are isolated: they neither fail the show nor make its comparison incomplete.
      reconcileEpisodeCheckIssues({ratingKey,title:primary.title,tmdbId,tvdbId},withTitleRecovery(ratingKey,compared.episodeFailures,titleRecovery.state,providerEpisodes,titleRecovery.carried),malformedRecords);
      for (const record of malformedRecords) logger.warn("plex.show.catalogue-record-unusable", { ratingKey, ...record });
      results.push({...compared.result,providerResolution:scanStatus.providerResolution,...(warning ? {warning} : {})});
      inputs.comparisons[ratingKey] = !cacheable && savedComparison?.complete ? retainedComparison(savedComparison) : {group,details,localMetadata,tmdbId,tvdbId,relationships:changes.relationships,tmdbAliases:tmdbSeriesMatches.map(show=>show.id),tvdbAliases:tvdbSeriesMatches.map(show=>show.id),tmdbEpisodeAliases:[...tmdbEpisodeAliases],tvdbEpisodeImdbIds:cachedTvdbEpisodeImdbIds,complete:cacheable,refresh};
      savePlexComparison(ratingKey, inputs.comparisons[ratingKey]);
      publishCatalogueUse(true);
      resolveCoverageIssue(comparisonFailureIssueId(ratingKey));
    } catch (error) {
      const cause = coverageIssueCause(error);
      setCoverageIssue({id:comparisonFailureIssueId(ratingKey),operation:"comparison",scope:"show",show:{ratingKey,title:primary.title,tmdbId,tvdbId},cause,action:"Retry this comparison; run a Plex scan if saved inputs are incomplete."});
      if (savedComparison) {inputs.comparisons[ratingKey] = retainedComparison(savedComparison);savePlexComparison(ratingKey,inputs.comparisons[ratingKey]);}
      publishCatalogueUse(false);
      retainComparison(cause, scanStatus);
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
      if (inventoryComplete) resolveCoverageIssue(INITIAL_COMPARISON_INPUTS_ISSUE);
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
  // Clearing one show marks the usable shared crosswalk evidence it saved not current; a full clear removes it with
  // every other generated input, so it has no cleared show relationships to mark.
  invalidateShowTmdbCrosswalks({store: sharedTmdbCrosswalks, now: () => new Date().toISOString()}, clearPlexInputs(ratingKey));
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
function coverageGroupsForResults(results: PlexShowResult[], manualInventory: CoverageEvidence[]): CoverageGroup[] {
  return listCoverageMappings().flatMap(mapping=>{
    const outcomes=results.flatMap(show=>(show.coverageOutcomes || []).filter(outcome=>mapping.members.some(member=>member.provider===outcome.provider && member.id===outcome.id)).map(outcome=>({...outcome,showKey:show.ratingKey})));
    const missing=outcomes.filter(outcome=>outcome.status==="missing");
    if (!missing.length) return [];
    return [{mappingId:mapping.id,health:mapping.health,missing,members:mapping.members.map(member=>{
      const direct=manualInventory.some(item=>item.identities.some(identity=>identity.provider===member.provider && identity.id===member.id));
      const matched=outcomes.filter(outcome=>outcome.provider===member.provider && outcome.id===member.id);
      return {...member,...memberStatus({member,members:mapping.members,direct,matched})};
    })}];
  });
}
/** Whether a Manual Match member belongs to a saved show comparison, by provider show or catalogue episode. */
function memberInComparison(inputs: PlexGeneratedInputs, input: SavedPlexComparison, member: CoverageMember) {
  return member.provider==="TMDB"
    ? input.tmdbId===member.showId || input.tmdbAliases.includes(member.showId) || Boolean(input.tmdbEpisodeAliases?.includes(member.showId)) || Boolean(inputs.tmdb[String(input.tmdbId)]?.episodes.some(episode=>episode.providerEpisodeId===member.id))
    : input.tvdbId===member.showId || input.tvdbAliases.includes(member.showId) || Boolean(inputs.tvdb[String(input.tvdbId)]?.episodes.some(episode=>episode.providerEpisodeId===member.id));
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
  if (saved) {const refresh={...saved.refresh};patchSavedObligation(refresh,provider,PREFERRED_REQUIRED);saved.refresh=refresh;savePlexComparison(identity,saved);}
  const pending=(cause: string) => setCoverageIssue({id:comparisonInputsIssueId(identity),operation:"comparison",scope:"show",show:{ratingKey:identity,title:saved?.group.records[0]?.title,tmdbId:saved?.tmdbId,tvdbId:saved?.tvdbId},cause,action:`Run a Plex scan to download the selected ${PROVIDER_NAME[provider]} catalogue and compare it.`});
  if (!prior || !inputs.inventory?.complete || !saved?.complete) {
    pending("Saved comparison inputs for this show are missing or incomplete, so the new catalogue selection could not be compared. Last-good results were kept.");
    return;
  }
  if (ignored.has(identity)) return;
  try {
    const compared=await recheckSavedShow(identity,saved,savedComparisonContext(inputs,settings,ignored),new Date().toISOString(),prior.shows.find(show=>show.ratingKey === identity));
    const results=prior.shows.map(show=>show.ratingKey === identity ? compared.result : show);
    if (!results.some(show=>show.ratingKey === identity)) results.push(compared.result);
    plexSavedState.report.write({...prior,shows:results,coverageGroups:coverageGroupsForResults(results,inputs.inventory.evidence),coverageRevision:coverageState().revision});
  } catch (error) {
    pending(error instanceof PendingSavedComparison ? error.message : `The new catalogue selection could not be compared from saved inputs: ${coverageIssueCause(error)} Last-good results were kept.`);
  }
}
/**
 * The carried members a comparison covered: those none of whose saved show comparisons is in
 * `uncompared`. Nothing is covered while any uncompared or `current` show (the comparison's
 * library inventory and report, less ignored shows) has no saved comparison: that show could
 * hold any carried member, even one another saved comparison also matches through an alias,
 * and this comparison could not compare it. A member no saved comparison holds is otherwise
 * covered: it belongs to no show that can affect a result.
 */
function coveredCarriedMembers(inputs: PlexGeneratedInputs, carried: CarriedMember[], uncompared: ReadonlySet<string>, current: Iterable<string>) {
  // A current or uncompared show without a saved comparison could hold any carried member, even
  // one another comparison also matches (aliases overlap), so then nothing is covered.
  if ([...uncompared,...current].some(key=>!inputs.comparisons[key])) return [];
  return carried.filter(({member})=>
    !Object.entries(inputs.comparisons).some(([key,input])=>uncompared.has(key) && memberInComparison(inputs,input,member)));
}
async function recheckCoverage(impact: CoverageImpact) {
  // Every carried member is rechecked too, with this change's. Only the members whose shows
  // this recheck compares and publishes are uncarried; the rest stay carried and pending.
  const carried=carriedMembers(), revision=coverageState().revision;
  const members=[...impact.members,...carried.map(entry=>entry.member)];
  const inputs=readPlexInputs(), prior=getPlexReport();
  const settings=readPlexPreferences();
  const ignored=ignoredPlexKeys(settings.ignoredShows,Date.now());
  const targets=new Set<string>();
  for (const [key,input] of Object.entries(inputs.comparisons)) {
    if (members.some(member=>memberInComparison(inputs,input,member))) targets.add(key);
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
    for (const key of keys) setCoverageIssue({id:key ? comparisonInputsIssueId(key) : INITIAL_COMPARISON_INPUTS_ISSUE,operation:"comparison",scope:key ? "show" : "library",...(key ? {show:{ratingKey:key}} : {}),cause:!prior ? "Saved Plex report is missing; no prior comparison is available." : "Saved Plex library inventory is missing or incomplete.",action:"Run an explicit full Plex scan to capture complete library and provider inputs."});
    if (prior) plexSavedState.report.write({...prior,coverageGroups:coverageGroupsForResults(prior.shows,inputs.inventory?.evidence || []),coverageRevision:revision});
    // Nothing was compared, so every carried member stays carried.
    completeCoverageComparison(revision);
    return;
  }
  const context=savedComparisonContext(inputs,settings,ignored);
  const results=[...prior.shows];
  // One recheck time for every 60-day usability decision.
  const now=new Date().toISOString();
  const uncompared=new Set<string>();
  for (const key of targets) {
    if (ignored.has(key)) continue;
    const input=inputs.comparisons[key];
    try {
      if (!input?.complete) throw new Error("Saved show comparison inputs are missing or incomplete. Run a Plex scan to rebuild this show’s saved comparison.");
      const compared=await recheckSavedShow(key,input,context,now,prior.shows.find(show=>show.ratingKey===key));
      const index=results.findIndex(show=>show.ratingKey===key);
      if (index>=0) results[index]=compared.result; else results.push(compared.result);
    } catch (error) {
      uncompared.add(key);
      // A cached recheck cannot reevaluate a failed download. Preserve the
      // dependency established by that scan until its inputs can be evaluated.
      const previous = getCoverageIssue(comparisonInputsIssueId(key));
      if (!input?.complete && previous?.causedBy?.length && previous.causedBy.every(id=>getCoverageIssue(id))) continue;
      setCoverageIssue({id:comparisonInputsIssueId(key),operation:"comparison",scope:"show",show:{ratingKey:key,title:input?.group.records[0]?.title,tmdbId:input?.tmdbId,tvdbId:input?.tvdbId},cause:coverageIssueCause(error),action:"Run an explicit Plex scan to rebuild saved comparison inputs."});
    }
  }
  resolveCoverageIssue(INITIAL_COMPARISON_INPUTS_ISSUE);
  plexSavedState.report.write({...prior,shows:results,coverageGroups:coverageGroupsForResults(results,inputs.inventory.evidence),coverageRevision:revision});
  const current=[...inputs.inventory.groups.map(group=>group.identity),...results.map(show=>show.ratingKey)].filter(key=>!ignored.has(key));
  completeCoverageComparison(revision,coveredCarriedMembers(inputs,carried,uncompared,current));
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
async function resolveSavedComparison(identity: string, saved: SavedPlexComparison, inputs: PlexGeneratedInputs, selection: ShowCatalogueSelection | undefined, now: string, status: PlexProviderResolution["providers"]) {
  const history=(provider: CatalogueProvider): PriorSelection => {
    const issue=getCoverageIssue(catalogueIssueIds(provider,identity).refreshId);
    return {recordedUse:selection?.[provider].current,...(issue ? {refreshIssue:{seriesId:issue.show?.[PROVIDER_ID_FIELD[provider]],failedAt:issue.failedAt}} : {})};
  };
  const providerRequest=(provider: CatalogueProvider): ProviderRequest => ({
    candidates:selection?.[provider].candidates.map(candidate=>candidate.id) || [],preferredId:selection?.[provider].preferredId,
    refreshObligation:savedObligation(saved.refresh,provider),lookupSource:[],
  });
  const resolution=await resolveComparisonCatalogues({
    context:{kind:"cached-recheck",history:{tmdb:history("tmdb"),tvdb:history("tvdb")}},
    show:{ratingKey:identity,title:saved.group.records[0]?.title},resolvedAt:now,
    previousComparison:{tmdbId:saved.tmdbId,tvdbId:saved.tvdbId,complete:!!saved.complete,...(status ? {status} : {})},
    tmdb:providerRequest("tmdb"),tvdb:providerRequest("tvdb"),
  },{source:savedCatalogueSource(inputs,saved,seriesNotFoundHistory())});
  if (resolution.pendingWarning !== undefined) throw new PendingSavedComparison(resolution.pendingWarning);
  if (resolution.outcome === "unmatched") throw new PendingSavedComparison("No provider has a usable saved catalogue for this show, so it could not be rechecked from saved inputs. Last-good results were kept.");
  return {input:{...saved,tmdbId:resolution.tmdb.identity,tvdbId:resolution.tvdb.identity},resolution};
}

/**
 * Compare one show in a cached recheck from the saved inputs `resolveSavedComparison` selects, then publish the
 * catalogues it compared with the saved comparison and the catalogue uses, so reports and notices
 * never describe another catalogue. No request is made and no time or obligation is consumed.
 */
async function recheckSavedShow(identity: string, saved: SavedPlexComparison, context: SavedComparisonContext, now: string, previous: PlexShowResult | undefined) {
  const selection=readShowCatalogueSelection(identity);
  // The recheck keeps each provider's status from the last scan: it never changes a show's match status by itself.
  const {input,resolution}=await resolveSavedComparison(identity,saved,context.inputs,selection,now,previous?.providerResolution?.providers);
  const compared=await compareSavedShow(identity,input,context,{tmdb:!!resolution.tmdb.catalogue,tvdb:!!resolution.tvdb.catalogue});
  if (previous?.providerResolution?.providers) compared.result={...compared.result,providerResolution:providerResolutionOf(resolution)};
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
async function compareSavedShow(key: string, input: SavedPlexComparison, {inputs,settings,index,mappings}: SavedComparisonContext, compares: Record<CatalogueProvider, boolean> = {tmdb:true,tvdb:true}) {
  // A provider the last scan had no catalogue for is not compared, even if a saved copy appeared since.
  const tmdb=input.tmdbId && compares.tmdb ? inputs.tmdb[String(input.tmdbId)] : undefined,tvdb=input.tvdbId && compares.tvdb ? inputs.tvdb[String(input.tvdbId)] : undefined;
  const evidence=savedComparisonEvidence({ratingKey:key,comparison:input,tmdbCatalogues:inputs.tmdb,compares,shared:id=>sharedTmdbCrosswalks.read(id),failures:lookupFailureRecord(key)});
  const compared=await compareLoadedPlexShow({
    ...input,tmdbShow:tmdb?.show || null,tvdbResolved:Boolean(tvdb),tvdbSlug:tvdb?.show.slug,
    providerEpisodes:[...(tmdb?.episodes || []),...(tvdb?.episodes || [])],malformedRecords:[...(tmdb?.malformed || []),...(tvdb?.malformed || [])],tmdbEpisodeAliases:new Set(input.tmdbEpisodeAliases || []),
    ...index,mappings,manualInventory:inputs.inventory.evidence,autoCompoundEpisodes:settings.autoCompoundEpisodes!==false,
    logger:{info:()=>{},warn:()=>{}},setHeartbeat:()=>{},evidence,
  });
  const missing=evidence.missing();
  if (missing.length) throw new Error(`Saved provider identity relationships are incomplete (${missing.join(", ")}).`);
  // The recheck saves only the answers it recovered after this show's own failed lookup; its other
  // replay changes stay in memory, so a later shared recovery remains adoptable by the next cached recheck.
  saveRecoveredTmdbCrosswalks(evidence.changes().recovered,{
    save:copies=>savePlexComparison(key,{...input,relationships:{...input.relationships,...copies}}),
    resolveFailedRequest:resolveCoverageIssue,
  });
  reconcileEpisodeCheckIssues({ratingKey:key,title:input.group.records[0]?.title,tmdbId:input.tmdbId,tvdbId:input.tvdbId},withTitleRecovery(key,compared.episodeFailures,tvdb?.titleRecovery || {},tvdb?.episodes || [],true),[...(tmdb?.malformed || []),...(tvdb?.malformed || [])]);
  resolveCoverageIssue(comparisonInputsIssueId(key));
  resolveCoverageIssue(comparisonFailureIssueId(key));
  return compared;
}
