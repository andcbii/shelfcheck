"use client";

/* Poster and provider logos intentionally use native images with an app-owned proxy. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { resultsView } from "@/lib/results-view";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { DiagnosticLogActions } from "@/app/components/diagnostic-log-actions";
import { IgnoredShowsManager } from "@/app/components/ignored-shows-manager";
import { IgnoreDurationModal } from "@/app/components/ignore-duration-modal";
import { ScanSortControl } from "@/app/components/scan-sort-control";
import { SeasonIgnoreModal } from "@/app/components/season-ignore-modal";
import { ShowActionsMenu } from "@/app/components/show-actions-menu";
import { ScanProgressBox } from "@/app/components/scan-progress-box";
import { compactMissingEpisodes, compactTraktLibrary, compactTraktShow, traktLocalAirDate, type CollectionShow, type MissingEpisode, type TraktShow } from "@/lib/trakt-model";
import { scanProgressPercent } from "@/lib/scan-progress";
import { useScanPoller } from "@/app/hooks/use-scan-poller";
import { useScanRunActivity } from "@/app/hooks/use-scan-run-activity";
import type { ScanProgressStatus } from "@/lib/scan-run-activity";
import { useIgnoreClock } from "@/app/hooks/use-ignore-clock";
import { useLocalToday } from "@/app/hooks/use-local-today";
import { useClearCache } from "@/app/hooks/use-clear-cache";
import { useMenuClosing } from "@/app/hooks/use-menu-closing";
import { activeIgnores, applyIgnore, changeIgnoreDuration as changeIgnoreRuleDuration, decodeTraktManagerKey, ignoreManagerKey, openSeasonIgnore as openSeasonIgnoreRule, restoreIgnore, saveSeasonIgnore, type IgnoreDuration, type IgnoreTiming } from "@/lib/ignored-shows";

type ScanReport = { shows: CollectionShow[]; missing: MissingEpisode[]; lastScan: string; scanCache?: Record<string, unknown> };
type ScanStatus = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; error?: string } & ScanProgressStatus;
// A Trakt scan checks up to six shows at once.
const TRAKT_ACTIVE_SHOWS = 6;
type IgnoredTraktShow = TraktShow & IgnoreTiming;
type IgnoredTraktSeasons = { traktId: number; title: string; seasons: number[] } & IgnoreTiming;
const traktShowKey = (show: TraktShow) => show.ids.trakt;
const traktSeasonsKey = (rule: { traktId: number }) => rule.traktId;
type ServerState = {
  report?: ScanReport;
  ignoredShows?: IgnoredTraktShow[];
  ignoredSeasons?: IgnoredTraktSeasons[];
  scan?: ScanStatus;
  diagnosticsEnabled?: boolean;
  airingGraceDays?: number;
};

function formatLastScan(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

const SAVE_SETTINGS_ERROR = "Shelfcheck could not save the settings.";

// The saved whole-show Ignore list, compacted as the page holds it; a missing list is empty.
function savedIgnoredShows(state: ServerState): IgnoredTraktShow[] {
  return Array.isArray(state.ignoredShows) ? state.ignoredShows.map((show) => ({ ...compactTraktShow(show), expiresAt: show.expiresAt, duration: show.duration })) : [];
}

// The saved season Ignore list; a missing list is empty.
function savedIgnoredSeasons(state: ServerState): IgnoredTraktSeasons[] {
  return Array.isArray(state.ignoredSeasons) ? state.ignoredSeasons : [];
}

// Trakt's own collection percent (completed ÷ aired), whatever the page filters out.
function traktPercent(show: TraktShow): number {
  return show.collection?.aired ? (show.collection.completed / show.collection.aired) * 100 : 0;
}

// One missing episode's identity: its show, season and episode number.
function episodeKey(episode: MissingEpisode): string {
  return `${episode.show.ids.trakt}:${episode.season}:${episode.episode}`;
}

// What a whole-show Ignore removed, so a rejected save can undo only that.
type IgnoredShowResults = {
  traktId: number;
  invalidations: Set<number>;
  revision: number;
  wasInvalidated: boolean;
  removedShows: CollectionShow[];
  removedMissing: MissingEpisode[];
  removedCacheKey: boolean;
};

function pruneClientReport(report: ScanReport, invalidated: Set<number>): ScanReport {
  return {
    ...report,
    shows: compactTraktLibrary(report.shows).filter((item) => !invalidated.has(item.show.ids.trakt)),
    missing: compactMissingEpisodes(report.missing).filter((episode) => !invalidated.has(episode.show.ids.trakt)),
    scanCache: Object.fromEntries(Object.entries(report.scanCache || {}).filter(([key]) => !invalidated.has(Number(key)))),
  };
}

export default function Home() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [connected, setConnected] = useState(false);
  const [applicationConfigured, setApplicationConfigured] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [shows, setShows] = useState<CollectionShow[]>([]);
  const [missing, setMissing] = useState<MissingEpisode[]>([]);
  const [error, setError] = useState("");
  const [errorContext, setErrorContext] = useState<"scan" | "auth">("scan");
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [debugEnabled, setDebugEnabled] = useState(true);
  const [airingGraceDays, setAiringGraceDays] = useState(0);
  const [ignoredShows, setIgnoredShows] = useState<IgnoredTraktShow[]>([]);
  const [ignoredSeasons, setIgnoredSeasons] = useState<IgnoredTraktSeasons[]>([]);
  const [openShowMenu, setOpenShowMenu] = useState<number | null>(null);
  const [showToIgnore, setShowToIgnore] = useState<TraktShow | null>(null);
  const [seasonIgnoreShow, setSeasonIgnoreShow] = useState<TraktShow | null>(null);
  const [seasonIgnoreDraft, setSeasonIgnoreDraft] = useState<number[]>([]);
  const [seasonIgnoreOptions, setSeasonIgnoreOptions] = useState<number[]>([]);
  const [seasonIgnoreDuration, setSeasonIgnoreDuration] = useState<IgnoreDuration>("forever");
  const [seasonIgnoreOriginalTiming, setSeasonIgnoreOriginalTiming] = useState<IgnoreTiming | null>(null);
  const [ignoredManagerOpen, setIgnoredManagerOpen] = useState(false);
  const [sortField, setSortField] = useState<"title" | "percent">("title");
  const [sortAscending, setSortAscending] = useState(true);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [collapsedShows, setCollapsedShows] = useState<Set<number>>(new Set());
  const [collapsedSeasons, setCollapsedSeasons] = useState<Set<string>>(new Set());
  const [fullRescanConfirmOpen, setFullRescanConfirmOpen] = useState(false);
  const [rateLimitPaused, setRateLimitPaused] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgressStatus>({});
  const [scanCacheCount, setScanCacheCount] = useState(0);
  // Restoring a show does not make responses from this scan safe to reuse.
  const reportInvalidations = useRef(new Set<number>());
  const loadedCacheKeys = useRef(new Set<string>());
  // Counts same-scan report replacements and cache clears; a new scan replaces
  // reportInvalidations instead. Either one makes a captured report snapshot stale.
  const reportRevision = useRef(0);
  // One generation for both Ignore lists; diagnostics and grace-period saves take none.
  const ignoreSaves = useRef(0);
  const scanRequestPending = useRef(false);
  const scanInProgress = useRef(false);
  const { poll: pollServerScan, abort: abortScanPoll } = useScanPoller<{ scan: ScanStatus }>({
    url: "/api/scan",
    onPollingChange: (polling) => { scanInProgress.current = polling; setScanning(polling); },
    onResponse: async ({ scan }) => {
      showScanStatus(scan);
      if (scan.status === "completed") { await loadServerReport(); setRateLimitPaused(false); return true; }
      if (scan.status === "error") { setRateLimitPaused(false); throw new Error(scan.error || "The server-side scan failed."); }
      return false;
    },
  });
  // Shows a status's counts, pause and progress detail, whether polled or from the saved state.
  function showScanStatus(scan: ScanStatus) {
    setProcessed(scan.processed);
    setTotal(scan.total);
    setRateLimitPaused(scan.rateLimitPaused === true);
    setScanProgress(scan);
    setProgress(scanProgressPercent(scan.processed, scan.total, scan.status === "running"));
  }
  const activity = useScanRunActivity("trakt", {
    isFollowing: () => scanInProgress.current || scanRequestPending.current,
    poll: () => pollServerScan().catch((pollError) => {
      if (!(pollError instanceof DOMException && pollError.name === "AbortError")) setError(pollError instanceof Error ? pollError.message : "Shelfcheck could not resume scan progress.");
    }),
  });

  useEffect(() => {
    void fetch("/api/config", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const status = await response.json() as { connected: boolean; applicationConfigured: boolean };
      setConnected(status.connected);
      setApplicationConfigured(status.applicationConfigured);
      if (status.connected) setSettingsOpen(false);
    }).catch(() => { /* settings remain open when configuration cannot be read */ });
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (authError) queueMicrotask(() => { setErrorContext("auth"); setError(authError); });
    if (params.has("trakt") || authError) window.history.replaceState({}, "", window.location.pathname);

    const initialInvalidations = reportInvalidations.current;
    void fetch("/api/state", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const { state } = await response.json() as { state: ServerState | null };
      if (!state) {
        // This write carries Ignore lists, so it supersedes any earlier Ignore save.
        ignoreSaves.current++;
        syncServerState({ ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0 });
        return;
      }
      setDebugEnabled(state.diagnosticsEnabled !== false);
      setAiringGraceDays(Math.max(0, Math.min(30, Math.trunc(Number(state.airingGraceDays) || 0))));
      // Start-up keeps the browser's list when the saved state has none.
      if (Array.isArray(state.ignoredShows)) {
        const remoteIgnored = savedIgnoredShows(state);
        for (const show of activeIgnores(remoteIgnored)) initialInvalidations.add(show.ids.trakt);
        setIgnoredShows(remoteIgnored);
      }
      if (Array.isArray(state.ignoredSeasons)) setIgnoredSeasons(savedIgnoredSeasons(state));
      if (state.report?.shows && state.report?.missing && state.report.lastScan && initialInvalidations === reportInvalidations.current) {
        const remoteReport = pruneClientReport(state.report, initialInvalidations);
        setShows(remoteReport.shows); setMissing(remoteReport.missing); setLastScan(remoteReport.lastScan); setSettingsOpen(false);
        replaceReportCache(new Set(Object.keys(remoteReport.scanCache || {})));
      }
      if (state.scan?.status === "running") {
        showScanStatus(state.scan);
        void pollServerScan().catch((pollError) => {
          if (!(pollError instanceof DOMException && pollError.name === "AbortError")) setError(pollError instanceof Error ? pollError.message : "Shelfcheck could not resume scan progress.");
        });
      }
    }).catch(() => { /* local browser copy remains available */ });
    return () => {
      abortScanPoll();
    };
  }, [abortScanPoll, pollServerScan]);

  useMenuClosing([
    { open: sortMenuOpen, isInside: (target) => target.closest('[data-menu-root="sort"]') !== null, close: () => setSortMenuOpen(false) },
    { open: openShowMenu !== null, isInside: (target) => target.closest(`[data-show-menu-id="${openShowMenu}"]`) !== null, close: () => setOpenShowMenu(null) },
    { open: ignoredManagerOpen, isInside: (target) => target.closest('[data-menu-root="ignored"]') !== null, close: () => setIgnoredManagerOpen(false) },
  ], [() => setSeasonIgnoreShow(null)]);

  // Saves a settings patch. On a rejected save, onRejected runs before the error shows.
  function syncServerState(patch: Partial<ServerState>, onRejected?: () => Promise<void>) {
    void fetch("/api/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })
      .then(async (response) => {
        if (response.ok) return;
        await onRejected?.();
        throw new Error(SAVE_SETTINGS_ERROR);
      })
      .catch((syncError) => setError(syncError instanceof Error ? syncError.message : SAVE_SETTINGS_ERROR));
  }

  // Every report load and cache clear replaces the loaded cache keys through here,
  // which makes any captured report snapshot stale.
  function replaceReportCache(keys: Set<string>) {
    reportRevision.current++;
    loadedCacheKeys.current = keys;
    setScanCacheCount(keys.size);
  }

  // Every Ignore edit (Ignore, Restore, Change duration, season save) saves through here.
  // A rejected save shows the Ignore lists the server saved, unless a newer Ignore
  // edit of either list has started: that edit owns both displayed lists. onRejected
  // then sees the saved state, under the same ownership check.
  function saveIgnoreLists(patch: Pick<ServerState, "ignoredShows" | "ignoredSeasons">, onRejected?: (saved: ServerState) => void) {
    const save = ++ignoreSaves.current;
    syncServerState(patch, async () => {
      // A rejected save may still have written: show what was saved, never the pre-click lists.
      const saved = await fetch("/api/state", { cache: "no-store" }).then((reply) => reply.ok ? reply.json() : null).catch(() => null) as { state?: ServerState | null } | null;
      // Without a saved state there is nothing to confirm, so the current view stays.
      if (save !== ignoreSaves.current || !saved?.state || typeof saved.state !== "object") return;
      // Unlike start-up, a valid saved state with a missing list means that list is empty.
      setIgnoredShows(savedIgnoredShows(saved.state));
      setIgnoredSeasons(savedIgnoredSeasons(saved.state));
      onRejected?.(saved.state);
    });
  }

  function setDiagnostics(enabled: boolean) {
    setDebugEnabled(enabled);
    syncServerState({ diagnosticsEnabled: enabled });
  }

  function setGracePeriod(value: string) {
    const days = Math.max(0, Math.min(30, Math.trunc(Number(value) || 0)));
    setAiringGraceDays(days);
    syncServerState({ airingGraceDays: days });
  }

  // Trakt's whole clear keeps its results and empties their cache keys; a show's
  // clear removes only its cache key.
  const { confirmOpen: cacheClearConfirmOpen, clearing: clearingCache, message: cacheMessage, clearMessage: clearCacheMessage, openConfirm: openCacheClearConfirm, cancelConfirm: cancelCacheClear, clearCache, clearShowCache } = useClearCache<TraktShow>({
    cacheAddress: "/api/scan",
    showAddress: (show) => `/api/scan?traktId=${show.ids.trakt}`,
    showTitle: (show) => show.title,
    onCacheCleared: () => replaceReportCache(new Set()),
    onShowCleared: (show) => {
      const remaining = new Set(loadedCacheKeys.current);
      remaining.delete(String(show.ids.trakt));
      replaceReportCache(remaining);
    },
    closeShowMenu: () => setOpenShowMenu(null),
    onError: setError,
  });

  const ignoreRules = useMemo(() => [...ignoredShows, ...ignoredSeasons], [ignoredShows, ignoredSeasons]);
  const ignoreNow = useIgnoreClock(ignoreRules);
  const activeIgnoredShows = useMemo(() => activeIgnores(ignoredShows, ignoreNow), [ignoredShows, ignoreNow]);
  const activeIgnoredSeasons = useMemo(() => activeIgnores(ignoredSeasons, ignoreNow), [ignoredSeasons, ignoreNow]);
  const today = useLocalToday();
  // The saved missing episodes by show, each with its air date as a local calendar date.
  const missingByShow = useMemo(() => {
    const map = new Map<number, { key: number; title: string; source: TraktShow; episodes: (MissingEpisode & { airDate?: string })[] }>();
    for (const episode of missing) {
      const key = episode.show.ids.trakt;
      const entry = map.get(key) || { key, title: episode.show.title, source: episode.show, episodes: [] };
      entry.episodes.push({ ...episode, airDate: traktLocalAirDate(episode.firstAired) });
      map.set(key, entry);
    }
    return [...map.values()];
  }, [missing]);
  // Unaired episodes are hidden and undated ones shown, because Trakt counted them as aired.
  const view = useMemo(() => resultsView({
    shows: missingByShow,
    ignoredShows: new Set(activeIgnoredShows.map((show) => show.ids.trakt)),
    ignoredSeasons: new Map(activeIgnoredSeasons.map((show) => [show.traktId, new Set(show.seasons)])),
    airedPolicy: "aired-or-undated",
    airDateDelayDays: airingGraceDays,
    today,
    search: query,
    sortField,
    sortAscending,
    percent: traktPercent,
  }), [activeIgnoredSeasons, activeIgnoredShows, airingGraceDays, missingByShow, query, sortAscending, sortField, today]);
  const grouped = useMemo(() => view.shows.map((show) => ({ show: show.source, episodes: show.episodes })), [view]);
  const missingCount = view.totals.missingEpisodes;
  const activelyRateLimitPaused = scanning && rateLimitPaused === true;

  function chooseSort(field: "title" | "percent") {
    if (field === sortField) setSortAscending((ascending) => !ascending);
    else {
      setSortField(field);
      setSortAscending(field === "title");
    }
    setSortMenuOpen(false);
  }

  // Puts back what a rejected whole-show Ignore removed, unless newer data owns the
  // report or the server kept the Ignore despite the error.
  function restoreIgnoredShowResults(captured: IgnoredShowResults, saved: ServerState) {
    const { traktId, invalidations, revision, wasInvalidated, removedShows, removedMissing, removedCacheKey } = captured;
    // A new scan, report reload or cache clear since the apply owns the report now.
    if (invalidations !== reportInvalidations.current || revision !== reportRevision.current) return;
    // The Ignore was saved despite the error: its results stay removed.
    if (activeIgnores(savedIgnoredShows(saved)).some((rule) => rule.ids.trakt === traktId)) return;
    if (!wasInvalidated) invalidations.delete(traktId);
    if (removedCacheKey) {
      loadedCacheKeys.current.add(String(traktId));
      setScanCacheCount(loadedCacheKeys.current.size);
    }
    setShows((current) => current.some((item) => item.show.ids.trakt === traktId) ? current : [...current, ...removedShows]);
    setMissing((current) => {
      const present = new Set(current.map(episodeKey));
      return [...current, ...removedMissing.filter((episode) => !present.has(episodeKey(episode)))];
    });
  }

  function ignoreShow(show: TraktShow, duration: IgnoreDuration) {
    const traktId = show.ids.trakt;
    const invalidations = reportInvalidations.current;
    const revision = reportRevision.current;
    const wasInvalidated = invalidations.has(traktId);
    const removedShows = shows.filter((item) => item.show.ids.trakt === traktId);
    const removedMissing = missing.filter((episode) => episode.show.ids.trakt === traktId);
    invalidations.add(traktId);
    const removedCacheKey = loadedCacheKeys.current.delete(String(traktId));
    setScanCacheCount(loadedCacheKeys.current.size);
    const next = applyIgnore(ignoredShows, traktShowKey, compactTraktShow(show), duration, Date.now());
    setIgnoredShows(next);
    const captured: IgnoredShowResults = { traktId, invalidations, revision, wasInvalidated, removedShows, removedMissing, removedCacheKey };
    saveIgnoreLists({ ignoredShows: next }, (saved) => restoreIgnoredShowResults(captured, saved));
    setShows((current) => current.filter((item) => item.show.ids.trakt !== traktId));
    setMissing((current) => current.filter((episode) => episode.show.ids.trakt !== traktId));
    setShowToIgnore(null);
    setOpenShowMenu(null);
  }

  function restoreShow(traktId: number) {
    const next = restoreIgnore(ignoredShows, traktShowKey, traktId, Date.now());
    setIgnoredShows(next);
    saveIgnoreLists({ ignoredShows: next });
  }

  function restoreSeasons(traktId: number) {
    const next = restoreIgnore(ignoredSeasons, traktSeasonsKey, traktId, Date.now());
    setIgnoredSeasons(next);
    saveIgnoreLists({ ignoredSeasons: next });
  }

  function restoreManagerItem(key: string | number) {
    const target = decodeTraktManagerKey(key);
    if (target?.kind === "show") restoreShow(target.key);
    else if (target?.kind === "seasons") restoreSeasons(target.key);
  }

  function changeIgnoreDuration(key: string | number, duration: IgnoreDuration) {
    const target = decodeTraktManagerKey(key);
    const now = Date.now();
    if (target?.kind === "show") {
      const next = changeIgnoreRuleDuration(ignoredShows, traktShowKey, target.key, duration, now);
      setIgnoredShows(next);
      saveIgnoreLists({ ignoredShows: next });
    } else if (target?.kind === "seasons") {
      const next = changeIgnoreRuleDuration(ignoredSeasons, traktSeasonsKey, target.key, duration, now);
      setIgnoredSeasons(next);
      saveIgnoreLists({ ignoredSeasons: next });
    }
  }

  function openSeasonIgnore(show: TraktShow) {
    setSeasonIgnoreShow(show);
    const draft = openSeasonIgnoreRule(ignoredSeasons, traktSeasonsKey, show.ids.trakt, missing.filter((episode) => episode.show.ids.trakt === show.ids.trakt).map((episode) => episode.season), Date.now());
    setSeasonIgnoreDraft(draft.selected);
    setSeasonIgnoreOptions(draft.options);
    setSeasonIgnoreDuration(draft.duration);
    setSeasonIgnoreOriginalTiming(draft.originalTiming);
    setOpenShowMenu(null);
  }

  function saveIgnoredSeasons() {
    if (!seasonIgnoreShow) return;
    const sorted = saveSeasonIgnore(ignoredSeasons, traktSeasonsKey, { traktId: seasonIgnoreShow.ids.trakt, title: seasonIgnoreShow.title }, { selected: seasonIgnoreDraft, duration: seasonIgnoreDuration, originalTiming: seasonIgnoreOriginalTiming }, Date.now());
    setIgnoredSeasons(sorted);
    saveIgnoreLists({ ignoredSeasons: sorted });
    setSeasonIgnoreShow(null);
  }

  function loginToTrakt() {
    setError("");
    setErrorContext("auth");
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- API route that redirects to Trakt OAuth; needs a full browser navigation, not client routing.
    if (applicationConfigured) window.location.assign("/api/auth/trakt/login");
    else setConnectionOpen(true);
  }

  const traktSeasonKey = (traktId: number, season: number) => `${traktId}:${season}`;
  function toggleTraktShow(traktId: number) {
    setCollapsedShows((current) => { const next = new Set(current); if (next.has(traktId)) next.delete(traktId); else next.add(traktId); return next; });
    setOpenShowMenu(null);
  }
  function setAllTraktShows(collapsed: boolean) { setCollapsedShows(collapsed ? new Set(grouped.map(({ show }) => show.ids.trakt)) : new Set()); setOpenShowMenu(null); }
  function toggleTraktSeason(traktId: number, season: number) {
    setCollapsedSeasons((current) => { const next = new Set(current); const key = traktSeasonKey(traktId, season); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  function setAllTraktSeasons(traktId: number, episodes: MissingEpisode[], collapsed: boolean) {
    setCollapsedSeasons((current) => { const next = new Set(current); for (const season of new Set(episodes.map((episode) => episode.season))) { const key = traktSeasonKey(traktId, season); if (collapsed) next.add(key); else next.delete(key); } return next; });
  }

  async function saveTraktCredentials() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setErrorContext("auth");
      setError("Enter both your Trakt Client ID and Client Secret.");
      return;
    }
    setSavingCredentials(true);
    setError("");
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Shelfcheck could not save the Trakt credentials.");
      setClientId("");
      setClientSecret("");
      setApplicationConfigured(true);
      setConnectionOpen(false);
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- API route that redirects to Trakt OAuth; needs a full browser navigation, not client routing.
      window.location.assign("/api/auth/trakt/login");
    } catch (saveError) {
      setErrorContext("auth");
      setError(saveError instanceof Error ? saveError.message : "Shelfcheck could not save the Trakt credentials.");
    } finally {
      setSavingCredentials(false);
    }
  }

  async function logoutOfTrakt() {
    if (!window.confirm("Log out of Trakt? Shelfcheck will delete its stored access and refresh tokens.")) return;
    try {
      const response = await fetch("/api/auth/trakt/logout", { method: "POST" });
      if (!response.ok) throw new Error("Shelfcheck could not log out of Trakt.");
      setConnected(false);
      setClientId("");
      setClientSecret("");
      setConnectionOpen(false);
      setError("");
    } catch (logoutError) { setError(logoutError instanceof Error ? logoutError.message : "Shelfcheck could not log out of Trakt."); }
  }

  async function loadServerReport() {
    const invalidated = reportInvalidations.current;
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Shelfcheck could not load the completed report.");
    const { state } = await response.json() as { state: ServerState | null };
    if (!state?.report || invalidated !== reportInvalidations.current) return;
    const report = pruneClientReport(state.report, invalidated);
    setShows(report.shows);
    setMissing(report.missing);
    setLastScan(report.lastScan);
    replaceReportCache(new Set(Object.keys(report.scanCache || {})));
  }

  async function scanLibrary(force = false, traktId?: number) {
    if (scanRequestPending.current || scanInProgress.current || activity.isLocked()) return;
    if (!connected) { loginToTrakt(); return; }
    scanRequestPending.current = true;
    // Pending report loads keep the old set and cannot overwrite the new scan.
    reportInvalidations.current = new Set(activeIgnores(ignoredShows).map((show) => show.ids.trakt));
    setFullRescanConfirmOpen(false);
    setErrorContext("scan");
    setError("");
    // A run whose polling failed left its shows and pause behind; the new run starts without them.
    setRateLimitPaused(false);
    setScanProgress({});
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force, traktId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; activeScanRun?: unknown };
        if (response.status === 409) activity.report(body.activeScanRun);
        throw new Error(body.error || "Shelfcheck could not start the server-side scan.");
      }
      await pollServerScan();
      activity.refresh();
    } catch (scanError) {
      if (!(scanError instanceof DOMException && scanError.name === "AbortError")) setError(scanError instanceof Error ? scanError.message : "The server-side scan failed.");
    } finally { scanRequestPending.current = false; }
  }

  async function forceCheckShow(show: TraktShow) {
    if (activity.isLocked()) return;
    setOpenShowMenu(null); clearCacheMessage();
    await scanLibrary(false, show.ids.trakt);
  }

  return (
    <main>
      <header className="topbar">
        <div className="header-left">
          <Link className="brand" href="/"><span className="brandmark">S</span><span>Shelfcheck</span></Link>
          <nav className="mode-switch" aria-label="Search source">
            <Link className="active" href="/trakt" aria-current="page">Trakt</Link>
            <Link href="/plex">Plex</Link>
          </nav>
        </div>
        <div className="header-actions">
          <button type="button" className={`status ${connected ? "online" : ""}`} onClick={connected ? logoutOfTrakt : loginToTrakt}><i />{connected ? "Signed in to Trakt · Log out" : "Sign in to Trakt"}</button>
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
          <div className="radar"><span>{scanning ? `${progress}%` : missingCount}</span><small>{activelyRateLimitPaused ? "PAUSED - RATE LIMIT" : scanning ? "SCANNING" : "MISSING"}</small></div>
          <button className="primary" onClick={() => scanLibrary(false)} disabled={scanning || activity.locked}>{activelyRateLimitPaused ? "Paused due to Rate Limit" : scanning ? `Checking ${processed} of ${total || shows.length}…` : "Quick scan"}<b>→</b></button>
          <p>{lastScan ? `Last scan ${formatLastScan(lastScan)}` : "Only your collection metadata is read."}</p>
          {lastScan && <button type="button" className="force-rescan" onClick={() => setFullRescanConfirmOpen(true)} disabled={scanning || activity.locked}>Run Deep Scan</button>}
          {activity.lockMessage && <p className="scan-run-lock" role="status">{activity.lockMessage}</p>}
        </div>
      </section>

      <div className="summary-wrap">
        <section className="summary scan-summary" aria-label="Scan summary">
          <div><span>SHOWS IN COLLECTION</span><strong>{shows.length || "—"}</strong></div>
          <div><span>SHOWS WITH MISSING EPISODES</span><strong>{lastScan ? view.totals.shows : "—"}</strong></div>
          <div><span>MISSING EPISODES</span><strong>{lastScan ? missingCount : "—"}</strong></div>
          <div className="ignored-stat" data-menu-root="ignored"><button type="button" onClick={() => setIgnoredManagerOpen((open) => !open)} aria-expanded={ignoredManagerOpen}><span>IGNORED SHOWS ↗</span><strong>{activeIgnoredShows.length + activeIgnoredSeasons.length}</strong></button></div>
        </section>
        {ignoredManagerOpen && <IgnoredShowsManager items={[...activeIgnoredShows.map((show) => ({ ...show, key: ignoreManagerKey("show", show.ids.trakt), title: show.title })), ...activeIgnoredSeasons.map((show) => ({ ...show, key: ignoreManagerKey("seasons", show.traktId), title: show.title, detail: `▤ ${show.seasons.map((season) => `S${String(season).padStart(2, "0")}`).join(", ")}` }))]} onClose={() => setIgnoredManagerOpen(false)} onChangeDuration={changeIgnoreDuration} onRestore={restoreManagerItem} showCount />}
      </div>

      <section className="report">
        <div className="report-heading">
          <p className="eyebrow">TRAKT MISSING REPORT</p>
          <div className="report-primary-row"><h2>{missingCount} missing episodes</h2>
          {lastScan && missingCount > 0 && <ScanSortControl field={sortField} ascending={sortAscending} open={sortMenuOpen} onToggle={() => setSortMenuOpen((open) => !open)} onChoose={chooseSort} />}
          </div>
          {lastScan && missingCount > 0 && <div className="report-secondary-row"><label className="search">⌕<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search shows" /></label><div className="show-all-controls"><button onClick={() => setAllTraktShows(false)}>Expand all</button><button onClick={() => setAllTraktShows(true)}>Collapse all</button></div></div>}
        </div>
        {error && <div className="error"><span>!</span><p><strong>{errorContext === "auth" ? "Trakt login failed" : "Scan interrupted"}</strong>{error}</p></div>}
        {cacheMessage && !settingsOpen && <p className="cache-message show-cache-message">{cacheMessage}</p>}
        {!lastScan && !scanning && !error && <div className="empty"><div>✓</div><h3>No report yet</h3><p>Connect Trakt and run your first scan. Shelfcheck will list every aired episode missing from your collection.</p></div>}
        {scanning && <ScanProgressBox progress={progress} status={scanProgress} paused={activelyRateLimitPaused} maxShows={TRAKT_ACTIVE_SHOWS} />}
        {lastScan && grouped.length > 0 && <div className="show-list">{grouped.map(({ show, episodes }) => {
          const percentCollected = show.collection?.aired ? Math.round((show.collection.completed / show.collection.aired) * 100) : null;
          const showCollapsed = collapsedShows.has(show.ids.trakt);
          const seasons = [...new Set(episodes.map((episode) => episode.season))].sort((a, b) => a - b);
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
          <div className="show-info" data-show-menu-id={show.ids.trakt}>
            <div className="show-title-line">
              <button className="show-name-button" type="button" onClick={() => setOpenShowMenu((current) => current === show.ids.trakt ? null : show.ids.trakt)} aria-haspopup="menu" aria-expanded={openShowMenu === show.ids.trakt}>{show.title}</button>
              <small>{show.year}</small>
              <a className="brand-link" href={`https://app.trakt.tv/shows/${show.ids.slug}`} target="_blank" rel="noreferrer" aria-label={`Open ${show.title} on Trakt`} title="View on Trakt"><img src="/trakt-logomark.svg" alt="" /></a>
              {show.ids.tmdb && <a className="brand-link" href={`https://www.themoviedb.org/tv/${show.ids.tmdb}`} target="_blank" rel="noreferrer" aria-label={`Open ${show.title} on The Movie Database`} title="View on TMDB"><img src="/tmdb-blue-square.svg" alt="" /></a>}
              <button className="show-collapse-toggle" onClick={() => toggleTraktShow(show.ids.trakt)} aria-expanded={!showCollapsed} aria-label={`${showCollapsed ? "Expand" : "Collapse"} ${show.title}`}>{showCollapsed ? "+" : "−"}</button>
            </div>
            {activeIgnoredSeasons.find((item) => item.traktId === show.ids.trakt) && <div className="ignored-season-status">Ignored {activeIgnoredSeasons.find((item) => item.traktId === show.ids.trakt)!.seasons.map((season) => `S${String(season).padStart(2, "0")}`).join(", ")}</div>}
            {openShowMenu === show.ids.trakt && <ShowActionsMenu onIgnoreShow={() => { setShowToIgnore(show); setOpenShowMenu(null); }} onForceCheck={() => void forceCheckShow(show)} forceCheckDisabled={activity.locked} onClearCache={() => void clearShowCache(show)} onIgnoreSeasons={() => openSeasonIgnore(show)} />}
            {!showCollapsed && <>
            <div className="compact-show-meta"><p>{show.collection?.completed ?? 0} collected · {episodes.length} missing {episodes.length === 1 ? "episode" : "episodes"}</p><div className="season-all-controls"><button onClick={() => setAllTraktSeasons(show.ids.trakt, episodes, false)}>Show all</button><button onClick={() => setAllTraktSeasons(show.ids.trakt, episodes, true)}>Collapse all</button></div></div>
            <div className="plex-seasons">{seasons.map((season) => {
              const seasonEpisodes = episodes.filter((episode) => episode.season === season).sort((a, b) => a.episode - b.episode);
              const collapsed = collapsedSeasons.has(traktSeasonKey(show.ids.trakt, season));
              return <section className="plex-season" key={season}><button className="plex-season-heading" onClick={() => toggleTraktSeason(show.ids.trakt, season)} aria-expanded={!collapsed}><span>Season {String(season).padStart(2, "0")}</span><small>{seasonEpisodes.length} missing</small><b>{collapsed ? "+" : "−"}</b></button>{!collapsed && <div className="plex-episode-grid trakt-season-episodes">{seasonEpisodes.map((ep) => <div className="plex-episode-item" key={`${ep.season}-${ep.episode}`}><div className="episode-tile-row"><span className="episode-code-tile">S{String(ep.season).padStart(2,"0")}E{String(ep.episode).padStart(2,"0")}</span><div className="episode-provider-links"><a href={`https://app.trakt.tv/shows/${show.ids.slug}?season=${ep.season}&view=episode&episode=${ep.episode}`} target="_blank" rel="noreferrer" title="View episode on Trakt" aria-label={`Open ${show.title} season ${ep.season} episode ${ep.episode} on Trakt`}><img src="/trakt-logomark.svg" alt="" /></a>{show.ids.tmdb && <a href={`https://www.themoviedb.org/tv/${show.ids.tmdb}/season/${ep.season}/episode/${ep.episode}`} target="_blank" rel="noreferrer" title="View episode on TMDB" aria-label={`Open ${show.title} season ${ep.season} episode ${ep.episode} on TMDB`}><img src="/tmdb-blue-square.svg" alt="" /></a>}</div></div></div>)}</div>}</section>;
            })}</div></>}
          </div>
        </article>})}</div>}
      </section>

      <footer><span>SHELFCHECK / TRAKT API</span><span>Your credentials stay in your private configuration volume.</span></footer>

      {showToIgnore && <IgnoreDurationModal showTitle={showToIgnore.title} onClose={() => setShowToIgnore(null)} onSelect={(duration) => ignoreShow(showToIgnore, duration)} />}
      {seasonIgnoreShow && <SeasonIgnoreModal showTitle={seasonIgnoreShow.title} seasons={seasonIgnoreOptions.map((season) => ({ number: season, issueCount: missing.filter((episode) => episode.show.ids.trakt === seasonIgnoreShow.ids.trakt && episode.season === season).length }))} selected={seasonIgnoreDraft} duration={seasonIgnoreDuration} onDurationChange={setSeasonIgnoreDuration} onChange={setSeasonIgnoreDraft} onClose={() => setSeasonIgnoreShow(null)} onSave={saveIgnoredSeasons} />}

      {connectionOpen && <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setConnectionOpen(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="connection-title">
          <button className="close" onClick={() => setConnectionOpen(false)} aria-label="Close">×</button>
          <p className="eyebrow">TRAKT CONNECTION</p>
          <h2 id="connection-title">Connect your library</h2>
          <p className="modal-copy">Enter your Trakt application Client ID and Client Secret. Shelfcheck will save them privately, then redirect you to Trakt to authorize access.</p>
          <label>Client ID<input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Your Trakt Client ID" autoComplete="off" data-lpignore="true" /></label>
          <label>Client Secret<input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="Your Trakt Client Secret" autoComplete="off" data-lpignore="true" /></label>
          {errorContext === "auth" && error && <p className="field-error">{error}</p>}
          <button type="button" className="primary full" onClick={saveTraktCredentials} disabled={savingCredentials}>{savingCredentials ? "Saving…" : "Continue to Trakt"}<b>→</b></button>
          <a className="help-link" href="https://app.trakt.tv/settings/apps" target="_blank" rel="noreferrer">Create or view a Trakt application ↗</a>
        </section>
      </div>}

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(e) => e.currentTarget === e.target && setSettingsOpen(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button className="close" onClick={() => setSettingsOpen(false)} aria-label="Close">×</button>
          <p className="eyebrow">SETTINGS</p><h2 id="settings-title">Shelfcheck preferences</h2>
          <div className="grace-period">
            <div>
              <p className="grace-title">Air-date delay</p>
              <p>Treat each episode’s air date as this many calendar days later before showing it as missing.</p>
            </div>
            <div className="grace-input"><input type="number" min="0" max="30" step="1" value={airingGraceDays} onChange={(event) => setGracePeriod(event.target.value)} aria-label="Air-date delay in days" /><span>Days</span></div>
          </div>
          <div className="diagnostics scan-cache-settings">
            <p className="diagnostics-toggle scan-cache-title">Scan cache</p>
            <p>Quick and Deep scans reuse cached collection fingerprints and Trakt update timestamps. Clear the cache to make the next scan rebuild every show&apos;s result.</p>
            <p className="scan-cache-status">Cached results for {scanCacheCount} {scanCacheCount === 1 ? "show" : "shows"}{lastScan ? ` · Latest scan ${formatLastScan(lastScan)}` : ""}</p>
            {!cacheClearConfirmOpen ? <button type="button" onClick={openCacheClearConfirm} disabled={scanning || scanCacheCount === 0}>Clear scan cache</button> : <div className="cache-confirm">
              <p>This clears scan results only. Your credentials, settings, ignored shows, and logs will not change.</p>
              <div><button type="button" onClick={cancelCacheClear} disabled={clearingCache}>Cancel</button><button type="button" className="cache-clear-confirm" onClick={clearCache} disabled={clearingCache}>{clearingCache ? "Clearing…" : "Clear cache"}</button></div>
            </div>}
            {cacheMessage && <p className="cache-message">{cacheMessage}</p>}
          </div>
          <div className="diagnostics">
            <label className="diagnostics-toggle"><input type="checkbox" checked={debugEnabled} onChange={(event) => setDiagnostics(event.target.checked)} /> Enable diagnostic logging</label>
            <p>Records safe scan details in /data/logs. Credentials and authorization headers are never logged. The latest 10 scans are retained.</p>
            <DiagnosticLogActions endpoint="/api/logs" filename="shelfcheck.log" confirmMessage="Delete shelfcheck.log and all nine retained scan logs? This cannot be undone." downloadError="Shelfcheck could not download the current log." deleteError="Shelfcheck could not delete the diagnostic logs." onError={setError} />
          </div>
          <p className="build-info">Shelfcheck build {SHELFCHECK_VERSION}</p>
        </section>
      </div>}
      {fullRescanConfirmOpen && <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setFullRescanConfirmOpen(false)}>
        <section className="modal rescan-modal" role="dialog" aria-modal="true" aria-labelledby="rescan-title">
          <p className="eyebrow">DEEP LIBRARY CHECK</p>
          <h2 id="rescan-title">Run a Deep Scan?</h2>
          <p className="modal-copy">Shelfcheck will compare the collection fingerprint, aired count, and Trakt update timestamp for all {shows.length} shows, then manually rescan only the shows that changed. Clear the scan cache in Settings to rebuild every show.</p>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => setFullRescanConfirmOpen(false)}>Cancel</button>
            <button type="button" className="primary" onClick={() => scanLibrary(true)} disabled={activity.locked}>Run Deep Scan <b>→</b></button>
          </div>
        </section>
      </div>}
    </main>
  );
}
