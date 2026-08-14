import "server-only";

import { validTraktCredentials } from "@/lib/trakt-auth";
import { createScanLogger, type ScanLogger } from "@/lib/scan-log";
import { canCacheAirDateResult, collectedEpisodeCount, collectionFingerprint, scanReason, shouldReportIncompleteEpisode, shouldSaveCheckpoint, type ScanReason } from "@/lib/scan-cache";
import { patchSingleUserState, readSingleUserScanStatus, readSingleUserState, writeSingleUserScanStatus } from "@/lib/sqlite";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { ignoredTraktIds } from "@/lib/ignored-shows";
import { compactTraktShow, type CollectionShow, type MissingEpisode, type TraktShow } from "@/lib/trakt-model";
import { runWorkerPool } from "@/lib/scan-concurrency";
import { isTerminalTraktError, TraktHttpError } from "@/lib/trakt-http";

type ProgressSeason = { number: number; episodes: { number: number; completed: boolean }[] };
type TraktSeason = { number: number; episodes?: { season?: number; number: number; first_aired?: string | null }[] };
type ShowScanState = {
  collectionFingerprint: string;
  airedEpisodes?: number;
  traktUpdatedAt?: string;
  lastCheckedAt: string;
};
type ScanCache = Record<string, ShowScanState>;
type ScanReport = { shows: CollectionShow[]; missing: MissingEpisode[]; lastScan: string; activity?: string; scanCache?: ScanCache; airingGraceDays?: number };
export type ScanStatus = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; startedAt?: string; finishedAt?: string; error?: string; rateLimitPaused?: boolean; rateLimitResumeAt?: string };

const TRAKT = "https://api.trakt.tv";
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type TraktRateLimit = { name?: string; period?: number; limit?: number; remaining?: number; until?: string };
type ScanGlobal = typeof globalThis & {
  __shelfcheckScan?: Promise<void>;
  __shelfcheckNextRequestAt?: number;
  __shelfcheckRequestGate?: Promise<void>;
  __shelfcheckLogger?: ScanLogger;
  __shelfcheckRateLimit?: TraktRateLimit;
  __shelfcheckRateLimitPaused?: boolean;
  __shelfcheckRateLimitResumeAt?: number;
  __shelfcheckSaveCheckpoint?: (reason: "rate-limit" | "error") => void;
};

function rateLimitStatusFields(global: ScanGlobal) {
  return global.__shelfcheckRateLimitPaused
    ? { rateLimitPaused: true, rateLimitResumeAt: new Date(global.__shelfcheckRateLimitResumeAt || Date.now()).toISOString() }
    : { rateLimitPaused: false, rateLimitResumeAt: undefined };
}

function setRateLimitPaused(global: ScanGlobal, paused: boolean, resumeAt?: number) {
  global.__shelfcheckRateLimitPaused = paused;
  global.__shelfcheckRateLimitResumeAt = paused ? Math.max(global.__shelfcheckRateLimitResumeAt || 0, resumeAt || Date.now()) : undefined;
  if (paused) global.__shelfcheckSaveCheckpoint?.("rate-limit");
  const scan = readSingleUserScanStatus() as ScanStatus | null;
  if (scan?.status === "running") writeSingleUserScanStatus({ ...scan, ...rateLimitStatusFields(global) } satisfies ScanStatus);
}

function requestSpacing(global: ScanGlobal): number {
  const remaining = global.__shelfcheckRateLimit?.remaining;
  return Number.isFinite(remaining) && (remaining as number) <= 100 ? 300 : 100;
}

function rateLimitPause(global: ScanGlobal): number {
  const rateLimit = global.__shelfcheckRateLimit;
  if (!Number.isFinite(rateLimit?.remaining) || (rateLimit?.remaining as number) > 50 || !rateLimit?.until) return 0;
  const resetAt = Date.parse(rateLimit.until);
  return Number.isFinite(resetAt) ? Math.max(0, resetAt - Date.now() + 250) : 0;
}

