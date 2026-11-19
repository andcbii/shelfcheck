import "server-only";

import { TraktRunCredentials } from "@/lib/trakt-auth";
import { createScanLogger } from "@/lib/scan-log";
import { canCacheAirDateResult, collectedEpisodeCount, collectionFingerprint, scanReason, shouldReportIncompleteEpisode, TRAKT_RESUME_POINT_VERSION, traktResumePointIsUsable, type ScanReason } from "@/lib/scan-cache";
import { patchSingleUserState, readSingleUserScanStatus, readSingleUserState, trackScanIgnores, writeSingleUserScanStatus } from "@/lib/sqlite";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { ignoredTraktIds } from "@/lib/ignored-shows";
import { compactTraktShow, type CollectionShow, type MissingEpisode, type TraktShow } from "@/lib/trakt-model";
import { runTrackedWorkerPool } from "@/lib/scan-concurrency";
import { isProviderLoginFailure, isTraktAuthenticationFailure, ProviderCooldownTooLongError, type ProviderAuth, type ProviderCooldownReason } from "@/lib/provider-client";
import { scanProviderClient } from "@/lib/scan-provider-client";
import { scanRuns, type ScanRunMode, type ScanRunOwner, type ScanRunStatus } from "@/lib/scan-run";

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
/** A full-run Resume point: the report so far, plus when it was saved and its format version. */
export type TraktResumePoint = ScanReport & { savedAt?: string; resumePointVersion?: number };

const TRAKT = "https://api.trakt.tv";
/**
 * The Trakt scan mode's adapter to the scan run lifecycle: its status and
 * Resume point stores and Interrupted scan wording. Its lifecycle events keep
 * their unprefixed names (`scan.start`, `checkpoint.saved`) in shelfcheck.log.
 * It raises no Coverage Issues.
 */
const traktScanMode: ScanRunMode<ScanRunStatus, TraktResumePoint> = {
  kind: "trakt",
  eventPrefix: "",
  failureMessage: "The scan failed.",
  status: { read: () => readSingleUserScanStatus() as ScanRunStatus | null, write: writeSingleUserScanStatus },
  interruptedError: () => "The scan was interrupted by a server restart. Start it again to resume.",
  resumePoint: {
    read: () => (readSingleUserState().state?.checkpoint as TraktResumePoint | undefined) || null,
    write: (checkpoint) => { patchSingleUserState({ checkpoint }); },
    clear: () => { patchSingleUserState({ checkpoint: null }); },
    resumeDetails: (checkpoint) => ({ shows: checkpoint.shows?.length || 0, cacheEntries: Object.keys(checkpoint.scanCache || {}).length }),
    discardDetails: (checkpoint) => ({ savedAt: checkpoint.savedAt, resumePointVersion: checkpoint.resumePointVersion, airingGraceDays: checkpoint.airingGraceDays, reason: "expired-or-incompatible" }),
    // checkpoint.saved keeps its pre-lifecycle reasons: every save names one, and a failure save is "error".
    savedReason: (reason) => (reason === "failure" ? "error" : reason),
  },
};

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

const TRAKT_LOGIN_EXPIRED = "Your Trakt login has expired. Log out, then log in again.";
const TRAKT_FORBIDDEN = "Trakt rejected this request (403). Check that the token and Client ID belong to the same application.";

const TRAKT_COOLDOWN_WORDING: Record<ProviderCooldownReason, (minutes: number) => string> = {
  "rate-limit": (minutes) => `Trakt asked Shelfcheck to wait ${minutes} minutes.`,
  server: (minutes) => `Trakt is unavailable and asked Shelfcheck to wait ${minutes} minutes.`,
  "rate-limit-reset": (minutes) => `Trakt's rate limit resets in ${minutes} minutes.`,
};

/**
 * Ends the Trakt scan run: a provider cooldown, or a Trakt login that cannot be
 * recovered. Optional lookups (air dates, posters) never swallow it.
 */
class TraktScanStoppedError extends Error {}

/** The Trakt scan's wording for a failure that ends the run; every other failure keeps its own message. */
function presentTraktFailure(error: unknown): unknown {
  if (error instanceof ProviderCooldownTooLongError) {
    // The time still to wait, which a later run reports as it shrinks; only the wording is rounded.
    return new TraktScanStoppedError(`${TRAKT_COOLDOWN_WORDING[error.reason](Math.ceil(error.retryAfterMs / 60_000))} Start the scan again after that to resume.`, { cause: error });
  }
  if (isTraktAuthenticationFailure(error)) return new TraktScanStoppedError(error.status === 401 ? TRAKT_LOGIN_EXPIRED : TRAKT_FORBIDDEN, { cause: error });
  if (isProviderLoginFailure("Trakt", error)) return new TraktScanStoppedError(error.message, { cause: error });
  return error;
}

