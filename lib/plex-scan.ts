import "server-only";

import { readPlexProviders } from "@/lib/server-config";
import { createScanLogger, type ScanLogger } from "@/lib/scan-log";
import { clearPlexCheckpoint, clearPlexReport, readPlexCheckpoint, readPlexReport, readPlexScanStatus, readPlexSettings, writePlexCheckpoint, writePlexReport, writePlexScanStatus } from "@/lib/sqlite";
import { validTraktCredentials } from "@/lib/trakt-auth";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { compoundTvdbCoverage, type CompoundCoverage, type LocalCompoundEpisode } from "@/lib/compound-episodes";
import { providerEpisodeIsOwned } from "@/lib/plex-episode-outcome";
import { ignoredPlexKeys } from "@/lib/ignored-shows";
import { parsePlexPreferences } from "@/lib/preferences";
import { PLEX_SCAN_WORKERS, type PlexProviderName } from "@/lib/plex-provider-policy";
import { ActiveScanTracker, runTrackedWorkerPool, runWorkerPool, type ActiveScanWork } from "@/lib/scan-concurrency";
import { groupPlexShows, hasPlexEpisodeCoordinate, idsFromGuids, plexEpisodeFingerprint, plexFingerprint, type PlexMetadata, type PlexShowGroup } from "@/lib/plex-inventory";
import { PlexProviderClient } from "@/lib/plex-provider-client";
import { checkpointIsUsable, mergeScanProgress, PLEX_CACHE_VERSION, pruneEpisodeIdentityCache, type PlexScanCacheEntry } from "@/lib/plex-scan-cache";
import { shouldSaveCheckpoint } from "@/lib/scan-cache";
import { equivalentTmdbShowIds, ownedTmdbEpisodeMatch, tmdbShowLinksToTvdb } from "@/lib/tmdb-show-equivalence";

export type PlexScanStatus = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; startedAt?: string; finishedAt?: string; error?: string; rateLimitPaused?: boolean; rateLimitProvider?: ProviderName; currentShow?: string; currentPhase?: string; activeShows?: ActiveScanWork[]; heartbeatAt?: string };
export type PlexProviderShowMatch = { id: number; name?: string; year?: number; slug?: string };
export type PlexProviderMatches = { tmdb: PlexProviderShowMatch[]; tvdb: PlexProviderShowMatch[] };
export type PlexShow = { ratingKey: string; plexGuid?: string; plexGuids?: string[]; plexRatingKeys?: string[]; title: string; year?: number; thumb?: string; tmdbId?: number; tvdbId?: number; tvdbSlug?: string; plexEpisodes: number };
export type PlexMissingEpisode = { season: number; episode: number; title?: string; airDate?: string; tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: ("TMDB" | "TVDB")[] };
export type PlexAutoMatchMethod = "Matched via IMDb" | "Matched via Trakt" | "Matched via TMDB External ID" | "Shelfcheck Compound Match";
export type PlexAutoMatchEpisode = { id?: number; showId?: number; showSlug?: string; show: string; name?: string; season: number; episode: number; airDate?: string };
export type PlexAutoMatch = { method: PlexAutoMatchMethod; tmdb: PlexAutoMatchEpisode; tvdb: PlexAutoMatchEpisode };
export type PlexProviderResolution = { tmdb: boolean; tvdb: boolean };
export type PlexShowResult = PlexShow & { missing: PlexMissingEpisode[]; providerResolution?: PlexProviderResolution; providerMatches?: PlexProviderMatches; autoMatches?: PlexAutoMatch[]; compoundCoverage?: CompoundCoverage[]; warning?: string };
type PlexCacheEntry = PlexScanCacheEntry;
export type PlexReport = { shows: PlexShowResult[]; lastScan: string; scanCache?: Record<string, PlexCacheEntry>; cacheVersion?: number; autoCompoundEpisodes?: boolean };
type PlexCheckpoint = { shows: PlexShowResult[]; scanCache: Record<string, PlexCacheEntry>; cacheVersion: number; savedAt: string; autoCompoundEpisodes?: boolean };

type PlexContainer = { MediaContainer?: { Directory?: PlexMetadata[]; Metadata?: PlexMetadata[] } };
type TmdbShow = { id: number; name?: string; first_air_date?: string | null; seasons?: { season_number: number }[]; external_ids?: { tvdb_id?: number | null } };
type TvdbShow = { id: number; name?: string; slug?: string; year?: string };
type TmdbEpisodeFindResult = { id?: number; show_id?: number };
type TraktIds = { trakt?: number | null; tmdb?: number | null; tvdb?: number | null };
type TraktEpisodeSearchResult = { type?: string; episode?: { season?: number; number?: number; ids?: TraktIds }; show?: { ids?: TraktIds } };
type TraktCredentials = { clientId: string; accessToken: string };
type ProviderEpisode = { showTitle?: string; season: number; episode: number; title?: string; airDate?: string; runtime?: number; providerEpisodeId?: number; source: "TMDB" | "TVDB" };
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

const checkedJson = <T,>(url: string, init: RequestInit, provider: ProviderName) => providerClient.json<T>(url, init, provider);

async function plexJson(path: string, url: string, token: string): Promise<PlexContainer> {
  return checkedJson<PlexContainer>(`${url}${path}`, { headers: { Accept: "application/json", "X-Plex-Token": token, "X-Plex-Client-Identifier": "shelfcheck" } }, "Plex");
}

