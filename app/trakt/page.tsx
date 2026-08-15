"use client";

/* Poster and provider logos intentionally use native images with an app-owned proxy. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { matchesSearch } from "@/lib/search";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { DiagnosticLogActions } from "@/app/components/diagnostic-log-actions";
import { IgnoredShowsManager } from "@/app/components/ignored-shows-manager";
import { ScanSortControl } from "@/app/components/scan-sort-control";
import { SeasonIgnoreModal } from "@/app/components/season-ignore-modal";
import { ShowActionsMenu } from "@/app/components/show-actions-menu";
import { compactMissingEpisodes, compactTraktLibrary, compactTraktShow, type CollectionShow, type MissingEpisode, type TraktShow } from "@/lib/trakt-model";
import { isActiveRateLimitPause } from "@/lib/rate-limit-status";
import { scanProgressPercent } from "@/lib/scan-progress";
import { useScanPoller } from "@/app/hooks/use-scan-poller";

type ScanReport = { shows: CollectionShow[]; missing: MissingEpisode[]; lastScan: string; scanCache?: Record<string, unknown> };
type ScanStatus = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; error?: string; rateLimitPaused?: boolean };
type IgnoredTraktSeasons = { traktId: number; title: string; seasons: number[] };
type ServerState = {
  report?: ScanReport;
  ignoredShows?: TraktShow[];
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
  const [ignoredShows, setIgnoredShows] = useState<TraktShow[]>([]);
  const [ignoredSeasons, setIgnoredSeasons] = useState<IgnoredTraktSeasons[]>([]);
  const [openShowMenu, setOpenShowMenu] = useState<number | null>(null);
  const [seasonIgnoreShow, setSeasonIgnoreShow] = useState<TraktShow | null>(null);
  const [seasonIgnoreDraft, setSeasonIgnoreDraft] = useState<number[]>([]);
  const [ignoredManagerOpen, setIgnoredManagerOpen] = useState(false);
  const [sortField, setSortField] = useState<"title" | "percent">("title");
  const [sortAscending, setSortAscending] = useState(true);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [collapsedShows, setCollapsedShows] = useState<Set<number>>(new Set());
  const [collapsedSeasons, setCollapsedSeasons] = useState<Set<string>>(new Set());
  const [fullRescanConfirmOpen, setFullRescanConfirmOpen] = useState(false);
  const [rateLimitPaused, setRateLimitPaused] = useState(false);
  const [scanCacheCount, setScanCacheCount] = useState(0);
  const [cacheClearConfirmOpen, setCacheClearConfirmOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] = useState("");
  const { poll: pollServerScan, abort: abortScanPoll } = useScanPoller<{ scan: ScanStatus }>({
    url: "/api/scan",
    onPollingChange: setScanning,
    onResponse: async ({ scan }) => {
      setProcessed(scan.processed);
      setTotal(scan.total);
      setRateLimitPaused(scan.rateLimitPaused === true);
      setProgress(scanProgressPercent(scan.processed, scan.total, scan.status === "running"));
      if (scan.status === "completed") { await loadServerReport(); setRateLimitPaused(false); return true; }
      if (scan.status === "error") { setRateLimitPaused(false); throw new Error(scan.error || "The server-side scan failed."); }
      return false;
    },
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

    void fetch("/api/state", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const { state } = await response.json() as { state: ServerState | null };
      if (!state) {
        syncServerState({ ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0 });
        return;
      }
      setDebugEnabled(state.diagnosticsEnabled !== false);
      setAiringGraceDays(Math.max(0, Math.min(30, Math.trunc(Number(state.airingGraceDays) || 0))));
      if (Array.isArray(state.ignoredShows)) {
        const remoteIgnored = state.ignoredShows.map(compactTraktShow);
        setIgnoredShows(remoteIgnored);
      }
      if (Array.isArray(state.ignoredSeasons)) setIgnoredSeasons(state.ignoredSeasons);
      if (state.report?.shows && state.report?.missing && state.report.lastScan) {
        const remoteReport = {
          ...state.report,
          shows: compactTraktLibrary(state.report.shows),
          missing: compactMissingEpisodes(state.report.missing),
        };
        setShows(remoteReport.shows); setMissing(remoteReport.missing); setLastScan(remoteReport.lastScan); setSettingsOpen(false);
        setScanCacheCount(Object.keys(state.report.scanCache || {}).length);
      }
      if (state.scan?.status === "running") void pollServerScan().catch((pollError) => {
        if (!(pollError instanceof DOMException && pollError.name === "AbortError")) setError(pollError instanceof Error ? pollError.message : "Shelfcheck could not resume scan progress.");
      });
    }).catch(() => { /* local browser copy remains available */ });
    return () => {
      abortScanPoll();
    };
  }, [abortScanPoll, pollServerScan]);

  useEffect(() => {
    if (!sortMenuOpen && openShowMenu === null && !ignoredManagerOpen) return;

    const closeMenusOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (sortMenuOpen && !target.closest('[data-menu-root="sort"]')) setSortMenuOpen(false);
      if (openShowMenu !== null && !target.closest(`[data-show-menu-id="${openShowMenu}"]`)) setOpenShowMenu(null);
      if (ignoredManagerOpen && !target.closest('[data-menu-root="ignored"]')) setIgnoredManagerOpen(false);
    };
    const closeMenusOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSortMenuOpen(false);
      setOpenShowMenu(null);
      setSeasonIgnoreShow(null);
      setIgnoredManagerOpen(false);
    };

    document.addEventListener("pointerdown", closeMenusOnOutsidePointer);
    document.addEventListener("keydown", closeMenusOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenusOnOutsidePointer);
      document.removeEventListener("keydown", closeMenusOnEscape);
    };
  }, [ignoredManagerOpen, openShowMenu, sortMenuOpen]);

  function syncServerState(patch: Partial<ServerState>) {
    void fetch("/api/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })
      .then((response) => { if (!response.ok) throw new Error("Shelfcheck could not save the settings."); })
      .catch((syncError) => setError(syncError instanceof Error ? syncError.message : "Shelfcheck could not save the settings."));
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

  async function clearCache() {
    setClearingCache(true);
    setCacheMessage("");
    try {
      const response = await fetch("/api/scan", { method: "DELETE" });
      const body = await response.json().catch(() => ({})) as { cleared?: number; error?: string };
      if (!response.ok) throw new Error(body.error || "Shelfcheck could not clear the scan cache.");
      setScanCacheCount(0);
      setCacheClearConfirmOpen(false);
      setCacheMessage(`${body.cleared || 0} cached show results cleared. The next scan will rebuild them.`);
    } catch (clearError) { setError(clearError instanceof Error ? clearError.message : "Shelfcheck could not clear the scan cache."); }
    finally { setClearingCache(false); }
  }

  const ignoredIds = useMemo(() => new Set(ignoredShows.map((show) => show.ids.trakt)), [ignoredShows]);
  const ignoredSeasonMap = useMemo(() => new Map(ignoredSeasons.map((show) => [show.traktId, new Set(show.seasons)])), [ignoredSeasons]);
  const visibleMissing = useMemo(() => missing.filter((item) => !ignoredIds.has(item.show.ids.trakt) && !ignoredSeasonMap.get(item.show.ids.trakt)?.has(item.season)), [missing, ignoredIds, ignoredSeasonMap]);
  const activelyRateLimitPaused = isActiveRateLimitPause(scanning, rateLimitPaused);

  const grouped = useMemo(() => {
    const map = new Map<number, { show: TraktShow; episodes: MissingEpisode[] }>();
    visibleMissing.filter((item) => matchesSearch(item.show.title, query)).forEach((item) => {
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
      const next = [...current.filter((item) => item.ids.trakt !== show.ids.trakt), compactTraktShow(show)].sort((a, b) => a.title.localeCompare(b.title));
      syncServerState({ ignoredShows: next });
      return next;
    });
    setOpenShowMenu(null);
  }

  function restoreShow(traktId: number) {
    setIgnoredShows((current) => {
      const next = current.filter((show) => show.ids.trakt !== traktId);
      syncServerState({ ignoredShows: next });
      return next;
    });
  }

  function restoreSeasons(traktId: number) {
    setIgnoredSeasons((current) => {
      const next = current.filter((show) => show.traktId !== traktId);
      syncServerState({ ignoredSeasons: next });
      return next;
    });
  }

  function openSeasonIgnore(show: TraktShow) {
    setSeasonIgnoreShow(show);
    setSeasonIgnoreDraft(ignoredSeasons.find((item) => item.traktId === show.ids.trakt)?.seasons || []);
    setOpenShowMenu(null);
  }

  function saveIgnoredSeasons() {
    if (!seasonIgnoreShow) return;
    const next = ignoredSeasons.filter((show) => show.traktId !== seasonIgnoreShow.ids.trakt);
    if (seasonIgnoreDraft.length) next.push({ traktId: seasonIgnoreShow.ids.trakt, title: seasonIgnoreShow.title, seasons: [...seasonIgnoreDraft].sort((a, b) => a - b) });
    const sorted = next.sort((a, b) => a.title.localeCompare(b.title));
    setIgnoredSeasons(sorted);
    syncServerState({ ignoredSeasons: sorted });
    setSeasonIgnoreShow(null);
  }

  async function clearShowCache(show: TraktShow) {
    setOpenShowMenu(null); setCacheMessage("");
    try {
      const response = await fetch(`/api/scan?traktId=${show.ids.trakt}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({})) as { cleared?: number; error?: string };
      if (!response.ok) throw new Error(body.error || `Shelfcheck could not clear ${show.title}'s cache.`);
      if (body.cleared) setScanCacheCount((count) => Math.max(0, count - 1));
      setCacheMessage(body.cleared ? `${show.title} will be rebuilt during the next scan.` : `${show.title} was not cached.`);
    } catch (clearError) { setError(clearError instanceof Error ? clearError.message : `Shelfcheck could not clear ${show.title}'s cache.`); }
  }

  function loginToTrakt() {
    setError("");
    setErrorContext("auth");
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
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Shelfcheck could not load the completed report.");
    const { state } = await response.json() as { state: ServerState | null };
    if (!state?.report) return;
    const report = state.report;
    setShows(compactTraktLibrary(report.shows));
    setMissing(compactMissingEpisodes(report.missing));
    setLastScan(report.lastScan);
    setScanCacheCount(Object.keys(report.scanCache || {}).length);
  }

  async function scanLibrary(force = false, traktId?: number) {
    if (!connected) { loginToTrakt(); return; }
    setFullRescanConfirmOpen(false);
    setErrorContext("scan");
    setError("");
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force, traktId }),
      });
      if (!response.ok) throw new Error("Shelfcheck could not start the server-side scan.");
      await pollServerScan();
    } catch (scanError) {
      if (!(scanError instanceof DOMException && scanError.name === "AbortError")) setError(scanError instanceof Error ? scanError.message : "The server-side scan failed.");
    }
  }

  async function forceCheckShow(show: TraktShow) {
    setOpenShowMenu(null); setCacheMessage("");
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
          <div className="radar"><span>{scanning ? `${progress}%` : visibleMissing.length}</span><small>{activelyRateLimitPaused ? "PAUSED - RATE LIMIT" : scanning ? "SCANNING" : "MISSING"}</small></div>
          <button className="primary" onClick={() => scanLibrary(false)} disabled={scanning}>{activelyRateLimitPaused ? "Paused due to Rate Limit" : scanning ? `Checking ${processed} of ${total || shows.length}…` : "Quick scan"}<b>→</b></button>
          <p>{lastScan ? `Last scan ${formatLastScan(lastScan)}` : "Only your collection metadata is read."}</p>
          {lastScan && <button type="button" className="force-rescan" onClick={() => setFullRescanConfirmOpen(true)} disabled={scanning}>Run Deep Scan</button>}
        </div>
      </section>

      <div className="summary-wrap">
        <section className="summary scan-summary" aria-label="Scan summary">
          <div><span>SHOWS IN COLLECTION</span><strong>{shows.length || "—"}</strong></div>
          <div><span>SHOWS WITH MISSING EPISODES</span><strong>{lastScan ? grouped.length : "—"}</strong></div>
          <div><span>MISSING EPISODES</span><strong>{lastScan ? visibleMissing.length : "—"}</strong></div>
          <div className="ignored-stat" data-menu-root="ignored"><button type="button" onClick={() => setIgnoredManagerOpen((open) => !open)} aria-expanded={ignoredManagerOpen}><span>IGNORED SHOWS ↗</span><strong>{ignoredShows.length + ignoredSeasons.length}</strong></button></div>
        </section>
        {ignoredManagerOpen && <IgnoredShowsManager items={[...ignoredShows.map((show) => ({ key: `show|${show.ids.trakt}`, title: show.title })), ...ignoredSeasons.map((show) => ({ key: `seasons|${show.traktId}`, title: show.title, detail: `▤ ${show.seasons.map((season) => `S${String(season).padStart(2, "0")}`).join(", ")}` }))]} onClose={() => setIgnoredManagerOpen(false)} onRestore={(key) => { const value = String(key); if (value.startsWith("show|")) restoreShow(Number(value.slice(5))); else if (value.startsWith("seasons|")) restoreSeasons(Number(value.slice(8))); }} showCount />}
      </div>

      <section className="report">
        <div className="report-heading">
          <p className="eyebrow">TRAKT MISSING REPORT</p>
          <div className="report-primary-row"><h2>{visibleMissing.length} missing episodes</h2>
          {lastScan && visibleMissing.length > 0 && <ScanSortControl field={sortField} ascending={sortAscending} open={sortMenuOpen} onToggle={() => setSortMenuOpen((open) => !open)} onChoose={chooseSort} />}
          </div>
          {lastScan && visibleMissing.length > 0 && <div className="report-secondary-row"><label className="search">⌕<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search shows" /></label><div className="show-all-controls"><button onClick={() => setAllTraktShows(false)}>Expand all</button><button onClick={() => setAllTraktShows(true)}>Collapse all</button></div></div>}
        </div>
        {error && <div className="error"><span>!</span><p><strong>{errorContext === "auth" ? "Trakt login failed" : "Scan interrupted"}</strong>{error}</p></div>}
        {cacheMessage && !settingsOpen && <p className="cache-message show-cache-message">{cacheMessage}</p>}
        {!lastScan && !scanning && !error && <div className="empty"><div>✓</div><h3>No report yet</h3><p>Connect Trakt and run your first scan. Shelfcheck will list every aired episode missing from your collection.</p></div>}
        {scanning && <div className="loading"><span style={{ width: `${progress}%` }} /><p>{activelyRateLimitPaused ? "Paused due to Rate Limit" : `Comparing show ${processed} of ${total || shows.length || "…"}. Progress is saved periodically.`}</p></div>}
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
            {ignoredSeasons.find((item) => item.traktId === show.ids.trakt) && <div className="ignored-season-status">Ignored {ignoredSeasons.find((item) => item.traktId === show.ids.trakt)!.seasons.map((season) => `S${String(season).padStart(2, "0")}`).join(", ")}</div>}
            {openShowMenu === show.ids.trakt && <ShowActionsMenu onIgnoreShow={() => ignoreShow(show)} onForceCheck={() => void forceCheckShow(show)} onClearCache={() => void clearShowCache(show)} onIgnoreSeasons={() => openSeasonIgnore(show)} />}
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

      {seasonIgnoreShow && <SeasonIgnoreModal showTitle={seasonIgnoreShow.title} seasons={[...new Set(missing.filter((episode) => episode.show.ids.trakt === seasonIgnoreShow.ids.trakt).map((episode) => episode.season))].sort((a, b) => a - b).map((season) => ({ number: season, issueCount: missing.filter((episode) => episode.show.ids.trakt === seasonIgnoreShow.ids.trakt && episode.season === season).length }))} selected={seasonIgnoreDraft} onChange={setSeasonIgnoreDraft} onClose={() => setSeasonIgnoreShow(null)} onSave={saveIgnoredSeasons} />}

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
              <p className="grace-title">Airing grace period</p>
              <p>Wait this many days after Trakt&apos;s aired date before reporting an episode as missing.</p>
            </div>
            <div className="grace-input"><input type="number" min="0" max="30" step="1" value={airingGraceDays} onChange={(event) => setGracePeriod(event.target.value)} aria-label="Airing grace period in days" /><span>Days</span></div>
            <small>Example: Trakt date Aug 4 → report starting {new Date(Date.UTC(2026, 7, 4 + airingGraceDays)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</small>
          </div>
          <div className="diagnostics scan-cache-settings">
            <p className="diagnostics-toggle scan-cache-title">Scan cache</p>
            <p>Quick and Deep scans reuse cached collection fingerprints and Trakt update timestamps. Clear the cache to make the next scan rebuild every show&apos;s result.</p>
            <p className="scan-cache-status">Cached results for {scanCacheCount} {scanCacheCount === 1 ? "show" : "shows"}{lastScan ? ` · Latest scan ${formatLastScan(lastScan)}` : ""}</p>
            {!cacheClearConfirmOpen ? <button type="button" onClick={() => { setCacheMessage(""); setCacheClearConfirmOpen(true); }} disabled={scanning || scanCacheCount === 0}>Clear scan cache</button> : <div className="cache-confirm">
              <p>This clears scan results only. Your credentials, settings, ignored shows, and logs will not change.</p>
              <div><button type="button" onClick={() => setCacheClearConfirmOpen(false)} disabled={clearingCache}>Cancel</button><button type="button" className="cache-clear-confirm" onClick={clearCache} disabled={clearingCache}>{clearingCache ? "Clearing…" : "Clear cache"}</button></div>
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
          <p className="modal-copy">Shelfcheck will compare the collection fingerprint, aired count, and Trakt update timestamp for all {shows.length} shows, then manually rescan only the shows that changed. It can exclude incomplete episodes whose confirmed Trakt air date has not arrived, so its total can differ from Quick Scan. Clear the scan cache in Settings to rebuild every show.</p>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => setFullRescanConfirmOpen(false)}>Cancel</button>
            <button type="button" className="primary" onClick={() => scanLibrary(true)}>Run Deep Scan <b>→</b></button>
          </div>
        </section>
      </div>}
    </main>
  );
}