function updateRateLimit(response: Response, global: ScanGlobal) {
  const header = response.headers.get("X-Ratelimit");
  if (!header) return;
  try {
    const rateLimit = JSON.parse(header) as TraktRateLimit;
    global.__shelfcheckRateLimit = rateLimit;
    global.__shelfcheckLogger?.info("rate-limit", rateLimit);
  } catch {
    global.__shelfcheckLogger?.warn("rate-limit.invalid", { header });
  }
}

function compactCache(cache: ScanCache | undefined): ScanCache {
  return Object.fromEntries(Object.entries(cache || {}).map(([id, entry]) => {
    const legacy = entry as ShowScanState & { fingerprint?: string };
    return [id, {
      collectionFingerprint: legacy.collectionFingerprint || "",
      ...(Number.isFinite(legacy.airedEpisodes) ? { airedEpisodes: legacy.airedEpisodes } : {}),
      ...(legacy.traktUpdatedAt ? { traktUpdatedAt: legacy.traktUpdatedAt } : {}),
      lastCheckedAt: legacy.lastCheckedAt,
    }];
  }));
}

function localDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.TZ || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function hasAired(firstAired: string | null | undefined, today: string, graceDays: number): boolean {
  if (!firstAired) return false;
  const airedAt = new Date(firstAired);
  return !Number.isNaN(airedAt.getTime()) && addCalendarDays(localDate(airedAt), graceDays) <= today;
}

function hasUsableAirDate(firstAired: string | null | undefined): firstAired is string {
  return typeof firstAired === "string" && !Number.isNaN(Date.parse(firstAired));
}

function gracePeriod(value: unknown): number {
  return Math.max(0, Math.min(30, Math.trunc(Number(value) || 0)));
}

async function traktRequest(path: string): Promise<Response> {
  let credentials = await validTraktCredentials();
  if (!credentials) throw new Error("Trakt is not configured.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const global = globalThis as ScanGlobal;
    let release!: () => void;
    const previous = global.__shelfcheckRequestGate || Promise.resolve();
    global.__shelfcheckRequestGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(rateLimitPause(global), (global.__shelfcheckNextRequestAt || 0) - Date.now());
      if (delay) await wait(delay);
      global.__shelfcheckNextRequestAt = Date.now() + requestSpacing(global);
    } finally { release(); }
    const requestStarted = Date.now();
    global.__shelfcheckLogger?.info("request.start", { path, attempt: attempt + 1 });
    try {
      if (!credentials) throw new Error("Log in to Trakt before scanning.");
      const response = await fetch(`${TRAKT}${path}`, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": `Shelfcheck/${SHELFCHECK_VERSION} (+https://github.com/andcbii/shelfcheck)`,
          "trakt-api-version": "2",
          "trakt-api-key": credentials.clientId,
          Authorization: `Bearer ${credentials.accessToken}`,
        },
      });
      updateRateLimit(response, global);
      global.__shelfcheckLogger?.info("request.response", { path, attempt: attempt + 1, status: response.status, elapsedMs: Date.now() - requestStarted });
      if (response.status === 401 && attempt === 0) {
        credentials = await validTraktCredentials(true);
        if (!credentials) throw new Error("Log in to Trakt before scanning.");
        continue;
      }
      if (response.status === 401) throw new TraktHttpError(401, "Your Trakt login has expired. Log out, then log in again.");
      if (response.status === 403) throw new TraktHttpError(403, "Trakt rejected this request (403). Check that the token and Client ID belong to the same application.");
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 4) throw new Error(`Trakt request failed (${response.status}).`);
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        global.__shelfcheckNextRequestAt = Math.max(global.__shelfcheckNextRequestAt || 0, Date.now() + delayMs);
        if (response.status === 429) setRateLimitPaused(global, true, Date.now() + delayMs);
        global.__shelfcheckLogger?.warn("request.retry", { path, attempt: attempt + 1, status: response.status, delayMs });
        await wait(delayMs);
        continue;
      }
      if (!response.ok) throw new Error(`Trakt request failed (${response.status}).`);
      if (global.__shelfcheckRateLimitPaused && Date.now() >= (global.__shelfcheckRateLimitResumeAt || 0)) setRateLimitPaused(global, false);
      return response;
    } catch (error) {
      global.__shelfcheckLogger?.warn("request.error", { path, attempt: attempt + 1, elapsedMs: Date.now() - requestStarted, error: error instanceof Error ? error.message : String(error) });
      if (isTerminalTraktError(error)) throw error;
      if (attempt === 4) throw new Error(error instanceof Error ? error.message : "The Trakt request failed.");
      await wait(1000 * 2 ** attempt);
    }
  }
  throw new Error("The Trakt request failed.");
}

