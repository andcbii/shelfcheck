"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TraktShow = {
  title: string;
  year: number;
  ids: { trakt: number; slug: string; tmdb?: number };
  status?: string;
  images?: { poster?: string[] };
  collection?: { aired: number; completed: number };
};
type CollectionShow = {
  show: TraktShow;
  seasons?: { number: number; episodes?: { number: number; collected_at?: string }[] }[];
};
type ProgressEpisode = { number: number; completed: boolean };
type ProgressSeason = { number: number; episodes: ProgressEpisode[] };
type MissingEpisode = { show: TraktShow; season: number; episode: number };
type ShowScanState = { fingerprint: string; lastCheckedAt: string; nextCheckAt: string | null };
type ScanCache = Record<string, ShowScanState>;
type ScanCheckpoint = { signature: string; library: CollectionShow[]; completed: number[]; results: Record<string, MissingEpisode[]>; activity?: string; scanCache?: ScanCache };
type ScanReport = { shows: CollectionShow[]; missing: MissingEpisode[]; lastScan: string; activity?: string; scanCache?: ScanCache };
type ServerState = {
  report?: ScanReport;
  checkpoint?: ScanCheckpoint | null;
  ignoredShows?: TraktShow[];
};

const TRAKT = "https://api.trakt.tv";
const REPORT_CACHE = "shelfcheck-report-v1";
const CHECKPOINT_CACHE = "shelfcheck-checkpoint-v1";
const DEBUG_LOG_CACHE = "shelfcheck-debug-log-v1";
const DEBUG_ENABLED_CACHE = "shelfcheck-debug-enabled-v1";
const IGNORED_SHOWS_CACHE = "shelfcheck-ignored-shows-v1";
const IGNORED_SHOWS_COOKIE = "shelfcheck-ignored-shows-v1";

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

function compactLibrary(library: CollectionShow[]): CollectionShow[] {
  return library.map(({ show }) => ({ show: compactShow(show) }));
}

function collectionFingerprint(item: CollectionShow): string {
  return (item.seasons || [])
    .flatMap((season) => (season.episodes || []).map((episode) => `${season.number}:${episode.number}:${episode.collected_at || ""}`))
    .sort()
    .join("|");
}

function collectionActivityMarker(activity: unknown): string {
  const value = activity as { episodes?: { collected_at?: string }; shows?: { collected_at?: string } };
  return JSON.stringify([value?.episodes?.collected_at || "", value?.shows?.collected_at || ""]);
}

function fallbackDueAt(show: TraktShow, checkedAt: Date): number {
  const ended = ["ended", "canceled", "cancelled"].includes((show.status || "").toLowerCase());
  return checkedAt.getTime() + (ended ? 30 : 7) * 24 * 60 * 60 * 1000;
}

function compactMissing(items: MissingEpisode[]): MissingEpisode[] {
  return items.map((item) => ({ ...item, show: compactShow(item.show) }));
}

function persistIgnoredShows(items: TraktShow[]) {
  const compact = items.map((show) => ({ title: show.title, year: show.year, ids: show.ids }));
  localStorage.setItem(IGNORED_SHOWS_CACHE, JSON.stringify(compact));
  document.cookie = `${IGNORED_SHOWS_COOKIE}=${encodeURIComponent(JSON.stringify(compact))}; Max-Age=315360000; Path=/; SameSite=Lax`;
}

function loadIgnoredShows(): TraktShow[] {
  const stored: TraktShow[] = [];
  try {
    const local = JSON.parse(localStorage.getItem(IGNORED_SHOWS_CACHE) || "[]") as TraktShow[];
    if (Array.isArray(local)) stored.push(...local);
  } catch { /* try the cookie backup */ }
  try {
    const prefix = `${IGNORED_SHOWS_COOKIE}=`;
    const value = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix))?.slice(prefix.length);
    const cookie = value ? JSON.parse(decodeURIComponent(value)) as TraktShow[] : [];
    if (Array.isArray(cookie)) stored.push(...cookie);
  } catch { /* ignore invalid cookie data */ }
  return [...new Map(stored.filter((show) => show?.ids?.trakt).map((show) => [show.ids.trakt, compactShow(show)])).values()]
    .sort((a, b) => a.title.localeCompare(b.title));
}

