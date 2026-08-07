"use client";

/* Poster and provider logos intentionally use native images with an app-owned proxy. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import { SHELFCHECK_VERSION } from "@/lib/version";

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
type MissingEpisode = { show: TraktShow; season: number; episode: number };
type ScanReport = { shows: CollectionShow[]; missing: MissingEpisode[]; lastScan: string; scanCache?: Record<string, unknown> };
type ScanStatus = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; error?: string; rateLimitPaused?: boolean };
type ServerState = {
  report?: ScanReport;
  checkpoint?: unknown;
  ignoredShows?: TraktShow[];
  scan?: ScanStatus;
  diagnosticsEnabled?: boolean;
  airingGraceDays?: number;
};

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

function formatLastScan(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function Home() {
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [editingCredentials, setEditingCredentials] = useState(false);
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
  const [debugEnabled, setDebugEnabled] = useState(true);
  const [airingGraceDays, setAiringGraceDays] = useState(0);
  const [ignoredShows, setIgnoredShows] = useState<TraktShow[]>([]);
  const [openShowMenu, setOpenShowMenu] = useState<number | null>(null);
  const [ignoredManagerOpen, setIgnoredManagerOpen] = useState(false);
  const [sortField, setSortField] = useState<"title" | "percent">("title");
  const [sortAscending, setSortAscending] = useState(true);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [fullRescanConfirmOpen, setFullRescanConfirmOpen] = useState(false);
  const [rateLimitPaused, setRateLimitPaused] = useState(false);
  const [scanCacheCount, setScanCacheCount] = useState(0);
  const [cacheClearConfirmOpen, setCacheClearConfirmOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] = useState("");
  const serverSyncTimerRef = useRef<number | null>(null);
  const scanAbortControllerRef = useRef<AbortController | null>(null);
  const pendingServerPatchRef = useRef<Partial<ServerState>>({});

  useEffect(() => {
    const savedIgnored = loadIgnoredShows();
    queueMicrotask(() => setIgnoredShows(savedIgnored));
    try { persistIgnoredShows(savedIgnored); } catch { /* persistence must not block startup */ }
    void fetch("/api/config", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const { configured } = await response.json() as { configured: boolean };
      setConnected(configured);
      if (configured) setSettingsOpen(false);
    }).catch(() => { /* settings remain open when configuration cannot be read */ });

    void fetch("/api/state", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const { state } = await response.json() as { state: ServerState | null };
      if (!state) {
        syncServerState({ ignoredShows: savedIgnored, diagnosticsEnabled: true, airingGraceDays: 0 }, true);
        return;
      }
      setDebugEnabled(state.diagnosticsEnabled !== false);
      setAiringGraceDays(Math.max(0, Math.min(30, Math.trunc(Number(state.airingGraceDays) || 0))));
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
        setScanCacheCount(Object.keys(state.report.scanCache || {}).length);
      }
      if (state.scan?.status === "running") void pollServerScan().catch((pollError) => {
        if (!(pollError instanceof DOMException && pollError.name === "AbortError")) setError(pollError instanceof Error ? pollError.message : "Shelfcheck could not resume scan progress.");
      });
    }).catch(() => { /* local browser copy remains available */ });
    return () => {
      scanAbortControllerRef.current?.abort();
      if (serverSyncTimerRef.current !== null) window.clearTimeout(serverSyncTimerRef.current);
    };
    // Startup synchronization intentionally runs once; pollServerScan reads server state itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function setDiagnostics(enabled: boolean) {
    setDebugEnabled(enabled);
    syncServerState({ diagnosticsEnabled: enabled }, true);
  }

  function setGracePeriod(value: string) {
    const days = Math.max(0, Math.min(30, Math.trunc(Number(value) || 0)));
    setAiringGraceDays(days);
    syncServerState({ airingGraceDays: days }, true);
  }

  async function downloadDebugLog() {
    const response = await fetch("/api/logs", { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      setError(body.error || "Shelfcheck could not download the current log.");
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url; link.download = "shelfcheck.log"; link.click();
    URL.revokeObjectURL(url);
  }

  async function deleteAllLogs() {
    if (!window.confirm("Delete shelfcheck.log and all nine retained scan logs? This cannot be undone.")) return;
    const response = await fetch("/api/logs", { method: "DELETE" });
    if (!response.ok) setError("Shelfcheck could not delete the diagnostic logs.");
  }

  async function clearCache() {
    setClearingCache(true);
    setCacheMessage("");
    const response = await fetch("/api/scan", { method: "DELETE" });
    const body = await response.json().catch(() => ({})) as { cleared?: number; error?: string };
    setClearingCache(false);
    if (!response.ok) {
      setError(body.error || "Shelfcheck could not clear the scan cache.");
      return;
    }
    setScanCacheCount(0);
    setCacheClearConfirmOpen(false);
    setCacheMessage(`${body.cleared || 0} cached show results cleared. The next scan will rebuild them.`);
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
      setEditingCredentials(false);
      setSettingsOpen(false);
      setError("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Shelfcheck could not save the Trakt configuration.");
    }
  }

  function cancelCredentialEdit() {
    setClientId("");
    setToken("");
    setError("");
    setEditingCredentials(false);
  }

  const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Scan polling was cancelled.", "AbortError"));
    }, { once: true });
  });

  async function loadServerReport() {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Shelfcheck could not load the completed report.");
    const { state } = await response.json() as { state: ServerState | null };
    if (!state?.report) return;
    const report = state.report;
    setShows(compactLibrary(report.shows));
    setMissing(compactMissing(report.missing));
    setLastScan(report.lastScan);
    setScanCacheCount(Object.keys(report.scanCache || {}).length);
  }

  async function pollServerScan() {
    scanAbortControllerRef.current?.abort();
    const controller = new AbortController();
    scanAbortControllerRef.current = controller;
    setScanning(true);
    try {
      while (!controller.signal.aborted) {
        const response = await fetch("/api/scan", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Shelfcheck could not read scan progress.");
        const { scan } = await response.json() as { scan: ScanStatus };
        setProcessed(scan.processed);
        setTotal(scan.total);
        setRateLimitPaused(scan.rateLimitPaused === true);
        setProgress(Math.round((scan.processed / Math.max(scan.total, 1)) * 100));
        if (scan.status === "completed") {
          await loadServerReport();
          setRateLimitPaused(false);
          setScanning(false);
          return;
        }
        if (scan.status === "error") {
          setScanning(false);
          setRateLimitPaused(false);
          throw new Error(scan.error || "The server-side scan failed.");
        }
        await wait(1000, controller.signal);
      }
    } finally {
      if (scanAbortControllerRef.current === controller) scanAbortControllerRef.current = null;
    }
  }

  async function scanLibrary(force = false) {
    if (!connected) { setSettingsOpen(true); return; }
    setFullRescanConfirmOpen(false);
    setError("");
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      if (!response.ok) throw new Error("Shelfcheck could not start the server-side scan.");
      await pollServerScan();
    } catch (scanError) {
      setScanning(false);
      if (!(scanError instanceof DOMException && scanError.name === "AbortError")) setError(scanError instanceof Error ? scanError.message : "The server-side scan failed.");
    }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#"><span className="brandmark">S</span><span>Shelfcheck</span></a>
        <div className="header-actions">
          <span className={`status ${connected ? "online" : ""}`}><i />{connected ? "Trakt connected" : "Not connected"}</span>
          <button className="icon-button" onClick={() => { setEditingCredentials(false); setSettingsOpen(true); }} aria-label="Trakt settings">⚙</button>
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
          <button className="primary" onClick={() => scanLibrary(false)} disabled={scanning}>{rateLimitPaused ? "Paused due to Rate Limit" : scanning ? `Checking ${processed} of ${total || shows.length}…` : "Quick scan"}<b>→</b></button>
          <p>{lastScan ? `Last scan ${formatLastScan(lastScan)}` : "Only your collection metadata is read."}</p>
          {lastScan && <button type="button" className="force-rescan" onClick={() => setFullRescanConfirmOpen(true)} disabled={scanning}>Run Deep Scan</button>}
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
        {scanning && <div className="loading"><span style={{ width: `${progress}%` }} /><p>{rateLimitPaused ? "Paused due to Rate Limit" : `Comparing show ${processed} of ${total || shows.length || "…"}. Progress is saved periodically.`}</p></div>}
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
          {connected && !editingCredentials ? <div className="credential-status">
            <span><b aria-hidden="true">✓</b> Trakt credentials configured</span>
            <button type="button" onClick={() => setEditingCredentials(true)}>Edit credentials</button>
          </div> : <>
            <label>Client ID<input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Your Trakt application client ID" autoComplete="off" data-lpignore="true" /></label>
            <label>Access token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Your OAuth access token" autoComplete="off" data-lpignore="true" /></label>
            {error && <p className="field-error">{error}</p>}
            {connected ? <div className="credential-actions">
              <button type="button" className="primary" onClick={saveCredentials}>Save changes <b>→</b></button>
              <button type="button" className="secondary" onClick={cancelCredentialEdit}>Cancel</button>
            </div> : <button className="primary full" onClick={saveCredentials}>Save and connect <b>→</b></button>}
          </>}
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
            <div><button type="button" onClick={downloadDebugLog}>Download log</button><button type="button" onClick={deleteAllLogs}>Delete all logs</button></div>
          </div>
          <a className="help-link" href="https://trakt.tv/oauth/applications" target="_blank" rel="noreferrer">Create or view a Trakt application ↗</a>
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