async function traktJson<T>(path: string): Promise<T> {
  return (await traktRequest(path)).json() as Promise<T>;
}

async function traktAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let pageCount = 1;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const response = await traktRequest(`${path}${separator}page=${page}&limit=100`);
    items.push(...await response.json() as T[]);
    pageCount = Number(response.headers.get("X-Pagination-Page-Count")) || page;
    page += 1;
  } while (page <= pageCount && page <= 100);
  return items;
}

function updateScan(scan: ScanStatus) {
  writeSingleUserScanStatus(scan);
}

async function runScan(force = false, targetTraktId?: number) {
  const startedAt = new Date().toISOString();
  const state = readSingleUserState().state || {};
  const logger = createScanLogger(state.diagnosticsEnabled !== false);
  const scanGlobal = globalThis as ScanGlobal;
  scanGlobal.__shelfcheckLogger = logger;
  scanGlobal.__shelfcheckRateLimitPaused = false;
  scanGlobal.__shelfcheckRateLimitResumeAt = undefined;
  logger.info("scan.start", { startedAt, version: SHELFCHECK_VERSION, mode: targetTraktId ? "single-show" : force ? "deep" : "quick", targetTraktId, airingGraceDays: gracePeriod(state.airingGraceDays) });
  updateScan({ status: "running", processed: 0, total: 0, startedAt });
  try {
    const prior = (state.checkpoint || state.report) as ScanReport | undefined;
    const priorShows = prior?.shows || [];
    const priorMissing = prior?.missing || [];
    const priorCache = compactCache(prior?.scanCache);
    const airingGraceDays = gracePeriod(state.airingGraceDays);
    const gracePeriodChanged = airingGraceDays !== gracePeriod(prior?.airingGraceDays);
    const downloadedAll = await traktAll<CollectionShow>("/sync/collection/shows?extended=full,images");
    const ignoredIds = ignoredTraktIds(state.ignoredShows);
    const downloaded = downloadedAll.filter((item) => !ignoredIds.has(item.show.ids.trakt));
    logger.info("collection.ignored-skipped", { ignored: downloadedAll.length - downloaded.length, checked: downloaded.length });
    const freshFingerprints = Object.fromEntries(downloaded.map((item) => [String(item.show.ids.trakt), collectionFingerprint(item)]));
    const freshAiredEpisodes = Object.fromEntries(downloaded.map((item) => [String(item.show.ids.trakt), item.show.aired_episodes]));
    const freshTraktUpdatedAt = Object.fromEntries(downloaded.map((item) => [String(item.show.ids.trakt), item.show.updated_at || ""]));
    const freshCollectionComplete = Object.fromEntries(downloaded.map((item) => {
      const aired = item.show.aired_episodes;
      return [String(item.show.ids.trakt), Number.isFinite(aired) && collectedEpisodeCount(item) === aired];
    }));
    const previous = new Map(priorShows.map((item) => [item.show.ids.trakt, item.show]));
    const library: CollectionShow[] = downloaded.map((item) => {
      const collected = collectedEpisodeCount(item);
      const aired = item.show.aired_episodes;
      return { show: compactTraktShow({
        ...previous.get(item.show.ids.trakt),
        ...item.show,
        ...(Number.isFinite(aired) ? { collection: { aired: aired as number, completed: collected } } : {}),
      }) };
    });
    if (targetTraktId && !library.some((item) => item.show.ids.trakt === targetTraktId)) throw new Error("That show is not available in the current Trakt collection.");
    const candidates = targetTraktId ? library.filter((item) => item.show.ids.trakt === targetTraktId) : library;
    logger.info("collection.refreshed", { shows: library.length, previousShows: priorShows.length });

    const previousResults = new Map<number, MissingEpisode[]>();
    for (const result of priorMissing) previousResults.set(result.show.ids.trakt, [...(previousResults.get(result.show.ids.trakt) || []), result]);
    const results: Record<string, MissingEpisode[]> = {};
    const scanCache: ScanCache = {};
    if (targetTraktId) for (const item of library) {
      if (item.show.ids.trakt === targetTraktId) continue;
      const id = String(item.show.ids.trakt);
      results[id] = previousResults.get(item.show.ids.trakt) || [];
      if (priorCache[id]) scanCache[id] = priorCache[id];
    }
    const queue: { item: CollectionShow; reason: ScanReason }[] = [];
    for (const item of candidates) {
      const id = String(item.show.ids.trakt);
      const cached = priorCache[id];
      const collectionChanged = freshFingerprints[id] !== cached?.collectionFingerprint;
      const airedChanged = freshAiredEpisodes[id] !== cached?.airedEpisodes;
      const traktUpdated = freshTraktUpdatedAt[id] !== (cached?.traktUpdatedAt || "");
      const reason = targetTraktId ? "forced-show-check" : scanReason({ deep: force, gracePeriodChanged, cached: Boolean(cached), collectionChanged, airedChanged, traktUpdated });
      if (reason) queue.push({ item, reason });
      else {
        results[id] = previousResults.get(item.show.ids.trakt) || [];
        scanCache[id] = cached;
      }
    }

    let processed = candidates.length - queue.length;
    logger.info("scan.plan", {
      total: candidates.length,
      reused: processed,
      refreshing: queue.length,
      newShows: queue.filter((entry) => entry.reason === "new").length,
      collectionChanged: queue.filter((entry) => entry.reason === "collection-changed").length,
      airedChanged: queue.filter((entry) => entry.reason === "aired-changed").length,
      traktUpdated: queue.filter((entry) => entry.reason === "trakt-updated").length,
      settingsChanged: queue.filter((entry) => entry.reason === "settings-changed").length,
    });
    updateScan({ status: "running", processed, total: candidates.length, startedAt });
    let lastCheckpointProcessed = processed;
    let lastCheckpointAt = Date.now();
    let lastForcedCheckpointProcessed = -1;
    const saveCheckpoint = (reason: "interval" | "rate-limit" | "error", forceSave = false) => {
      const now = Date.now();
      if (forceSave && lastForcedCheckpointProcessed === processed) return;
      if (!forceSave && !shouldSaveCheckpoint(processed, lastCheckpointProcessed, now, lastCheckpointAt)) return;
      const checkpoint: ScanReport = { shows: library, missing: Object.values(results).flat(), lastScan: prior?.lastScan || "", scanCache, airingGraceDays };
      patchSingleUserState({ checkpoint });
      lastCheckpointProcessed = processed;
      lastCheckpointAt = now;
      if (forceSave) lastForcedCheckpointProcessed = processed;
      logger.info("checkpoint.saved", { reason, processed, total: candidates.length });
    };
    scanGlobal.__shelfcheckSaveCheckpoint = (reason) => saveCheckpoint(reason, true);
    await runWorkerPool(queue, 6, async ({ item, reason }) => {
        const id = String(item.show.ids.trakt);
        const showStarted = Date.now();
        logger.info("show.start", { traktId: item.show.ids.trakt, title: item.show.title, reason });
        const canTrustFreshCompleteCount = !force && !targetTraktId && freshCollectionComplete[id] === true;
        let incomplete: { season: number; episode: number }[] = [];
        if (canTrustFreshCompleteCount) {
          logger.info("show.collection-complete", { traktId: item.show.ids.trakt, title: item.show.title, reason });
        } else {
          const progress = await traktJson<{ aired?: number; completed?: number; seasons?: ProgressSeason[] }>(`/shows/${id}/progress/collection?hidden=false&specials=false&count_specials=false&extended=full`);
          const seasons = progress.seasons || [];
          const aired = progress.aired ?? seasons.reduce((sum, season) => sum + (season.number ? season.episodes.length : 0), 0);
          const completed = progress.completed ?? seasons.reduce((sum, season) => sum + (season.number ? season.episodes.filter((episode) => episode.completed).length : 0), 0);
        item.show = compactTraktShow({ ...item.show, collection: { aired, completed } });
          incomplete = seasons.flatMap((season) => season.number
            ? (season.episodes || []).filter((episode) => !episode.completed).map((episode) => ({ season: season.number, episode: episode.number }))
            : []);
        }
        const requiresAirDates = Boolean(incomplete.length && (force || Boolean(targetTraktId) || airingGraceDays > 0));
        let airDateRequestSucceeded = true;
        const episodeDates = requiresAirDates
          ? await traktJson<TraktSeason[]>(`/shows/${id}/seasons?extended=episodes,full`).catch((error) => {
            airDateRequestSucceeded = false;
            logger.warn("show.airdates-unavailable", { traktId: item.show.ids.trakt, title: item.show.title, error: error instanceof Error ? error.message : String(error) });
            return [];
          })
          : [];
        const firstAiredByEpisode = new Map<string, string | null | undefined>();
        for (const season of episodeDates) for (const episode of season.episodes || []) {
          firstAiredByEpisode.set(`${episode.season ?? season.number}:${episode.number}`, episode.first_aired);
        }
        const today = localDate(new Date());
        const missing: MissingEpisode[] = [];
        let unknownAirDates = 0;
        for (const episode of incomplete) {
          const firstAired = firstAiredByEpisode.get(`${episode.season}:${episode.episode}`);
          const airDateKnown = hasUsableAirDate(firstAired);
          if (requiresAirDates && !airDateKnown) unknownAirDates += 1;
          if (shouldReportIncompleteEpisode(force || Boolean(targetTraktId), airingGraceDays, hasAired(firstAired, today, airingGraceDays), !requiresAirDates || airDateKnown)) {
            missing.push({ show: item.show, season: episode.season, episode: episode.episode });
          }
        }
        const cacheable = canCacheAirDateResult(requiresAirDates, airDateRequestSucceeded, unknownAirDates);
        if (unknownAirDates) logger.warn("show.airdates-incomplete", { traktId: item.show.ids.trakt, title: item.show.title, unknownAirDates });
        if (missing.length && !item.show.images?.poster?.length) {
          const details = await traktJson<TraktShow>(`/shows/${id}?extended=full,images`).catch(() => null);
          if (details?.images?.poster?.[0]) item.show = compactTraktShow({ ...item.show, images: { poster: [details.images.poster[0]] } });
          for (const result of missing) result.show = item.show;
        }
        results[id] = missing;
        const checkedAt = new Date();
        if (cacheable) {
          scanCache[id] = {
            collectionFingerprint: freshFingerprints[id] ?? priorCache[id]?.collectionFingerprint ?? "",
            ...(Number.isFinite(freshAiredEpisodes[id]) ? { airedEpisodes: freshAiredEpisodes[id] } : {}),
            ...(freshTraktUpdatedAt[id] ? { traktUpdatedAt: freshTraktUpdatedAt[id] } : {}),
            lastCheckedAt: checkedAt.toISOString(),
          };
        }
        logger.info("show.complete", { traktId: item.show.ids.trakt, title: item.show.title, reason, missing: missing.length, cached: cacheable, elapsedMs: Date.now() - showStarted });
        processed += 1;
        updateScan({ status: "running", processed, total: candidates.length, startedAt, ...rateLimitStatusFields(globalThis as ScanGlobal) });
        saveCheckpoint("interval");
    });
    const missing = Object.values(results).flat().sort((a, b) => a.show.title.localeCompare(b.show.title) || a.season - b.season || a.episode - b.episode);
    const report: ScanReport = { shows: library, missing, lastScan: new Date().toISOString(), scanCache, airingGraceDays };
    const finishedAt = new Date().toISOString();
    patchSingleUserState({ report, checkpoint: null });
    updateScan({ status: "completed", processed: candidates.length, total: candidates.length, startedAt, finishedAt });
    logger.info("scan.complete", { finishedAt, elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt), total: candidates.length, reused: candidates.length - queue.length, refreshed: queue.length, missing: missing.length, targetTraktId });
  } catch (error) {
    scanGlobal.__shelfcheckSaveCheckpoint?.("error");
    const current = getScanStatus();
    updateScan({ ...current, status: "error", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "The scan failed." });
    logger.error("scan.error", { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  } finally {
    scanGlobal.__shelfcheckLogger = undefined;
    scanGlobal.__shelfcheckSaveCheckpoint = undefined;
  }
}

export function getScanStatus(): ScanStatus {
  const scan = (readSingleUserScanStatus() as ScanStatus | null) || { status: "idle", processed: 0, total: 0 };
  if (scan.status === "running" && !(globalThis as ScanGlobal).__shelfcheckScan) {
    const interrupted: ScanStatus = { ...scan, status: "error", error: "The scan was interrupted by a server restart. Start it again to resume." };
    writeSingleUserScanStatus(interrupted);
    return interrupted;
  }
  return scan;
}

export function startScan(force = false, targetTraktId?: number): ScanStatus {
  const global = globalThis as ScanGlobal;
  if (!global.__shelfcheckScan) {
    global.__shelfcheckScan = runScan(force, targetTraktId).finally(() => { global.__shelfcheckScan = undefined; });
  }
  return { status: "running", processed: 0, total: 0, startedAt: new Date().toISOString() };
}

export function clearScanCache(traktId?: number): { cleared: number } {
  const global = globalThis as ScanGlobal;
  if (global.__shelfcheckScan) throw new Error("Wait for the current scan to finish before clearing the cache.");
  const state = readSingleUserState().state || {};
  const report = state.report as ScanReport | undefined;
  const checkpoint = state.checkpoint as ScanReport | undefined;
  if (traktId) {
    const key = String(traktId);
    const hadReportCache = Boolean(report?.scanCache?.[key]);
    const hadCheckpointCache = Boolean(checkpoint?.scanCache?.[key]);
    if (report) {
      const scanCache = { ...(report.scanCache || {}) };
      delete scanCache[key];
      patchSingleUserState({ report: { ...report, scanCache } });
    }
    if (checkpoint) {
      const scanCache = { ...(checkpoint.scanCache || {}) };
      delete scanCache[key];
      patchSingleUserState({ checkpoint: { ...checkpoint, scanCache, shows: checkpoint.shows.filter((item) => item.show.ids.trakt !== traktId), missing: checkpoint.missing.filter((episode) => episode.show.ids.trakt !== traktId) } });
    }
    return { cleared: hadReportCache || hadCheckpointCache ? 1 : 0 };
  }
  const cleared = new Set([
    ...Object.keys(report?.scanCache || {}),
    ...Object.keys(checkpoint?.scanCache || {}),
  ]).size;
  patchSingleUserState({
    ...(report ? { report: { ...report, scanCache: {} } } : {}),
    checkpoint: null,
  });
  return { cleared };
}