async function tmdbJson<T>(path: string, token: string): Promise<T> {
  return checkedJson<T>(`${TMDB}${path}`, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }, "TMDB");
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

async function getTmdbShow(tmdbId: number | undefined, tvdbId: number | undefined, token: string): Promise<TmdbShow | null> {
  if (tmdbId) return tmdbJson<TmdbShow>(`/tv/${tmdbId}?append_to_response=external_ids`, token);
  if (!tvdbId) return null;
  const found = await tmdbJson<{ tv_results?: TmdbShow[] }>(`/find/${tvdbId}?external_source=tvdb_id`, token);
  const show = found.tv_results?.[0];
  return show ? tmdbJson<TmdbShow>(`/tv/${show.id}?append_to_response=external_ids`, token) : null;
}

async function tmdbEpisodes(show: TmdbShow, token: string): Promise<ProviderEpisode[]> {
  const seasons = show.seasons || [];
  const responses = await Promise.all(seasons.map((season) => tmdbJson<{ episodes?: { id?: number; season_number: number; episode_number: number; name?: string; air_date?: string | null; runtime?: number | null }[] }>(`/tv/${show.id}/season/${season.season_number}`, token)));
  return responses.flatMap((season) => (season.episodes || []).map((episode) => ({ showTitle: show.name, season: episode.season_number, episode: episode.episode_number, title: episode.name, airDate: episode.air_date || undefined, runtime: episode.runtime || undefined, providerEpisodeId: episode.id, source: "TMDB" as const })));
}

async function findTmdbEpisodeByTvdbId(tvdbEpisodeId: number, token: string): Promise<TmdbEpisodeFindResult[]> {
  const found = await tmdbJson<{ tv_episode_results?: TmdbEpisodeFindResult[] }>(`/find/${tvdbEpisodeId}?external_source=tvdb_id`, token);
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
  const results = await traktJson<TraktEpisodeSearchResult[]>(`/search/tvdb/${tvdbEpisodeId}?type=episode`, credentials);
  const sameShow = results.filter((result) => result.type === "episode" && Number.isFinite(result.show?.ids?.tmdb) && equivalentTmdbIds.has(result.show!.ids!.tmdb as number) && result.show?.ids?.tvdb === tvdbShowId);
  const completeMappings = sameShow.filter((result) => result.episode?.ids?.tvdb === tvdbEpisodeId && Number.isFinite(result.episode.ids.tmdb) && Number.isFinite(result.episode.season) && Number.isFinite(result.episode.number));
  if (!completeMappings.length) return { validated: false, owned: false, validationFailed: 0, traktTmdbIds: [] as number[], validatedTmdbIds: [] as number[] };
  const validations = await Promise.allSettled(completeMappings.map(async (result) => {
    const episode = result.episode!;
    const matchedTmdbShowId = result.show!.ids!.tmdb as number;
    const details = await tmdbJson<{ id?: number }>(`/tv/${matchedTmdbShowId}/season/${episode.season}/episode/${episode.number}`, tmdbToken);
    return details.id === episode.ids!.tmdb ? details.id : undefined;
  }));
  const validatedIds = validations.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  return { validated: validatedIds.length > 0, owned: validatedIds.some((id) => localTmdbEpisodeIds.has(id)), ownedTmdbId: validatedIds.find((id) => localTmdbEpisodeIds.has(id)), validationFailed: validations.length - validatedIds.length, traktTmdbIds: completeMappings.map((result) => result.episode!.ids!.tmdb as number), validatedTmdbIds: validatedIds };
}

