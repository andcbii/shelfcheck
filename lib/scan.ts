import "server-only";

import { readTraktCredentials } from "@/lib/server-config";
import { createScanLogger, type ScanLogger } from "@/lib/scan-log";
import { patchSingleUserState, readSingleUserState } from "@/lib/sqlite";

type TraktShow = {
  title: string;
  year: number;
  ids: { trakt: number; slug: string; tmdb?: number };
  status?: string;
  images?: { poster?: string[] };
  collection?: { aired: number; completed: number };
};
type CollectionShow = { show: TraktShow; seasons?: { number: number; episodes?: { number: number; collected_at?: string }[] }[] };
type ProgressSeason = { number: number; episodes: { number: number; completed: boolean }[] };
type TraktSeason = { number: number; episodes?: { season?: number; number: number; first_aired?: string | null }[] };
type MissingEpisode = { show: TraktShow; season: number; episode: number };
type ShowScanState = { fingerprint: string; lastCheckedAt: string; nextCheckAt: string | null };
type ScanCache = Record<string, ShowScanState>;
type ScanReport = { shows: CollectionShow[]; missing: MissingEpisode[]; lastScan: string; activity?: string; scanCache?: ScanCache };
type CalendarEntry = { first_aired?: string; show?: { ids?: { trakt?: number } } };
export type ScanStatus = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; startedAt?: string; finishedAt?: string; error?: string };

const TRAKT = "https://api.trakt.tv";
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type ScanGlobal = typeof globalThis & { __shelfcheckScan?: Promise<void>; __shelfcheckNextRequestAt?: number; __shelfcheckRequestGate?: Promise<void>; __shelfcheckLogger?: ScanLogger };

function compactShow(show: TraktShow): TraktShow {
  return {
    title: show.title,
    year: show.year,
    ids: show.ids,
    ...(show.status ? { status: show.status } : {}),
    ...(show.images?.poster?.[0] ? { images: { poster: [show.images.poster[0]] } } : {}),
    ...(show.collection ? { collection: show.collection } : {}),
  };
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function fingerprint(item: CollectionShow): string {
  return hash((item.seasons || []).flatMap((season) => (season.episodes || [])
    .map((episode) => `${season.number}:${episode.number}:${episode.collected_at || ""}`)).sort().join("|"));
}

function compactCache(cache: ScanCache | undefined): ScanCache {
  return Object.fromEntries(Object.entries(cache || {}).map(([id, entry]) => [id, {
    ...entry,
    fingerprint: entry.fingerprint.length > 8 ? hash(entry.fingerprint) : entry.fingerprint,
  }]));
}

function activityMarker(value: unknown): string {
  const activity = value as { episodes?: { collected_at?: string }; shows?: { collected_at?: string } };
  return JSON.stringify([activity?.episodes?.collected_at || "", activity?.shows?.collected_at || ""]);
}

function nextFallback(show: TraktShow, checkedAt: Date): number {
  const ended = ["ended", "canceled", "cancelled"].includes((show.status || "").toLowerCase());
  return checkedAt.getTime() + (ended ? 30 : 7) * 86_400_000;
}

function calendarStartDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.TZ || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
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

function hasAired(firstAired: string | null | undefined, today: string): boolean {
  if (!firstAired) return false;
  const airedAt = new Date(firstAired);
  return !Number.isNaN(airedAt.getTime()) && localDate(airedAt) <= today;
}

async function traktRequest(path: string): Promise<Response> {
  const credentials = await readTraktCredentials();
  if (!credentials) throw new Error("Trakt is not configured.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const global = globalThis as ScanGlobal;
    let release!: () => void;
    const previous = global.__shelfcheckRequestGate || Promise.resolve();
    global.__shelfcheckRequestGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(0, (global.__shelfcheckNextRequestAt || 0) - Date.now());
      if (delay) await wait(delay);
      global.__shelfcheckNextRequestAt = Date.now() + 300;
    } finally { release(); }
    const requestStarted = Date.now();
    global.__shelfcheckLogger?.info("request.start", { path, attempt: attempt + 1 });
    try {
      const response = await fetch(`${TRAKT}${path}`, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Shelfcheck/1.1.0-beta.5 (+https://github.com/andcbii/shelfcheck)",
          "trakt-api-version": "2",
          "trakt-api-key": credentials.clientId,
          Authorization: `Bearer ${credentials.accessToken}`,
        },
      });
      global.__shelfcheckLogger?.info("request.response", { path, attempt: attempt + 1, status: response.status, elapsedMs: Date.now() - requestStarted });
      if (response.status === 401) throw new Error("Trakt rejected the access token. Check your credentials and try again.");
      if (response.status === 403) throw new Error("Trakt rejected this request (403). Check that the token and Client ID belong to the same application.");
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 4) throw new Error(`Trakt request failed (${response.status}).`);
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        global.__shelfcheckLogger?.warn("request.retry", { path, attempt: attempt + 1, status: response.status, delayMs });
        await wait(delayMs);
        continue;
      }
      if (!response.ok) throw new Error(`Trakt request failed (${response.status}).`);
      return response;
    } catch (error) {
      global.__shelfcheckLogger?.warn("request.error", { path, attempt: attempt + 1, elapsedMs: Date.now() - requestStarted, error: error instanceof Error ? error.message : String(error) });
      if (error instanceof Error && (error.message.includes("access token") || error.message.includes("403"))) throw error;
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
  patchSingleUserState({ scan });
}