const traktRequest: RequestInit = { headers: { Accept: "application/json", "Content-Type": "application/json" } };

/** One Trakt request through the shared provider client, with the run's Trakt login. */
async function traktJson<T>(trakt: ProviderAuth, path: string): Promise<T> {
  try { return await scanProviderClient.json<T>(`${TRAKT}${path}`, traktRequest, "Trakt", trakt); } catch (error) { throw presentTraktFailure(error); }
}

/** Every page of a Trakt list through the shared provider client. */
async function traktAll<T>(trakt: ProviderAuth, path: string): Promise<T[]> {
  try { return await scanProviderClient.pages<T>(`${TRAKT}${path}`, traktRequest, "Trakt", trakt); } catch (error) { throw presentTraktFailure(error); }
}

/**
 * One Trakt Scan run through the scan run lifecycle. The lifecycle owns status,
 * heartbeat, logger and Resume point policy; this keeps the Trakt work, report
 * assembly and ignore tracking.
 *
 * A full run resumes from a usable Resume point and saves new ones. A
 * single-show check neither loads nor creates one: it starts from the saved
 * report, and on success removes the checked show from a stored full-run
 * Resume point, so the next full run rechecks it.
 */
function runScan(owner: ScanRunOwner, force = false, targetTraktId?: number) {
  const state = readSingleUserState().state || {};
  let finishIgnoreTracking: (() => void) | undefined;
  return scanRuns.run(owner, traktScanMode, {
    fullRun: !targetTraktId,
    pruneResumePoint: (point) => resumePointWithoutShow(point, targetTraktId!),
    createLogger: () => createScanLogger(state.diagnosticsEnabled !== false),
    startDetails: { version: SHELFCHECK_VERSION, mode: targetTraktId ? "single-show" : force ? "deep" : "quick", targetTraktId, airingGraceDays: gracePeriod(state.airingGraceDays) },
    hooks: {
      begin: () => {
        // A new run's provider state; pacing and provider deadlines carry over from earlier runs.
        scanProviderClient.startRun();
        // Ignore tracking spans every report and Resume point write, including a forced failure save.
        finishIgnoreTracking = trackScanIgnores("trakt", Date.parse(owner.startedAt));
      },
      ended: () => finishIgnoreTracking?.(),
    },
  }, async (run) => {
    const { startedAt, logger, activeWork } = run;
    const airingGraceDays = gracePeriod(state.airingGraceDays);
    // An unusable Resume point is discarded and cleared; the saved report and its scan cache are the fallback.
    const { usable: checkpoint } = run.resumePoint.load((point) => traktResumePointIsUsable(point, airingGraceDays, Date.now()));
    // The run's Trakt login: read once after the Resume point is judged, refreshed before use when it is about to expire.
    const trakt = await TraktRunCredentials.open();
    if (!trakt) throw new Error("Trakt is not configured.");
    const prior: ScanReport | undefined = checkpoint || (state.report as ScanReport | undefined);
    const priorShows = prior?.shows || [];
    const priorMissing = prior?.missing || [];
    const priorCache = compactCache(prior?.scanCache);
    const gracePeriodChanged = airingGraceDays !== gracePeriod(prior?.airingGraceDays);
    const downloadedAll = await traktAll<CollectionShow>(trakt, "/sync/collection/shows?extended=full,images");
    const ignoredIds = ignoredTraktIds(state.ignoredShows, Date.parse(startedAt));
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
    run.progress(processed, candidates.length);
    run.resumePoint.startIntervals();
    // The Resume point holds the completed shows' results and cache entries.
    run.resumePoint.provideSnapshot((savedAt) => ({
      point: { shows: library, missing: Object.values(results).flat(), lastScan: prior?.lastScan || "", scanCache, airingGraceDays, savedAt, resumePointVersion: TRAKT_RESUME_POINT_VERSION },
      details: {},
    }));
    await runTrackedWorkerPool(queue, 6, activeWork, ({ item }) => ({ key: String(item.show.ids.trakt), show: item.show.title }), async ({ item, reason }) => {
        const id = String(item.show.ids.trakt);
        const showStarted = Date.now();
        logger.info("show.start", { traktId: item.show.ids.trakt, title: item.show.title, reason });
        const canTrustFreshCompleteCount = !force && !targetTraktId && freshCollectionComplete[id] === true;
        let incomplete: { season: number; episode: number }[] = [];
        if (canTrustFreshCompleteCount) {
          logger.info("show.collection-complete", { traktId: item.show.ids.trakt, title: item.show.title, reason });
        } else {
          activeWork.update(id, item.show.title, "collection-progress");
          const progress = await traktJson<{ aired?: number; completed?: number; seasons?: ProgressSeason[] }>(trakt, `/shows/${id}/progress/collection?hidden=false&specials=false&count_specials=false&extended=full`);
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
        if (requiresAirDates) activeWork.update(id, item.show.title, "air-dates");
        const episodeDates = requiresAirDates
          ? await traktJson<TraktSeason[]>(trakt, `/shows/${id}/seasons?extended=episodes,full`).catch((error) => {
            if (error instanceof TraktScanStoppedError) throw error;
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
          activeWork.update(id, item.show.title, "poster");
          const details = await traktJson<TraktShow>(trakt, `/shows/${id}?extended=full,images`).catch((error) => { if (error instanceof TraktScanStoppedError) throw error; return null; });
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
        run.progress(processed, candidates.length);
        run.resumePoint.checkpoint();
    });
    const missing = Object.values(results).flat().sort((a, b) => a.show.title.localeCompare(b.show.title) || a.season - b.season || a.episode - b.episode);
    const report: ScanReport = { shows: library, missing, lastScan: new Date().toISOString(), scanCache, airingGraceDays };
    const finishedAt = new Date().toISOString();
    run.complete({
      // The report and the cleared Resume point are written together.
      commit: () => patchSingleUserState({ report, checkpoint: null }),
      processed: candidates.length,
      total: candidates.length,
      finishedAt,
      details: { finishedAt, elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt), total: candidates.length, reused: candidates.length - queue.length, refreshed: queue.length, missing: missing.length, targetTraktId },
    });
  });
}

/** A Resume point without one show's result, cache entry and collection entry; everything else, savedAt included, is kept. */
function resumePointWithoutShow(point: TraktResumePoint, traktId: number): TraktResumePoint {
  const scanCache = { ...(point.scanCache || {}) };
  delete scanCache[String(traktId)];
  return { ...point, scanCache, shows: (point.shows || []).filter((item) => item.show.ids.trakt !== traktId), missing: (point.missing || []).filter((episode) => episode.show.ids.trakt !== traktId) };
}

/** The Trakt scan status, with an Interrupted scan reconciled once by the scan run lifecycle. */
export function getScanStatus(): ScanRunStatus {
  return scanRuns.readStatus(traktScanMode) || { status: "idle", processed: 0, total: 0 };
}

/**
 * Starts a Trakt Scan run, full or single-show. It claims the shared scan run
 * lock first; throws ScanRunConflictError, with no side effects, while any
 * Scan run is active.
 */
export function startScan(force = false, targetTraktId?: number): ScanRunStatus {
  const { owner } = scanRuns.start("trakt", (runOwner) => runScan(runOwner, force, targetTraktId));
  return { status: "running", processed: 0, total: 0, startedAt: owner.startedAt };
}

export function clearScanCache(traktId?: number): { cleared: number } {
  if (traktId !== undefined && (!Number.isInteger(traktId) || traktId <= 0)) throw new Error("A positive Trakt show ID is required.");
  if (scanRuns.isActive("trakt")) throw new Error("Wait for the current scan to finish before clearing the cache.");
  const state = readSingleUserState().state || {};
  const report = state.report as ScanReport | undefined;
  const checkpoint = state.checkpoint as TraktResumePoint | undefined;
  if (traktId !== undefined) {
    const key = String(traktId);
    const hadReportCache = Boolean(report?.scanCache?.[key]);
    const hadCheckpointCache = Boolean(checkpoint?.scanCache?.[key]);
    if (report) {
      const scanCache = { ...(report.scanCache || {}) };
      delete scanCache[key];
      patchSingleUserState({ report: { ...report, scanCache } });
    }
    if (checkpoint) patchSingleUserState({ checkpoint: resumePointWithoutShow(checkpoint, traktId) });
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