async function tvdbToken(apiKey: string, pin?: string): Promise<string> {
  const response = await checkedJson<{ data?: { token?: string } | string }>(`${TVDB}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apikey: apiKey, ...(pin ? { pin } : {}) }) }, "TVDB");
  const token = typeof response.data === "string" ? response.data : response.data?.token;
  if (!token) throw new Error("TVDB login did not return a token.");
  return token;
}

async function tvdbSeries(seriesId: number, token: string, cachedSlug?: string, showTitle?: string): Promise<{ episodes: ProviderEpisode[]; slug?: string }> {
  const episodes: ProviderEpisode[] = [];
  const series = cachedSlug ? null : await checkedJson<{ data?: { slug?: string; name?: string } }>(`${TVDB}/series/${seriesId}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
  let page = 0;
  while (page < 100) {
    const body = await checkedJson<{ data?: { episodes?: { id?: number; seasonNumber?: number; number?: number; name?: string; aired?: string; runtime?: number }[] }; links?: { next?: string | null } }>(`${TVDB}/series/${seriesId}/episodes/default?page=${page}`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
    for (const episode of body.data?.episodes || []) if ((episode.seasonNumber || 0) > 0 && episode.number) {
      episodes.push({ showTitle: series?.data?.name || showTitle, season: episode.seasonNumber as number, episode: episode.number, title: episode.name, airDate: episode.aired, runtime: episode.runtime, providerEpisodeId: episode.id, source: "TVDB" });
    }
    if (!body.links?.next) break;
    page += 1;
  }
  return { episodes, slug: cachedSlug || series?.data?.slug };
}

async function tvdbEpisodeImdbIds(episodeId: number, token: string) {
  const body = await checkedJson<{ data?: { remoteIds?: { id?: string }[] } }>(`${TVDB}/episodes/${episodeId}/extended`, { headers: { Authorization: `Bearer ${token}` } }, "TVDB");
  return new Set((body.data?.remoteIds || []).flatMap((remote) => remote.id?.match(/^tt\d+$/i) ? [remote.id.toLowerCase()] : []));
}

async function tmdbChangedShows(since: string, token: string): Promise<Set<number> | null> {
  const start = new Date(since);
  if (Number.isNaN(start.getTime()) || Date.now() - start.getTime() > 14 * 86400_000) return null;
  const startDate = start.toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  const changed = new Set<number>();
  let page = 1;
  let pages = 1;
  do {
    const body = await tmdbJson<{ results?: { id?: number }[]; total_pages?: number }>(`/tv/changes?start_date=${startDate}&end_date=${endDate}&page=${page}`, token);
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
    for (const update of body.data || []) {
      if (update.seriesId) changed.add(update.seriesId);
      else if (update.entityType === "series" && update.recordId) changed.add(update.recordId);
    }
    if (!body.links?.next) { complete = true; break; }
    page += 1;
  }
  if (!complete) throw new Error("TVDB update feed exceeded the safe pagination limit.");
  return changed;
}

async function runPlexScan() {
  const startedAt = new Date().toISOString();
  const settings = parsePlexPreferences(readPlexSettings());
  const autoCompoundEpisodes = settings.autoCompoundEpisodes !== false;
  const logger = createScanLogger(settings.diagnosticsEnabled !== false, "shelfcheck-plex");
  const global = globalThis as ScanGlobal;
  global.__shelfcheckPlexLogger = logger;
  providerClient.resetMetrics();
  const activeWork = new ActiveScanTracker();
  const staleStatus = readPlexScanStatus() as PlexScanStatus | null;
  if (staleStatus?.status === "running") logger.warn("plex.scan.interrupted-detected", { previousStartedAt: staleStatus.startedAt, processed: staleStatus.processed, total: staleStatus.total, currentShow: staleStatus.currentShow, currentPhase: staleStatus.currentPhase, lastHeartbeatAt: staleStatus.heartbeatAt });
  logger.info("plex.scan.start", { startedAt, version: SHELFCHECK_VERSION, autoCompoundEpisodes });
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
  try {
    const config = await readPlexProviders();
    if (!config) throw new Error("Configure Plex, TMDB, and TVDB credentials before scanning.");
    const sections = await plexJson("/library/sections", config.plexUrl, config.plexToken);
    const showSections = (sections.MediaContainer?.Directory || []).filter((section) => section.type === "show" && section.key);
    const libraries = await Promise.all(showSections.map((section) => plexJson(`/library/sections/${section.key}/all?type=2&includeGuids=1`, config.plexUrl, config.plexToken)));
    const physicalShows = libraries.flatMap((library) => library.MediaContainer?.Metadata || []);
    const allShows = groupPlexShows(physicalShows);
    const ignoredKeys = ignoredPlexKeys(settings.ignoredShows);
    const shows = allShows.filter((show) => !ignoredKeys.has(show.identity));
    logger.info("plex.library.refreshed", { libraries: showSections.length, plexRecords: physicalShows.length, shows: shows.length, ignored: allShows.length - shows.length, mergedRecords: physicalShows.length - allShows.length });
    const token = await tvdbToken(config.tvdbApiKey, config.tvdbPin);
    const traktCredentials = await validTraktCredentials().catch((error) => {
      logger.warn("plex.crosswalk.trakt-unavailable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    logger.info("plex.crosswalk.providers", { traktConfigured: Boolean(traktCredentials), tmdbFallback: true });
    const prior = getPlexReport();
    const rawCheckpoint = readPlexCheckpoint() as PlexCheckpoint | null;
    const checkpoint = checkpointIsUsable(rawCheckpoint, autoCompoundEpisodes) ? rawCheckpoint : null;
    if (checkpoint) logger.info("plex.checkpoint.resume", { savedAt: checkpoint.savedAt, shows: checkpoint.shows.length, cacheEntries: Object.keys(checkpoint.scanCache).length });
    else if (rawCheckpoint) { logger.warn("plex.checkpoint.discarded", { savedAt: rawCheckpoint.savedAt, cacheVersion: rawCheckpoint.cacheVersion, reason: "expired-or-incompatible" }); clearPlexCheckpoint(); }
    const cacheUsable = prior?.cacheVersion === CACHE_VERSION && prior.autoCompoundEpisodes === autoCompoundEpisodes && Boolean(prior.scanCache);
    let tmdbChanges: Set<number> | null = null;
    let tvdbChanges: Set<number> | null = null;
    if (cacheUsable && prior) {
      tmdbChanges = await tmdbChangedShows(prior.lastScan, config.tmdbToken).catch((error) => {
        logger.warn("plex.cache.tmdb-changes-unavailable", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      tvdbChanges = await tvdbChangedShows(prior.lastScan, token).catch((error) => {
        logger.warn("plex.cache.tvdb-updates-unavailable", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
    }
    const results: PlexShowResult[] = [];
    const scanCache: Record<string, PlexCacheEntry> = {};
    const libraryTmdbEpisodeIds = new Set<number>();
    const libraryTvdbEpisodeIds = new Set<number>();
    const libraryImdbEpisodeIds = new Set<string>();
    const previousShows = new Map((prior?.shows || []).map((show) => [show.ratingKey, show]));
    for (const show of checkpoint?.shows || []) previousShows.set(show.ratingKey, show);
    const resumeKeys = new Set(Object.keys(checkpoint?.scanCache || {}));
    const queue: PlexShowGroup[] = [];
    const localResponsesByRatingKey = new Map<string, PlexContainer>();
    currentTotal = shows.length;
    await runWorkerPool(shows, PLEX_SCAN_WORKERS, async (group) => {
      const responses = await Promise.all(group.records.map(async (record) => ({
        ratingKey: record.ratingKey,
        response: await plexJson(`/library/metadata/${record.ratingKey}/allLeaves?includeGuids=1`, config.plexUrl, config.plexToken),
      })));
      for (const { ratingKey, response } of responses) if (ratingKey) localResponsesByRatingKey.set(ratingKey, response);
    });
    for (const group of shows) {
      const cached = checkpoint?.scanCache[group.identity] || prior?.scanCache?.[group.identity];
      const previous = previousShows.get(group.identity);
      const summaryIds = idsFromGuids(group.records.flatMap((record) => record.Guid || []));
      const tmdbId = summaryIds.tmdbId || cached?.tmdbId;
      const tvdbId = summaryIds.tvdbId || cached?.tvdbId;
      const fingerprint = plexFingerprint(group);
      const episodeMetadata = group.records.flatMap((record) => localResponsesByRatingKey.get(record.ratingKey || "")?.MediaContainer?.Metadata || []);
      const episodeFingerprint = plexEpisodeFingerprint(episodeMetadata);
      const plexUnchanged = Boolean(fingerprint && fingerprint === cached?.plexFingerprint && episodeFingerprint && episodeFingerprint === cached?.plexEpisodeFingerprint);
      const idsUnchanged = (!summaryIds.tmdbId || summaryIds.tmdbId === cached?.tmdbId) && (!summaryIds.tvdbId || summaryIds.tvdbId === cached?.tvdbId);
      const providersUnchanged = tmdbChanges !== null && tvdbChanges !== null && (!tmdbId || !tmdbChanges.has(tmdbId)) && (!tvdbId || !tvdbChanges.has(tvdbId));
      const tvdbLinkUsable = !tvdbId || Boolean(previous?.tvdbSlug);
      const resumed = resumeKeys.has(group.identity) && Boolean(cached && previous && plexUnchanged && idsUnchanged && tvdbLinkUsable);
      const reused = resumed || Boolean(cacheUsable && cached && previous && plexUnchanged && idsUnchanged && providersUnchanged && tvdbLinkUsable);
      const reasons = reused ? [resumed ? "interrupted-scan-checkpoint" : "unchanged"] : [!cached ? "no-cache" : null, !previous ? "no-prior-result" : null, !plexUnchanged ? "plex-or-episodes-changed" : null, !idsUnchanged ? "provider-ids-changed" : null, !providersUnchanged ? "tmdb-or-tvdb-changed" : null, !tvdbLinkUsable ? "missing-tvdb-slug" : null, !cacheUsable && !resumed ? "cache-incompatible" : null].filter(Boolean);
      logger.info("plex.cache.decision", { ratingKey: group.identity, title: group.records[0]?.title, decision: reused ? "reuse" : "refresh", reasons });
      if (reused && cached && previous) {
        const primary = group.records[0];
        results.push({ ...previous, plexGuid: group.plexGuid, plexRatingKeys: group.records.flatMap((record) => record.ratingKey ? [record.ratingKey] : []), title: primary.title || previous.title, year: primary.year || previous.year, thumb: primary.thumb || previous.thumb });
        scanCache[group.identity] = cached;
        for (const id of cached.localTmdbEpisodeIds || []) libraryTmdbEpisodeIds.add(id);
        for (const id of cached.localTvdbEpisodeIds || []) libraryTvdbEpisodeIds.add(id);
        for (const id of cached.localImdbEpisodeIds || []) libraryImdbEpisodeIds.add(id);
        processed += 1;
      } else queue.push(group);
    }
    logger.info("plex.scan.plan", { total: shows.length, reused: processed, refreshing: queue.length, tmdbChanged: tmdbChanges?.size, tvdbChanged: tvdbChanges?.size, cacheUsable });
    updateStatus({ status: "running", processed, total: shows.length });
    for (const response of localResponsesByRatingKey.values()) for (const episode of response.MediaContainer?.Metadata || []) {
      const ids = idsFromGuids(episode.Guid);
      if (ids.tmdbId) libraryTmdbEpisodeIds.add(ids.tmdbId);
      if (ids.tvdbId) libraryTvdbEpisodeIds.add(ids.tvdbId);
      if (ids.imdbId) libraryImdbEpisodeIds.add(ids.imdbId);
    }
    logger.info("plex.library.episode-identities", { tmdb: libraryTmdbEpisodeIds.size, tvdb: libraryTvdbEpisodeIds.size, imdb: libraryImdbEpisodeIds.size });
    let lastCheckpointProcessed = processed;
    let lastCheckpointAt = Date.now();
    await runTrackedWorkerPool(queue, PLEX_SCAN_WORKERS, activeWork, (group) => ({ key: group.identity, show: group.records[0]?.title || "Unknown show" }), async (group) => {
      const primary = group.records[0];
      const ratingKey = group.identity;
      const priorCacheEntry = checkpoint?.scanCache[ratingKey] || prior?.scanCache?.[ratingKey];
      let cachedTvdbEpisodeImdbIds = { ...(priorCacheEntry?.tvdbEpisodeImdbIds || {}) };
      const showStarted = Date.now();
      const phaseTimings: Record<string, number> = {};
      logger.info("plex.show.start", { ratingKey, title: primary.title || "Unknown show", plexRecords: group.records.length });
      setHeartbeat(ratingKey, primary.title || "Unknown show", "plex-inventory");
      let phaseStarted = Date.now();
      const details = await Promise.all(group.records.map(async (record) => (await plexJson(`/library/metadata/${record.ratingKey}?includeGuids=1`, config.plexUrl, config.plexToken)).MediaContainer?.Metadata?.[0] || record));
      const plexGuids = [...new Set(details.flatMap((detail) => detail.guid?.startsWith("plex://show/") ? [detail.guid] : []))];
      const plexTmdbIds = [...new Set(details.flatMap((detail) => { const id = idsFromGuids(detail.Guid).tmdbId; return id ? [id] : []; }))];
      const plexTvdbIds = [...new Set(details.flatMap((detail) => { const id = idsFromGuids(detail.Guid).tvdbId; return id ? [id] : []; }))];
      let { tmdbId, tvdbId } = idsFromGuids(details.flatMap((detail) => detail.Guid || []));
      const localResponses = await Promise.all(group.records.map((record) => localResponsesByRatingKey.get(record.ratingKey || "") || plexJson(`/library/metadata/${record.ratingKey}/allLeaves?includeGuids=1`, config.plexUrl, config.plexToken)));
      const localMetadata = localResponses.flatMap((local) => local.MediaContainer?.Metadata || []);
      const localEpisodes = new Set(localMetadata.filter(hasPlexEpisodeCoordinate).map((episode) => `${episode.parentIndex}:${episode.index}`));
      const localProviderEpisodes: LocalCompoundEpisode[] = localMetadata.flatMap((episode) => {
        if (!hasPlexEpisodeCoordinate(episode)) return [];
        const ids = idsFromGuids(episode.Guid);
        return [{ season: episode.parentIndex as number, episode: episode.index, title: episode.title, runtime: episode.duration ? episode.duration / 60_000 : undefined, tmdbEpisodeId: ids.tmdbId, tvdbEpisodeId: ids.tvdbId, imdbEpisodeId: ids.imdbId }];
      });
      const localTmdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.tmdbEpisodeId ? [episode.tmdbEpisodeId] : []));
      const localTvdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.tvdbEpisodeId ? [episode.tvdbEpisodeId] : []));
      const localImdbEpisodeIds = new Set(localProviderEpisodes.flatMap((episode) => episode.imdbEpisodeId ? [episode.imdbEpisodeId] : []));
      phaseTimings.plexInventoryMs = Date.now() - phaseStarted;
      let warning: string | undefined;
      const providerEpisodes: ProviderEpisode[] = [];
      const autoMatchEvidence = new Map<number, { method: PlexAutoMatchMethod; tmdbEpisodeId: number }>();
      let tmdbShow: TmdbShow | null = null;
      let tvdbResolved = false;
      let equivalentTmdbIds = new Set<number>();
      let tmdbSeriesMatches: TmdbShow[] = [];
      let tvdbSeriesMatches: TvdbShow[] = [];
      let tvdbSlug: string | undefined;
      try {
        setHeartbeat(ratingKey, primary.title || "Unknown show", "tmdb-show-and-seasons");
        phaseStarted = Date.now();
        tmdbShow = await getTmdbShow(tmdbId, tvdbId, config.tmdbToken);
        if (tmdbShow) {
          tmdbId = tmdbShow.id;
          tvdbId ||= tmdbShow.external_ids?.tvdb_id || undefined;
          equivalentTmdbIds = equivalentTmdbShowIds(tmdbShow.id);
          providerEpisodes.push(...await tmdbEpisodes(tmdbShow, config.tmdbToken));
        }
        phaseTimings.tmdbMs = Date.now() - phaseStarted;
        if (tvdbId) {
          setHeartbeat(ratingKey, primary.title || "Unknown show", "tvdb-series-and-episodes");
          phaseStarted = Date.now();
          const cachedSlug = tvdbChanges !== null && !tvdbChanges.has(tvdbId) ? previousShows.get(ratingKey)?.tvdbSlug : undefined;
          const tvdb = await tvdbSeries(tvdbId, token, cachedSlug, primary.title || "Unknown show");
          tvdbResolved = true;
          tvdbSlug = tvdb.slug;
          providerEpisodes.push(...tvdb.episodes);
          phaseTimings.tvdbMs = Date.now() - phaseStarted;
        }
        if (!tmdbId && !tvdbId) warning = "No TMDB or TVDB ID was exposed by Plex.";
      } catch (error) {
        warning = error instanceof Error ? error.message : "Provider lookup failed.";
        logger.warn("plex.show.provider-error", { ratingKey, title: primary.title || "Unknown show", error: warning });
      }
      if (tvdbId) {
        tmdbSeriesMatches = await tmdbShowsForTvdbId(tvdbId, config.tmdbToken).catch((error) => {
          logger.warn("plex.show.tmdb-equivalent-series-unavailable", { ratingKey, tmdbShowId: tmdbShow?.id, tvdbShowId: tvdbId, error: error instanceof Error ? error.message : String(error) });
          return [];
        });
      }
      const knownTmdbIds = new Set(tmdbSeriesMatches.map((show) => show.id));
      const extraTmdbShows = await Promise.allSettled(plexTmdbIds.filter((id) => !knownTmdbIds.has(id) && id !== tmdbShow?.id).map((id) => tmdbJson<TmdbShow>(`/tv/${id}`, config.tmdbToken)));
      tmdbSeriesMatches = [...tmdbSeriesMatches, ...(tmdbShow ? [tmdbShow] : []), ...extraTmdbShows.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])].filter((show, index, matches) => matches.findIndex((candidate) => candidate.id === show.id) === index);
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
      const compoundSatisfied = new Set<number>();
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
        }
        const crosswalks = await Promise.allSettled([...tmdbFallbackIds].map(async (tvdbEpisodeId) => ({ tvdbEpisodeId, matches: await findTmdbEpisodeByTvdbId(tvdbEpisodeId, config.tmdbToken) })));
        const unknownTmdbShowIds = [...new Set(crosswalks.flatMap((result) => result.status === "fulfilled" ? result.value.matches.flatMap((episode) => episode.show_id && !equivalentTmdbIds.has(episode.show_id) ? [episode.show_id] : []) : []))];
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
            locallySatisfiedTvdbIds.add(result.value.tvdbEpisodeId); tmdbSatisfied.add(result.value.tvdbEpisodeId); autoMatchEvidence.set(result.value.tvdbEpisodeId, { method: "Matched via TMDB External ID", tmdbEpisodeId: ownedTmdbMatch.id }); crosswalkDecisions.set(result.value.tvdbEpisodeId, "reconciled-by-tmdb-find");
            // No parent-series agreement or secondary lookup is required: Plex owns
            // the exact TMDB episode returned for this TVDB episode external ID.
          }
          else if (result.value.matches.length && !sameShowMatches.length) rejectedOtherShow += 1;
          else unmatched += 1;
          if (!crosswalkDecisions.has(result.value.tvdbEpisodeId)) crosswalkDecisions.set(result.value.tvdbEpisodeId, result.value.matches.length && !sameShowMatches.length ? "tmdb-cross-show-rejected" : "reported-missing");
        }
        const failedCrosswalks = crosswalks.filter((result) => result.status === "rejected").length;
        if (failedCrosswalks) warning = `${failedCrosswalks} TMDB TVDB-ID ${failedCrosswalks === 1 ? "lookup" : "lookups"} failed; this show will be checked again next scan.`;
        logger.info("plex.show.episode-crosswalk", { ratingKey, strategy: traktCredentials ? "trakt-validate-with-tmdb-then-find" : "tmdb-find-by-tvdb-episode-id", equivalentTmdbShowIds: [...equivalentTmdbIds], tvdbCandidates: crosswalkCandidateTvdbIds.size, traktReconciled, traktValidatedNotOwned, traktValidationFailed, traktInvalid, traktFailed, ...(traktFailureReasons.size ? { traktFailureReasons: [...traktFailureReasons].slice(0, 3) } : {}), tmdbFallback: tmdbFallbackIds.size, reconciled: locallySatisfiedTvdbIds.size, rejectedOtherShow, unmatched, failed: failedCrosswalks });
        for (const tvdbEpisodeId of crosswalkCandidateTvdbIds) logger.info("plex.show.episode-crosswalk-decision", { ratingKey, tmdbShowId: tmdbShow.id, tvdbShowId: tvdbId, tvdbEpisodeId, ...crosswalkDetails.get(tvdbEpisodeId), outcome: crosswalkDecisions.get(tvdbEpisodeId) || "lookup-failed" });
        phaseTimings.crosswalkMs = Date.now() - crosswalkStarted;
      }
      const compoundCoverage: CompoundCoverage[] = [];
      if (autoCompoundEpisodes && tmdbShow && coordinateMissingTvdbIds.size && localTmdbEpisodeIds.size) {
        const compoundCovered = compoundTvdbCoverage(providerEpisodes, localProviderEpisodes);
        let reconciled = 0;
        for (const coverage of compoundCovered) if (coordinateMissingTvdbIds.has(coverage.tvdbEpisodeId) && !locallySatisfiedTvdbIds.has(coverage.tvdbEpisodeId)) {
          locallySatisfiedTvdbIds.add(coverage.tvdbEpisodeId);
          compoundSatisfied.add(coverage.tvdbEpisodeId);
          compoundCoverage.push(coverage);
          autoMatchEvidence.set(coverage.tvdbEpisodeId, { method: "Shelfcheck Compound Match", tmdbEpisodeId: coverage.tmdbEpisodeId });
          reconciled += 1;
          logger.info("plex.show.episode-crosswalk-decision", { ratingKey, tmdbShowId: tmdbShow.id, tvdbShowId: tvdbId, tvdbEpisodeId: coverage.tvdbEpisodeId, plexSeason: coverage.plexSeason, plexEpisode: coverage.plexEpisode, tmdbEpisodeId: coverage.tmdbEpisodeId, evidence: coverage.evidence, outcome: "reconciled-by-auto-compound" });
        }
        logger.info("plex.show.auto-compound", { ratingKey, enabled: true, candidates: compoundCovered.length, reconciled });
      }
      const missingMap = new Map<string, PlexMissingEpisode>();
      for (const episode of providerEpisodes) {
        if (episode.season === 0) continue;
        const key = `${episode.season}:${episode.episode}`;
        if (localEpisodes.has(key)) continue;
        if (providerEpisodeIsOwned({ source: episode.source, providerEpisodeId: episode.providerEpisodeId, localTmdbEpisodeIds: libraryTmdbEpisodeIds, tvdbEvidence: { directTvdb: Boolean(episode.providerEpisodeId && directTvdbSatisfied.has(episode.providerEpisodeId)), directImdb: Boolean(episode.providerEpisodeId && directImdbSatisfied.has(episode.providerEpisodeId)), trakt: Boolean(episode.providerEpisodeId && traktSatisfied.has(episode.providerEpisodeId)), tmdb: Boolean(episode.providerEpisodeId && tmdbSatisfied.has(episode.providerEpisodeId)), compound: Boolean(episode.providerEpisodeId && compoundSatisfied.has(episode.providerEpisodeId)) }, autoCompoundEpisodes })) continue;
        const existing = missingMap.get(key);
        if (existing) {
          if (!existing.sources.includes(episode.source)) existing.sources.push(episode.source);
          existing.title ||= episode.title; existing.airDate ||= episode.airDate;
          if (episode.source === "TMDB") existing.tmdbEpisodeId ||= episode.providerEpisodeId;
          if (episode.source === "TVDB") existing.tvdbEpisodeId ||= episode.providerEpisodeId;
        } else missingMap.set(key, { season: episode.season, episode: episode.episode, title: episode.title, airDate: episode.airDate, ...(episode.source === "TMDB" ? { tmdbEpisodeId: episode.providerEpisodeId } : { tvdbEpisodeId: episode.providerEpisodeId }), sources: [episode.source] });
      }
      const autoMatches: PlexAutoMatch[] = [...autoMatchEvidence].flatMap(([tvdbEpisodeId, evidence]) => {
        const tvdbEpisode = providerEpisodes.find((episode) => episode.source === "TVDB" && episode.providerEpisodeId === tvdbEpisodeId);
        if (!tvdbEpisode) return [];
        const tmdbEpisode = providerEpisodes.find((episode) => episode.source === "TMDB" && episode.providerEpisodeId === evidence.tmdbEpisodeId);
        const localTmdbEpisode = localProviderEpisodes.find((episode) => episode.tmdbEpisodeId === evidence.tmdbEpisodeId);
        return [{
          method: evidence.method,
          tmdb: { id: evidence.tmdbEpisodeId, showId: tmdbShow?.id, show: tmdbEpisode?.showTitle || primary.title || "Unknown show", name: tmdbEpisode?.title || localTmdbEpisode?.title, season: tmdbEpisode?.season ?? localTmdbEpisode?.season ?? tvdbEpisode.season, episode: tmdbEpisode?.episode ?? localTmdbEpisode?.episode ?? tvdbEpisode.episode, airDate: tmdbEpisode?.airDate },
          tvdb: { id: tvdbEpisodeId, showSlug: tvdbSlug, show: tvdbEpisode.showTitle || primary.title || "Unknown show", name: tvdbEpisode.title, season: tvdbEpisode.season, episode: tvdbEpisode.episode, airDate: tvdbEpisode.airDate },
        }];
      }).sort((a, b) => a.tvdb.season - b.tvdb.season || a.tvdb.episode - b.tvdb.episode);
      const linkedTvdbIds = [...new Set(tmdbSeriesMatches.flatMap((show) => show.external_ids?.tvdb_id ? [show.external_ids.tvdb_id] : []))];
      const missingTvdbSummaries = linkedTvdbIds.filter((id) => !tvdbSeriesMatches.some((show) => show.id === id));
      const linkedTvdbSummaries = await Promise.allSettled(missingTvdbSummaries.map((id) => tvdbShow(id, token)));
      tvdbSeriesMatches.push(...linkedTvdbSummaries.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []));
      const providerMatches: PlexProviderMatches = {
        tmdb: tmdbSeriesMatches.map((show) => ({ id: show.id, name: show.name, ...(show.first_air_date ? { year: Number(show.first_air_date.slice(0, 4)) } : {}) })),
        tvdb: tvdbSeriesMatches.map((show) => ({ id: show.id, name: show.name, slug: show.slug, ...(show.year && Number.isFinite(Number(show.year)) ? { year: Number(show.year) } : {}) })),
      };
      results.push({ ratingKey, plexGuid: group.plexGuid, ...(plexGuids.length ? { plexGuids } : {}), plexRatingKeys: group.records.flatMap((record) => record.ratingKey ? [record.ratingKey] : []), title: primary.title || "Unknown show", year: primary.year, thumb: details.find((detail) => detail.thumb)?.thumb || primary.thumb, tmdbId, tvdbId, tvdbSlug, plexEpisodes: localEpisodes.size, providerResolution: { tmdb: Boolean(tmdbShow), tvdb: tvdbResolved }, providerMatches, missing: [...missingMap.values()].sort((a, b) => a.season - b.season || a.episode - b.episode), ...(autoMatches.length ? { autoMatches } : {}), ...(compoundCoverage.length ? { compoundCoverage } : {}), ...(warning ? { warning } : {}) });
      const fingerprint = plexFingerprint(group);
      const episodeFingerprint = plexEpisodeFingerprint(localMetadata);
      cachedTvdbEpisodeImdbIds = pruneEpisodeIdentityCache(cachedTvdbEpisodeImdbIds, providerEpisodes.filter((episode) => episode.source === "TVDB").flatMap((episode) => episode.providerEpisodeId ? [episode.providerEpisodeId] : []));
      if (!warning) scanCache[ratingKey] = { ...(fingerprint ? { plexFingerprint: fingerprint } : {}), ...(episodeFingerprint ? { plexEpisodeFingerprint: episodeFingerprint } : {}), ...(tmdbId ? { tmdbId } : {}), ...(tvdbId ? { tvdbId } : {}), ...(Object.keys(cachedTvdbEpisodeImdbIds).length ? { tvdbEpisodeImdbIds: cachedTvdbEpisodeImdbIds } : {}), localTmdbEpisodeIds: [...localTmdbEpisodeIds], localTvdbEpisodeIds: [...localTvdbEpisodeIds], localImdbEpisodeIds: [...localImdbEpisodeIds], lastCheckedAt: new Date().toISOString() };
      logger.info("plex.show.complete", { ratingKey, title: primary.title || "Unknown show", plexRecords: group.records.length, tmdbId, tvdbId, plexEpisodes: localEpisodes.size, missing: missingMap.size, phaseWallMs: phaseTimings, elapsedMs: Date.now() - showStarted });
      processed += 1;
      updateStatus({ status: "running", processed, total: shows.length });
      if (shouldSaveCheckpoint(processed, lastCheckpointProcessed, Date.now(), lastCheckpointAt)) {
        const savedAt = new Date().toISOString();
        writePlexCheckpoint({ shows: results, scanCache, cacheVersion: CACHE_VERSION, savedAt, autoCompoundEpisodes });
        logger.info("plex.checkpoint.saved", { savedAt, processed, total: shows.length, shows: results.length, cacheEntries: Object.keys(scanCache).length });
        lastCheckpointProcessed = processed;
        lastCheckpointAt = Date.now();
      }
    });
    const report: PlexReport = { shows: results.sort((a, b) => a.title.localeCompare(b.title)), lastScan: new Date().toISOString(), scanCache, cacheVersion: CACHE_VERSION, autoCompoundEpisodes };
    writePlexReport(report);
    clearPlexCheckpoint();
    replaceStatus({ status: "completed", processed, total: shows.length, startedAt, finishedAt: report.lastScan });
    logger.info("plex.scan.complete", { finishedAt: report.lastScan, shows: shows.length, reused: shows.length - queue.length, refreshed: queue.length, missing: results.reduce((sum, show) => sum + show.missing.length, 0), providerMetrics: providerClient.metrics(), elapsedMs: Date.parse(report.lastScan) - Date.parse(startedAt) });
  } catch (error) {
    updateStatus({ status: "error", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "The Plex scan failed.", rateLimitPaused: false, rateLimitProvider: undefined });
    logger.error("plex.scan.error", { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, providerMetrics: providerClient.metrics() });
  }
  clearInterval(heartbeatTimer);
  global.__shelfcheckPlexLogger = undefined;
}