export default function Home() {
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [shows, setShows] = useState<CollectionShow[]>([]);
  const [missing, setMissing] = useState<MissingEpisode[]>([]);
  const [error, setError] = useState("");
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(0);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [ignoredShows, setIgnoredShows] = useState<TraktShow[]>([]);
  const [openShowMenu, setOpenShowMenu] = useState<number | null>(null);
  const [ignoredManagerOpen, setIgnoredManagerOpen] = useState(false);
  const [sortField, setSortField] = useState<"title" | "percent">("title");
  const [sortAscending, setSortAscending] = useState(true);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [rateLimitPaused, setRateLimitPaused] = useState(false);
  const [scanCache, setScanCache] = useState<ScanCache>({});
  const [lastActivity, setLastActivity] = useState("");
  const debugEnabledRef = useRef(false);
  const requestGateRef = useRef<Promise<void>>(Promise.resolve());
  const nextRequestAtRef = useRef(0);
  const networkFailuresRef = useRef(0);
  const networkPauseUntilRef = useRef(0);
  const connectionValidatedRef = useRef(false);
  const serverSyncTimerRef = useRef<number | null>(null);
  const pendingServerPatchRef = useRef<Partial<ServerState>>({});

  useEffect(() => {
    const diagnosticsOn = localStorage.getItem(DEBUG_ENABLED_CACHE) === "true";
    setDebugEnabled(diagnosticsOn);
    debugEnabledRef.current = diagnosticsOn;
    const savedIgnored = loadIgnoredShows();
    setIgnoredShows(savedIgnored);
    try { persistIgnoredShows(savedIgnored); } catch { /* persistence must not block startup */ }
    void fetch("/api/config", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const { configured } = await response.json() as { configured: boolean };
      setConnected(configured);
      if (configured) setSettingsOpen(false);
    }).catch(() => { /* settings remain open when configuration cannot be read */ });

    try {
      const cached = localStorage.getItem(REPORT_CACHE);
      if (cached) {
        const report = JSON.parse(cached);
        if (Array.isArray(report.shows) && Array.isArray(report.missing) && typeof report.lastScan === "string") {
          const cachedShows = compactLibrary(report.shows);
          const cachedMissing = compactMissing(report.missing);
          setShows(cachedShows);
          setMissing(cachedMissing);
          setLastScan(report.lastScan);
          setScanCache(report.scanCache || {});
          setLastActivity(report.activity || "");
          try { localStorage.setItem(REPORT_CACHE, JSON.stringify({ ...report, shows: cachedShows, missing: cachedMissing })); }
          catch { /* the next completed scan will replace an oversized legacy report */ }
        }
      }
    } catch { /* ignore an invalid or outdated report cache */ }
    try {
      const checkpoint = JSON.parse(localStorage.getItem(CHECKPOINT_CACHE) || "null") as ScanCheckpoint | null;
      if (checkpoint?.library?.length) {
        const cachedLibrary = compactLibrary(checkpoint.library);
        setShows(cachedLibrary); setProcessed(checkpoint.completed.length); setTotal(cachedLibrary.length);
        setPending(cachedLibrary.length - checkpoint.completed.length); setMissing(compactMissing(Object.values(checkpoint.results || {}).flat()));
      }
    } catch { /* ignore invalid checkpoint data */ }
    void fetch("/api/state", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const { state } = await response.json() as { state: ServerState | null };
      if (!state) {
        let localReport: ServerState["report"];
        let localCheckpoint: ScanCheckpoint | null = null;
        try { localReport = JSON.parse(localStorage.getItem(REPORT_CACHE) || "null") || undefined; } catch { /* no local report */ }
        try { localCheckpoint = JSON.parse(localStorage.getItem(CHECKPOINT_CACHE) || "null"); } catch { /* no local checkpoint */ }
        syncServerState({ report: localReport, checkpoint: localCheckpoint, ignoredShows: savedIgnored }, true);
        return;
      }
      if (Array.isArray(state.ignoredShows)) {
        const remoteIgnored = state.ignoredShows.map(compactShow);
        setIgnoredShows(remoteIgnored);
        try { persistIgnoredShows(remoteIgnored); } catch { /* retain server copy */ }
      }
      if (state.report?.shows && state.report?.missing && state.report.lastScan) {
        const remoteReport = {
          ...state.report,
          shows: compactLibrary(state.report.shows),
          missing: compactMissing(state.report.missing),
        };
        setShows(remoteReport.shows); setMissing(remoteReport.missing); setLastScan(remoteReport.lastScan); setSettingsOpen(false);
        setScanCache(state.report.scanCache || {}); setLastActivity(state.report.activity || "");
        try { localStorage.setItem(REPORT_CACHE, JSON.stringify(remoteReport)); } catch { /* retain server copy */ }
      }
      if (state.checkpoint?.library?.length && state.checkpoint.completed.length < state.checkpoint.library.length) {
        const remoteCheckpoint = { ...state.checkpoint, library: compactLibrary(state.checkpoint.library) };
        setShows(remoteCheckpoint.library); setProcessed(remoteCheckpoint.completed.length); setTotal(remoteCheckpoint.library.length);
        setPending(remoteCheckpoint.library.length - remoteCheckpoint.completed.length);
        setMissing(compactMissing(Object.values(remoteCheckpoint.results || {}).flat()));
        try { localStorage.setItem(CHECKPOINT_CACHE, JSON.stringify(remoteCheckpoint)); } catch { /* retain server copy */ }
      }
    }).catch(() => { /* local browser copy remains available */ });
  }, []);

  function syncServerState(patch: Partial<ServerState>, immediate = false) {
    pendingServerPatchRef.current = { ...pendingServerPatchRef.current, ...patch };
    const send = () => {
      serverSyncTimerRef.current = null;
      const body = pendingServerPatchRef.current;
      pendingServerPatchRef.current = {};
      void fetch("/api/state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => { /* the browser copy remains available for retry */ });
    };
    if (immediate) {
      if (serverSyncTimerRef.current !== null) window.clearTimeout(serverSyncTimerRef.current);
      send();
    } else if (serverSyncTimerRef.current === null) {
      serverSyncTimerRef.current = window.setTimeout(send, 3000);
    }
  }

  function logDebug(event: string, details: Record<string, unknown> = {}) {
    if (!debugEnabledRef.current) return;
    try {
      const entries = JSON.parse(localStorage.getItem(DEBUG_LOG_CACHE) || "[]") as unknown[];
      entries.push({ timestamp: new Date().toISOString(), event, ...details });
      localStorage.setItem(DEBUG_LOG_CACHE, JSON.stringify(entries.slice(-500)));
    } catch { /* diagnostics must never interrupt a scan */ }
  }

  function setDiagnostics(enabled: boolean) {
    setDebugEnabled(enabled);
    debugEnabledRef.current = enabled;
    localStorage.setItem(DEBUG_ENABLED_CACHE, String(enabled));
    if (enabled) logDebug("diagnostics.enabled", { location: window.location.href });
  }

  function downloadDebugLog() {
    const entries = JSON.parse(localStorage.getItem(DEBUG_LOG_CACHE) || "[]") as unknown[];
    const contents = entries.map((entry) => JSON.stringify(entry)).join("\n") || JSON.stringify({ timestamp: new Date().toISOString(), event: "diagnostics.empty" });
    const url = URL.createObjectURL(new Blob([`${contents}\n`], { type: "application/x-ndjson" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `shelfcheck-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function clearDebugLog() {
    localStorage.removeItem(DEBUG_LOG_CACHE);
    logDebug("diagnostics.cleared");
  }

  const ignoredIds = useMemo(() => new Set(ignoredShows.map((show) => show.ids.trakt)), [ignoredShows]);
  const visibleMissing = useMemo(() => missing.filter((item) => !ignoredIds.has(item.show.ids.trakt)), [missing, ignoredIds]);

  const grouped = useMemo(() => {
    const map = new Map<number, { show: TraktShow; episodes: MissingEpisode[] }>();
    visibleMissing.filter((item) => item.show.title.toLowerCase().includes(query.toLowerCase())).forEach((item) => {
      const current = map.get(item.show.ids.trakt) || { show: item.show, episodes: [] };
      current.episodes.push(item);
      map.set(item.show.ids.trakt, current);
    });
    return [...map.values()].sort((a, b) => {
      if (sortField === "title") {
        const result = a.show.title.localeCompare(b.show.title);
        return sortAscending ? result : -result;
      }
      const aPercent = a.show.collection?.aired ? (a.show.collection.completed / a.show.collection.aired) * 100 : 0;
      const bPercent = b.show.collection?.aired ? (b.show.collection.completed / b.show.collection.aired) * 100 : 0;
      const result = aPercent - bPercent || a.show.title.localeCompare(b.show.title);
      return sortAscending ? result : -result;
    });
  }, [visibleMissing, query, sortField, sortAscending]);

  function chooseSort(field: "title" | "percent") {
    if (field === sortField) setSortAscending((ascending) => !ascending);
    else {
      setSortField(field);
      setSortAscending(field === "title");
    }
    setSortMenuOpen(false);
  }

  function ignoreShow(show: TraktShow) {
    setIgnoredShows((current) => {
      const next = [...current.filter((item) => item.ids.trakt !== show.ids.trakt), compactShow(show)].sort((a, b) => a.title.localeCompare(b.title));
      persistIgnoredShows(next);
      syncServerState({ ignoredShows: next }, true);
      return next;
    });
    setOpenShowMenu(null);
  }

  function restoreShow(traktId: number) {
    setIgnoredShows((current) => {
      const next = current.filter((show) => show.ids.trakt !== traktId);
      persistIgnoredShows(next);
      syncServerState({ ignoredShows: next }, true);
      return next;
    });
  }

  async function saveCredentials() {
    if (!clientId.trim() || !token.trim()) {
      setError("Enter both your Trakt client ID and access token.");
      return;
    }
    const nextClientId = clientId.trim();
    const nextToken = token.trim();
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: nextClientId, accessToken: nextToken }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "Shelfcheck could not save the Trakt configuration.");
      }
      setClientId("");
      setToken("");
      localStorage.removeItem("shelfcheck-trakt");
      setConnected(true);
      setSettingsOpen(false);
      setError("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Shelfcheck could not save the Trakt configuration.");
    }
  }

  const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function pauseForRateLimit() {
    const now = Date.now();
    if (networkPauseUntilRef.current <= now) {
      networkPauseUntilRef.current = now + 120_000;
      setRateLimitPaused(true);
      logDebug("request.rate-limit-pause", { status: 403, pauseMs: 120000 });
    }
    const pauseUntil = networkPauseUntilRef.current;
    await wait(Math.max(0, pauseUntil - Date.now()));
    if (Date.now() >= networkPauseUntilRef.current) {
      setRateLimitPaused(false);
      logDebug("request.rate-limit-resume", { status: 403 });
    }
  }

  async function waitForRequestSlot() {
    let release!: () => void;
    const previous = requestGateRef.current;
    requestGateRef.current = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const scheduledAt = Math.max(nextRequestAtRef.current, networkPauseUntilRef.current);
      const delay = Math.max(0, scheduledAt - Date.now());
      if (delay) await wait(delay);
      // Six workers may remain in flight, but request starts are paced to
      // avoid the simultaneous bursts that Trakt/Cloudflare drops.
      nextRequestAtRef.current = Date.now() + 300;
    } finally { release(); }
  }

  async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try { return await fetch(input, { ...init, signal: controller.signal }); }
    finally { window.clearTimeout(timeout); }
  }

  async function traktRequest(input: string | URL): Promise<Response> {
    const isInitialRequest = !connectionValidatedRef.current;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitForRequestSlot();
      const requestStarted = Date.now();
      try {
        const upstream = new URL(input.toString());
        logDebug("request.start", { path: `${upstream.pathname}${upstream.search}`, attempt: attempt + 1 });
        const proxyRequest = () => fetchWithTimeout(`/api/trakt?path=${encodeURIComponent(`${upstream.pathname}${upstream.search}`)}`, {
        });
        const response = await proxyRequest();
        logDebug("request.response", { path: `${upstream.pathname}${upstream.search}`, attempt: attempt + 1, status: response.status, elapsedMs: Date.now() - requestStarted });
        networkFailuresRef.current = 0;
        if (isInitialRequest) {
          if (response.ok) {
            connectionValidatedRef.current = true;
            logDebug("request.connection-validated", { path: `${upstream.pathname}${upstream.search}`, status: response.status });
          }
          return response;
        }
        if (response.status === 401) return response;
        if (response.status === 403) {
          if (attempt === 4) return response;
          await pauseForRateLimit();
          continue;
        }
        if (response.status === 429) {
          if (attempt === 4) throw new Error("Trakt’s rate limit was reached repeatedly. Wait a few minutes, then scan again.");
          const retryAfter = Number(response.headers.get("Retry-After"));
          await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1));
          continue;
        }
        if (response.status >= 500 && attempt < 4) {
          await wait(1000 * 2 ** attempt);
          continue;
        }
        return response;
      } catch (requestError) {
        const upstream = new URL(input.toString());
        logDebug("request.error", { path: `${upstream.pathname}${upstream.search}`, attempt: attempt + 1, elapsedMs: Date.now() - requestStarted, error: requestError instanceof Error ? requestError.message : String(requestError) });
        if (isInitialRequest) {
          throw new Error("Shelfcheck could not establish the initial connection to Trakt. The scan was stopped before processing any shows.");
        }
        if (requestError instanceof Error && requestError.message === "Failed to fetch") {
          networkFailuresRef.current += 1;
          if (networkFailuresRef.current >= 3) {
            networkPauseUntilRef.current = Math.max(networkPauseUntilRef.current, Date.now() + 30_000);
            logDebug("request.circuit-breaker", { pauseMs: 30000, consecutiveFailures: networkFailuresRef.current });
          }
        }
        if (requestError instanceof Error && requestError.message.includes("rate limit")) throw requestError;
        if (attempt === 4) throw new Error("Shelfcheck could not keep a stable connection to Trakt after several retries. Your previous report is still saved.");
        await wait(1000 * 2 ** attempt);
      }
    }
    throw new Error("The Trakt request could not be completed.");
  }

  async function traktFetch<T>(path: string): Promise<T> {
    const response = await traktRequest(`${TRAKT}${path}`);
    if (response.status === 401) throw new Error("Trakt rejected the access token. Check your credentials and try again.");
    if (response.status === 403) throw new Error("Trakt rejected this request (403). Make sure the access token was created with the same Trakt application as the Client ID.");
    if (response.status === 429) throw new Error("Trakt’s rate limit was reached. Wait a minute, then scan again.");
    if (!response.ok) throw new Error(`Trakt request failed (${response.status}).`);
    return response.json();
  }

  async function traktFetchAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    let pageCount = 1;
    do {
      const url = new URL(`${TRAKT}${path}`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", "100");
      const response = await traktRequest(url);
      if (response.status === 401) throw new Error("Trakt rejected the access token. Check your credentials and try again.");
      if (response.status === 403) throw new Error("Trakt rejected this request (403). Make sure the access token was created with the same Trakt application as the Client ID.");
      if (response.status === 429) throw new Error("Trakt’s rate limit was reached. Wait a minute, then scan again.");
      if (!response.ok) throw new Error(`Trakt request failed (${response.status}).`);
      const batch = await response.json() as T[];
      items.push(...batch);
      const headerCount = Number(response.headers.get("X-Pagination-Page-Count"));
      pageCount = Number.isFinite(headerCount) && headerCount > 0 ? headerCount : (batch.length === 100 ? page + 1 : page);
      page += 1;
    } while (page <= pageCount && page <= 100);
    return items;
  }

  async function scanLibrary() {
    if (!connected) { setSettingsOpen(true); return; }
    connectionValidatedRef.current = false;
    networkFailuresRef.current = 0;
    networkPauseUntilRef.current = 0;
    setScanning(true); setRateLimitPaused(false); setError(""); setProgress(0); setPending(0);
    logDebug("scan.start", { cachedShows: shows.length, pending });
    try {
      // Gate the scan on one completed request. This prevents resumed scans
      // from starting multiple workers before the Trakt connection is known-good.
      logDebug("scan.connection-validating");
      const initialActivity = await traktFetch<unknown>("/sync/last_activities");
      let savedCheckpoint: ScanCheckpoint | null = null;
      try { savedCheckpoint = JSON.parse(localStorage.getItem(CHECKPOINT_CACHE) || "null") as ScanCheckpoint | null; }
      catch { /* ignore invalid checkpoint data */ }
      // Resume from browser storage immediately. Otherwise, last activities
      // lets an unchanged collection avoid even downloading the full library.
      let library: CollectionShow[];
      let activity = lastActivity;
      let freshFingerprints: Record<string, string> | null = null;
      if (savedCheckpoint?.library?.length && savedCheckpoint.completed.length < savedCheckpoint.library.length) {
        library = savedCheckpoint.library;
      } else {
        activity = collectionActivityMarker(initialActivity);
        if (shows.length && activity && activity === lastActivity) {
          library = shows;
        } else {
          try {
            const downloaded = await traktFetchAll<CollectionShow>("/sync/collection/shows?extended=full,images");
            freshFingerprints = Object.fromEntries(downloaded.map((item) => [String(item.show.ids.trakt), collectionFingerprint(item)]));
            const previousShows = new Map(shows.map((item) => [item.show.ids.trakt, item.show]));
            library = downloaded.map((item) => ({ show: { ...previousShows.get(item.show.ids.trakt), ...item.show } }));
          } catch (libraryError) {
            if (!shows.length) throw libraryError;
            library = shows;
            activity = lastActivity;
          }
        }
      }
      library = compactLibrary(library);
      setShows(library); setTotal(library.length);
      logDebug("scan.library-ready", { shows: library.length, resumed: Boolean(savedCheckpoint?.library?.length) });
      const signature = library.map(({ show }) => show.ids.trakt).sort((a, b) => a - b).join(",");
      let checkpoint: ScanCheckpoint;
      if (savedCheckpoint?.signature === signature && savedCheckpoint.completed.length < savedCheckpoint.library.length) {
        checkpoint = { ...savedCheckpoint, library };
      } else {
        const priorResults = new Map<number, MissingEpisode[]>();
        for (const result of missing) {
          const id = result.show.ids.trakt;
          priorResults.set(id, [...(priorResults.get(id) || []), result]);
        }
        const now = Date.now();
        const completedFromCache: number[] = [];
        const resultsFromCache: Record<string, MissingEpisode[]> = {};
        const nextCache: ScanCache = {};
        for (const item of library) {
          const id = String(item.show.ids.trakt);
          const cached = scanCache[id];
          const fingerprintChanged = freshFingerprints !== null && freshFingerprints[id] !== cached?.fingerprint;
          const dueAt = cached ? Date.parse(cached.nextCheckAt || "") : Number.NaN;
          const due = cached ? !Number.isFinite(dueAt) || dueAt <= now : true;
          if (!cached || fingerprintChanged || due) continue;
          completedFromCache.push(item.show.ids.trakt);
          resultsFromCache[id] = priorResults.get(item.show.ids.trakt) || [];
          nextCache[id] = cached;
        }
        checkpoint = { signature, library, completed: completedFromCache, results: resultsFromCache, activity, scanCache: nextCache };
      }
      checkpoint.scanCache ||= {};
      const completed = new Set(checkpoint.completed);
      const completedAtStart = completed.size;
      const queue = library.filter(({ show }) => !completed.has(show.ids.trakt));
      let cursor = 0;
      const failed: CollectionShow[] = [];
      setProcessed(completed.size);
      setMissing(Object.values(checkpoint.results).flat());
      const saveCheckpoint = () => {
        checkpoint.completed = [...completed];
        setMissing(Object.values(checkpoint.results).flat());
        setProcessed(completed.size);
        setProgress(Math.round((completed.size / Math.max(library.length, 1)) * 100));
        try {
          localStorage.removeItem(CHECKPOINT_CACHE);
          localStorage.setItem(CHECKPOINT_CACHE, JSON.stringify(checkpoint));
        } catch (storageError) {
          logDebug("checkpoint.storage-error", { error: storageError instanceof Error ? storageError.message : String(storageError), completed: completed.size, total: library.length });
        }
        syncServerState({ checkpoint });
      };
      const scanOne = async (item: CollectionShow) => {
        const showStarted = Date.now();
        logDebug("show.start", { traktId: item.show.ids.trakt, title: item.show.title, completed: completed.size, total: library.length });
        const data = await traktFetch<{ aired?: number; completed?: number; seasons?: ProgressSeason[]; next_episode?: { first_aired?: string } | null }>(`/shows/${item.show.ids.trakt}/progress/collection?hidden=false&specials=false&count_specials=false&extended=full`);
        const aired = data.aired ?? (data.seasons || []).reduce((sum, season) => sum + (season.number === 0 ? 0 : season.episodes.length), 0);
        const collected = data.completed ?? (data.seasons || []).reduce((sum, season) => sum + (season.number === 0 ? 0 : season.episodes.filter((episode) => episode.completed).length), 0);
        item.show = { ...item.show, collection: { aired, completed: collected } };
        const showResults: MissingEpisode[] = [];
        for (const season of data.seasons || []) {
          if (season.number === 0) continue;
          for (const episode of season.episodes || []) if (!episode.completed) showResults.push({ show: item.show, season: season.number, episode: episode.number });
        }
        if (showResults.length) {
          const details = await traktFetch<TraktShow>(`/shows/${item.show.ids.trakt}?extended=full,images`).catch(() => null);
          if (details?.images?.poster?.length) item.show = { ...item.show, images: { poster: [details.images.poster[0]] } };
          showResults.forEach((result) => { result.show = item.show; });
        }
        checkpoint.results[String(item.show.ids.trakt)] = showResults;
        const checkedAt = new Date();
        const fallback = fallbackDueAt(item.show, checkedAt);
        const nextAiring = data.next_episode?.first_aired ? Date.parse(data.next_episode.first_aired) : Number.NaN;
        checkpoint.scanCache![String(item.show.ids.trakt)] = {
          fingerprint: freshFingerprints?.[String(item.show.ids.trakt)] ?? scanCache[String(item.show.ids.trakt)]?.fingerprint ?? "",
          lastCheckedAt: checkedAt.toISOString(),
          nextCheckAt: new Date(Number.isFinite(nextAiring) ? Math.min(nextAiring + 2 * 60 * 60 * 1000, fallback) : fallback).toISOString(),
        };
        completed.add(item.show.ids.trakt);
        saveCheckpoint();
        logDebug("show.complete", { traktId: item.show.ids.trakt, title: item.show.title, missing: showResults.length, elapsedMs: Date.now() - showStarted, completed: completed.size, total: library.length });
      };
      const worker = async () => {
        while (cursor < queue.length) {
          const item = queue[cursor++];
          try { await scanOne(item); }
          catch (scanError) {
            logDebug("show.error", { traktId: item.show.ids.trakt, title: item.show.title, error: scanError instanceof Error ? scanError.message : String(scanError), completed: completed.size, total: library.length });
            // If even the first show is rejected, continuing would leave the
            // interface at 0 while repeating the same failure hundreds of times.
            if (completed.size === completedAtStart) throw scanError;
            failed.push(item);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, queue.length || 1) }, worker));
      for (const item of failed) {
        if (completed.has(item.show.ids.trakt)) continue;
        await wait(3000);
        try { await scanOne(item); } catch { /* saved for the next resume */ }
      }
      const results = Object.values(checkpoint.results).flat();
      results.sort((a, b) => a.show.title.localeCompare(b.show.title) || a.season - b.season || a.episode - b.episode);
      const remaining = library.length - completed.size;
      setPending(remaining);
      if (remaining) throw new Error(`${completed.size} of ${library.length} shows are safely saved. ${remaining} ${remaining === 1 ? "show is" : "shows are"} waiting to retry; select Resume scan to continue.`);
      const scanTime = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      setMissing(results);
      setLastScan(scanTime);
      const report: ScanReport = { shows: compactLibrary(library), missing: compactMissing(results), lastScan: scanTime, activity, scanCache: checkpoint.scanCache };
      localStorage.setItem(REPORT_CACHE, JSON.stringify(report));
      localStorage.removeItem(CHECKPOINT_CACHE);
      syncServerState({ report, checkpoint: null }, true);
      setScanCache(checkpoint.scanCache || {}); setLastActivity(activity);
      setPending(0);
    } catch (e) {
      logDebug("scan.error", { error: e instanceof Error ? e.message : String(e), processed, total });
      setError(e instanceof Error ? e.message : "The scan could not be completed.");
    } finally { setScanning(false); setRateLimitPaused(false); }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#"><span className="brandmark">S</span><span>Shelfcheck</span></a>
        <div className="header-actions">
          <span className={`status ${connected ? "online" : ""}`}><i />{connected ? "Trakt connected" : "Not connected"}</span>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Trakt settings">⚙</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">TRAKT COLLECTION AUDIT</p>
          <h1>Find the gaps in<br />your collection.</h1>
          <p className="intro">Shelfcheck compares every collected show against Trakt’s aired episode list, then gives you one clean report of what’s missing.</p>
        </div>
        <div className="scan-panel">
          <div className="radar"><span>{scanning ? `${progress}%` : visibleMissing.length}</span><small>{rateLimitPaused ? "PAUSED - RATE LIMIT" : scanning ? "SCANNING" : "MISSING"}</small></div>
          <button className="primary" onClick={scanLibrary} disabled={scanning}>{rateLimitPaused ? "Paused - Rate Limit" : scanning ? `Checking ${processed} of ${total || shows.length}…` : pending ? `Resume scan (${pending} left)` : lastScan ? "Scan again" : "Scan Trakt library"}<b>→</b></button>
          <p>{lastScan ? `Last scan ${lastScan} · Incremental scan beta` : "Only your collection metadata is read. Incremental scanning is beta."}</p>
        </div>
      </section>

      <div className="summary-wrap">
        <section className="summary" aria-label="Scan summary">
          <div><span>COLLECTED SHOWS</span><strong>{shows.length || "—"}</strong></div>
          <div><span>MISSING EPISODES</span><strong>{lastScan ? visibleMissing.length : "—"}</strong></div>
          <div><span>SHOWS WITH GAPS</span><strong>{lastScan ? grouped.length : "—"}</strong></div>
          <div className="ignored-stat"><button type="button" onClick={() => setIgnoredManagerOpen((open) => !open)}><span>IGNORED SHOWS ↗</span><strong>{ignoredShows.length}</strong></button></div>
          <div className="health"><span>COLLECTION STATUS</span><strong>{!lastScan ? "Not scanned" : visibleMissing.length ? "Needs attention" : "Complete"}</strong></div>
        </section>
        {ignoredManagerOpen && <section className="ignored-manager" aria-label="Ignored shows">
          <div><h3>Ignored shows ({ignoredShows.length})</h3><button type="button" onClick={() => setIgnoredManagerOpen(false)} aria-label="Close ignored shows">×</button></div>
          {ignoredShows.length === 0 ? <p>No shows are ignored.</p> : ignoredShows.map((show) => <div className="ignored-row" key={show.ids.trakt}><span>{show.title}</span><button type="button" onClick={() => restoreShow(show.ids.trakt)}>Restore</button></div>)}
        </section>}
      </div>

      <section className="report">
        <div className="report-heading">
          <div><p className="eyebrow">MISSING REPORT</p><h2>{!lastScan ? "Ready when you are" : visibleMissing.length ? `${visibleMissing.length} episodes to find` : "Your collection is complete"}</h2></div>
          {lastScan && visibleMissing.length > 0 && <div className="report-controls">
            <label className="search">⌕<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter shows" /></label>
            <div className="sort-control">
              <button type="button" className="sort-trigger" onClick={() => setSortMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={sortMenuOpen}>
                <span>{sortField === "title" ? "By title" : "By percent collected"}</span><b aria-label={sortAscending ? "Ascending" : "Descending"}>{sortAscending ? "▲" : "▼"}</b>
              </button>
              {sortMenuOpen && <div className="sort-menu" role="menu">
                <button type="button" role="menuitem" className={sortField === "title" ? "selected" : ""} onClick={() => chooseSort("title")}><span>Title</span><b>{sortField === "title" ? (sortAscending ? "↑" : "↓") : ""}</b></button>
                <button type="button" role="menuitem" className={sortField === "percent" ? "selected" : ""} onClick={() => chooseSort("percent")}><span>Percent collected</span><b>{sortField === "percent" ? (sortAscending ? "↑" : "↓") : ""}</b></button>
              </div>}
            </div>
          </div>}
        </div>
        {error && <div className="error"><span>!</span><p><strong>Scan interrupted</strong>{error}</p></div>}
        {!lastScan && !scanning && !error && <div className="empty"><div>✓</div><h3>No report yet</h3><p>Connect Trakt and run your first scan. Shelfcheck will list every aired episode missing from your collection.</p></div>}
        {scanning && <div className="loading"><span style={{ width: `${progress}%` }} /><p>{rateLimitPaused ? "Paused - Rate Limit. Scanning will resume automatically in two minutes." : `Comparing show ${processed} of ${total || shows.length || "…"}. Every completed show is saved automatically.`}</p></div>}
        {lastScan && grouped.length > 0 && <div className="show-list">{grouped.map(({ show, episodes }) => {
          const percentCollected = show.collection?.aired ? Math.round((show.collection.completed / show.collection.aired) * 100) : null;
          return <article key={show.ids.trakt}>
          <div className="collection-percent"><strong>{percentCollected === null ? "—" : `${percentCollected}%`}</strong><span>COLLECTED</span></div>
          <div className="show-index">
            <span>{show.title.slice(0, 2).toUpperCase()}</span>
            {show.images?.poster?.[0] && <img
              src={`/api/poster?src=${encodeURIComponent(show.images.poster[0])}`}
              alt={`${show.title} poster`}
              loading="lazy"
              onError={(event) => { event.currentTarget.style.display = "none"; }}
            />}
          </div>
          <div className="show-info">
            <div className="show-title-line">
              <button className="show-name-button" type="button" onClick={() => setOpenShowMenu((current) => current === show.ids.trakt ? null : show.ids.trakt)} aria-expanded={openShowMenu === show.ids.trakt}>{show.title}</button>
              <small>{show.year}</small>
              <a className="brand-link" href={`https://app.trakt.tv/shows/${show.ids.slug}`} target="_blank" rel="noreferrer" aria-label={`Open ${show.title} on Trakt`} title="View on Trakt"><img src="/trakt-logomark.svg" alt="" /></a>
              {show.ids.tmdb && <a className="brand-link" href={`https://www.themoviedb.org/tv/${show.ids.tmdb}`} target="_blank" rel="noreferrer" aria-label={`Open ${show.title} on The Movie Database`} title="View on TMDB"><img src="/tmdb-blue-square.svg" alt="" /></a>}
            </div>
            {openShowMenu === show.ids.trakt && <div className="show-action-menu"><button type="button" onClick={() => ignoreShow(show)}>⊘ <span>Ignore this show</span></button></div>}
            <div className="show-links-row"><p>{episodes.length} missing {episodes.length === 1 ? "episode" : "episodes"}</p></div>
            <div className="episode-tags">{episodes.map((ep) => <a
            key={`${ep.season}-${ep.episode}`}
            href={`https://app.trakt.tv/shows/${show.ids.slug}?season=${ep.season}&view=episode&episode=${ep.episode}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${show.title} season ${ep.season} episode ${ep.episode} on Trakt`}
          >S{String(ep.season).padStart(2,"0")}E{String(ep.episode).padStart(2,"0")}<b aria-hidden="true">↗</b></a>)}</div>
          </div>
        </article>})}</div>}
      </section>

      <footer><span>SHELFCHECK / TRAKT API</span><span>Your credentials stay in your private configuration volume.</span></footer>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(e) => e.currentTarget === e.target && (connected || Boolean(lastScan)) && setSettingsOpen(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button className="close" onClick={() => setSettingsOpen(false)} disabled={!connected && !lastScan} aria-label="Close">×</button>
          <p className="eyebrow">CONNECTION</p><h2 id="settings-title">Connect your Trakt library</h2>
          <p className="modal-copy">Use your Trakt application client ID and access token. They are stored in /config/config.yml and never returned to the browser.</p>
          <label>Client ID<input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Your Trakt application client ID" autoComplete="off" data-lpignore="true" /></label>
          <label>Access token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Your OAuth access token" autoComplete="off" data-lpignore="true" /></label>
          {error && <p className="field-error">{error}</p>}
          <button className="primary full" onClick={saveCredentials}>Save and connect <b>→</b></button>
          <div className="diagnostics">
            <label className="diagnostics-toggle"><input type="checkbox" checked={debugEnabled} onChange={(event) => setDiagnostics(event.target.checked)} /> Enable diagnostic logging</label>
            <p>Records safe scan details in this browser. Credentials and authorization headers are never logged.</p>
            <div><button type="button" onClick={downloadDebugLog}>Download log</button><button type="button" onClick={clearDebugLog}>Clear log</button></div>
          </div>
          <a className="help-link" href="https://trakt.tv/oauth/applications" target="_blank" rel="noreferrer">Create or view a Trakt application ↗</a>
        </section>
      </div>}
    </main>
  );
}