async function runScan(force = false) {
  const startedAt = new Date().toISOString();
  const state = readSingleUserState().state || {};
  const logger = createScanLogger(state.diagnosticsEnabled !== false);
  (globalThis as ScanGlobal).__shelfcheckLogger = logger;
  logger.info("scan.start", { startedAt, version: "1.1.0-beta.5", force });
  updateScan({ status: "running", processed: 0, total: 0, startedAt });
  try {
    const prior = (state.checkpoint || state.report) as ScanReport | undefined;
    const priorShows = prior?.shows || [];
    const priorMissing = prior?.missing || [];
    const priorCache = compactCache(prior?.scanCache);
    const activity = activityMarker(await traktJson<unknown>("/sync/last_activities"));
    const now = Date.now();
    const startDate = calendarStartDate();
    const calendar = await traktJson<CalendarEntry[]>(`/calendars/my/shows/${startDate}/31`).catch((error) => {
      logger.warn("calendar.unavailable", { error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    const upcomingChecks = new Map<number, number>();
    for (const entry of calendar) {
      const traktId = entry.show?.ids?.trakt;
      const firstAired = entry.first_aired ? Date.parse(entry.first_aired) : Number.NaN;
      const checkAt = firstAired + 7_200_000;
      if (!traktId || !Number.isFinite(checkAt) || checkAt <= now) continue;
      upcomingChecks.set(traktId, Math.min(upcomingChecks.get(traktId) || Number.POSITIVE_INFINITY, checkAt));
    }
    logger.info("calendar.loaded", { entries: calendar.length, showsWithUpcomingEpisodes: upcomingChecks.size, startDate, days: 31 });
    let library: CollectionShow[];
    let freshFingerprints: Record<string, string> | null = null;
    if (!force && priorShows.length && activity === prior?.activity) {
      library = priorShows;
      logger.info("collection.cache-hit", { shows: library.length, activity });
    } else {
      const downloaded = await traktAll<CollectionShow>("/sync/collection/shows?extended=full,images");
      freshFingerprints = Object.fromEntries(downloaded.map((item) => [String(item.show.ids.trakt), fingerprint(item)]));
      const previous = new Map(priorShows.map((item) => [item.show.ids.trakt, item.show]));
      library = downloaded.map((item) => ({ show: compactShow({ ...previous.get(item.show.ids.trakt), ...item.show }) }));
      logger.info("collection.refreshed", { shows: library.length, previousShows: priorShows.length, activityChanged: activity !== prior?.activity });
    }

    const previousResults = new Map<number, MissingEpisode[]>();
    for (const result of priorMissing) previousResults.set(result.show.ids.trakt, [...(previousResults.get(result.show.ids.trakt) || []), result]);
    const results: Record<string, MissingEpisode[]> = {};
    const scanCache: ScanCache = {};
    const queue: { item: CollectionShow; reason: "forced" | "new" | "collection-changed" | "scheduled" }[] = [];
    for (const item of library) {
      const id = String(item.show.ids.trakt);
      const cached = priorCache[id];
      const lastCheckedAt = cached ? Date.parse(cached.lastCheckedAt) : Number.NaN;
      const fallback = Number.isFinite(lastCheckedAt) ? nextFallback(item.show, new Date(lastCheckedAt)) : Number.NaN;
      const calendarCheck = upcomingChecks.get(item.show.ids.trakt);
      const dueAt = Math.min(calendarCheck || Number.POSITIVE_INFINITY, fallback);
      const changed = freshFingerprints !== null && freshFingerprints[id] !== cached?.fingerprint;
      if (force || !cached || changed || !Number.isFinite(dueAt) || dueAt <= now) {
        queue.push({ item, reason: force ? "forced" : !cached ? "new" : changed ? "collection-changed" : "scheduled" });
      }
      else {
        results[id] = previousResults.get(item.show.ids.trakt) || [];
        scanCache[id] = { ...cached, nextCheckAt: new Date(dueAt).toISOString() };
      }
    }

    let processed = library.length - queue.length;
    logger.info("scan.plan", {
      total: library.length,
      reused: processed,
      refreshing: queue.length,
      newShows: queue.filter((entry) => entry.reason === "new").length,
      collectionChanged: queue.filter((entry) => entry.reason === "collection-changed").length,
      scheduled: queue.filter((entry) => entry.reason === "scheduled").length,
      forced: queue.filter((entry) => entry.reason === "forced").length,
    });
    updateScan({ status: "running", processed, total: library.length, startedAt });
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const { item, reason } = queue[cursor++];
        const id = String(item.show.ids.trakt);
        const showStarted = Date.now();
        logger.info("show.start", { traktId: item.show.ids.trakt, title: item.show.title, reason });
        const progress = await traktJson<{ aired?: number; completed?: number; seasons?: ProgressSeason[] }>(`/shows/${id}/progress/collection?hidden=false&specials=false&count_specials=false&extended=full`);
        const seasons = progress.seasons || [];
        const aired = progress.aired ?? seasons.reduce((sum, season) => sum + (season.number ? season.episodes.length : 0), 0);
        const completed = progress.completed ?? seasons.reduce((sum, season) => sum + (season.number ? season.episodes.filter((episode) => episode.completed).length : 0), 0);
        item.show = compactShow({ ...item.show, collection: { aired, completed } });
        const incomplete = seasons.flatMap((season) => season.number
          ? (season.episodes || []).filter((episode) => !episode.completed).map((episode) => ({ season: season.number, episode: episode.number }))
          : []);
        const episodeDates = incomplete.length
          ? await traktJson<TraktSeason[]>(`/shows/${id}/seasons?extended=episodes,full`).catch((error) => {
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
        for (const episode of incomplete) {
          if (hasAired(firstAiredByEpisode.get(`${episode.season}:${episode.episode}`), today)) {
            missing.push({ show: item.show, season: episode.season, episode: episode.episode });
          }
        }
        if (missing.length && !item.show.images?.poster?.length) {
          const details = await traktJson<TraktShow>(`/shows/${id}?extended=full,images`).catch(() => null);
          if (details?.images?.poster?.[0]) item.show = compactShow({ ...item.show, images: { poster: [details.images.poster[0]] } });
          for (const result of missing) result.show = item.show;
        }
        results[id] = missing;
        const checkedAt = new Date();
        const fallback = nextFallback(item.show, checkedAt);
        const nextAiring = upcomingChecks.get(item.show.ids.trakt);
        scanCache[id] = {
          fingerprint: freshFingerprints?.[id] ?? priorCache[id]?.fingerprint ?? "",
          lastCheckedAt: checkedAt.toISOString(),
          nextCheckAt: new Date(nextAiring ? Math.min(nextAiring, fallback) : fallback).toISOString(),
        };
        logger.info("show.complete", { traktId: item.show.ids.trakt, title: item.show.title, reason, missing: missing.length, elapsedMs: Date.now() - showStarted });
        processed += 1;
        const checkpoint: ScanReport = { shows: library, missing: Object.values(results).flat(), lastScan: prior?.lastScan || "", activity, scanCache };
        patchSingleUserState({ checkpoint, scan: { status: "running", processed, total: library.length, startedAt } satisfies ScanStatus });
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(6, queue.length || 1) }, worker));
    const failedWorker = workers.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedWorker) throw failedWorker.reason;
    const missing = Object.values(results).flat().sort((a, b) => a.show.title.localeCompare(b.show.title) || a.season - b.season || a.episode - b.episode);
    const report: ScanReport = { shows: library, missing, lastScan: new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }), activity, scanCache };
    const finishedAt = new Date().toISOString();
    patchSingleUserState({ report, checkpoint: null, scan: { status: "completed", processed: library.length, total: library.length, startedAt, finishedAt } satisfies ScanStatus });
    logger.info("scan.complete", { finishedAt, elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt), total: library.length, reused: library.length - queue.length, refreshed: queue.length, missing: missing.length });
  } catch (error) {
    const current = getScanStatus();
    updateScan({ ...current, status: "error", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "The scan failed." });
    logger.error("scan.error", { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  } finally {
    (globalThis as ScanGlobal).__shelfcheckLogger = undefined;
  }
}

export function getScanStatus(): ScanStatus {
  const state = readSingleUserState().state;
  const scan = (state?.scan as ScanStatus | undefined) || { status: "idle", processed: 0, total: 0 };
  if (scan.status === "running" && !(globalThis as ScanGlobal).__shelfcheckScan) {
    const interrupted: ScanStatus = { ...scan, status: "error", error: "The scan was interrupted by a server restart. Start it again to resume." };
    patchSingleUserState({ scan: interrupted });
    return interrupted;
  }
  return scan;
}

export function startScan(force = false): ScanStatus {
  const global = globalThis as ScanGlobal;
  if (!global.__shelfcheckScan) {
    global.__shelfcheckScan = runScan(force).finally(() => { global.__shelfcheckScan = undefined; });
  }
  return { status: "running", processed: 0, total: 0, startedAt: new Date().toISOString() };
}