export function getPlexScanStatus(): PlexScanStatus {
  const status = readPlexScanStatus() as PlexScanStatus | null;
  if (status?.status === "running" && !(globalThis as ScanGlobal).__shelfcheckPlexScan) {
    const lastActivity = Date.parse(status.heartbeatAt || status.startedAt || "");
    if (Number.isFinite(lastActivity) && Date.now() - lastActivity > 90_000) {
      const interrupted: PlexScanStatus = { ...status, status: "error", finishedAt: new Date().toISOString(), error: `The previous Plex scan was interrupted during ${status.currentPhase || "processing"}${status.currentShow ? ` (${status.currentShow})` : ""}. Start a new scan to resume from its checkpoint.` };
      writePlexScanStatus(interrupted);
      return interrupted;
    }
  }
  return status || { status: "idle", processed: 0, total: 0 };
}

export function getPlexReport(): PlexReport | null { return readPlexReport() as PlexReport | null; }

export function clearPlexScanCache(): { cleared: number } {
  if ((globalThis as ScanGlobal).__shelfcheckPlexScan) throw new Error("Wait for the current Plex scan to finish before clearing the cache.");
  const report = getPlexReport();
  const cleared = Object.keys(report?.scanCache || {}).length;
  clearPlexReport();
  return { cleared };
}

export function startPlexScan(): PlexScanStatus {
  const global = globalThis as ScanGlobal;
  if (!global.__shelfcheckPlexScan) global.__shelfcheckPlexScan = runPlexScan().finally(() => { global.__shelfcheckPlexScan = undefined; });
  return { status: "running", processed: 0, total: 0, startedAt: new Date().toISOString() };
}
