"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TraktShow = {
  title: string;
  year: number;
  ids: { trakt: number; slug: string; tmdb?: number };
  images?: { poster?: string[] };
};
type CollectionShow = { show: TraktShow };
type ProgressEpisode = { number: number; completed: boolean };
type ProgressSeason = { number: number; episodes: ProgressEpisode[] };
type MissingEpisode = { show: TraktShow; season: number; episode: number };
type ScanCheckpoint = { signature: string; library: CollectionShow[]; completed: number[]; results: Record<string, MissingEpisode[]>; activity?: string };

const TRAKT = "https://api.trakt.tv";
const REPORT_CACHE = "shelfcheck-report-v1";
const CHECKPOINT_CACHE = "shelfcheck-checkpoint-v1";
const DEBUG_LOG_CACHE = "shelfcheck-debug-log-v1";
const DEBUG_ENABLED_CACHE = "shelfcheck-debug-enabled-v1";

function compactShow(show: TraktShow): TraktShow {
  return {
    title: show.title,
    year: show.year,
    ids: show.ids,
    ...(show.images?.poster?.[0] ? { images: { poster: [show.images.poster[0]] } } : {}),
  };
}

function compactLibrary(library: CollectionShow[]): CollectionShow[] {
  return library.map(({ show }) => ({ show: compactShow(show) }));
}

function compactMissing(items: MissingEpisode[]): MissingEpisode[] {
  return items.map((item) => ({ ...item, show: compactShow(item.show) }));
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
  const tokenRef = useRef("");
  const debugEnabledRef = useRef(false);

  useEffect(() => {
    const diagnosticsOn = localStorage.getItem(DEBUG_ENABLED_CACHE) === "true";
    setDebugEnabled(diagnosticsOn);
    debugEnabledRef.current = diagnosticsOn;
    const saved = localStorage.getItem("shelfcheck-trakt");
    try {
      if (saved) {
        const value = JSON.parse(saved);
        setClientId(value.clientId || "");
        setToken(value.token || "");
        tokenRef.current = value.token || "";
        setConnected(Boolean(value.clientId && value.token));
        setSettingsOpen(false);
      }
    } catch { /* ignore invalid local data */ }

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
          try { localStorage.setItem(REPORT_CACHE, JSON.stringify({ shows: cachedShows, missing: cachedMissing, lastScan: report.lastScan })); }
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
  }, []);

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

  const grouped = useMemo(() => {
    const map = new Map<number, { show: TraktShow; episodes: MissingEpisode[] }>();
    missing.filter((item) => item.show.title.toLowerCase().includes(query.toLowerCase())).forEach((item) => {
      const current = map.get(item.show.ids.trakt) || { show: item.show, episodes: [] };
      current.episodes.push(item);
      map.set(item.show.ids.trakt, current);
    });
    return [...map.values()];
  }, [missing, query]);

  function saveCredentials() {
    if (!clientId.trim() || !token.trim()) {
      setError("Enter both your Trakt client ID and access token.");
      return;
    }
    const nextClientId = clientId.trim();
    const nextToken = token.trim();
    setClientId(nextClientId);
    setToken(nextToken);
    tokenRef.current = nextToken;
    localStorage.setItem("shelfcheck-trakt", JSON.stringify({ clientId: nextClientId, token: nextToken }));
    setConnected(true);
    setSettingsOpen(false);
    setError("");
  }

  const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try { return await fetch(input, { ...init, signal: controller.signal }); }
    finally { window.clearTimeout(timeout); }
  }

  async function traktRequest(input: string | URL): Promise<Response> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await wait(650);
      const requestStarted = Date.now();
      try {
        const upstream = new URL(input.toString());
        logDebug("request.start", { path: `${upstream.pathname}${upstream.search}`, attempt: attempt + 1 });
        const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
        const response = isLocal
          ? await fetchWithTimeout(upstream, {
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "trakt-api-version": "2",
                "trakt-api-key": clientId,
                Authorization: `Bearer ${tokenRef.current || token}`,
              },
            })
          : await fetchWithTimeout(`/api/trakt?path=${encodeURIComponent(`${upstream.pathname}${upstream.search}`)}`, {
              headers: {
                "x-trakt-client-id": clientId,
                "x-trakt-access-token": tokenRef.current || token,
              },
            });
        logDebug("request.response", { path: `${upstream.pathname}${upstream.search}`, attempt: attempt + 1, status: response.status, elapsedMs: Date.now() - requestStarted });
        // Authentication and permission failures will not improve with retries.
        // Return them immediately so the scan can show a useful error.
        if (response.status === 401 || response.status === 403) return response;
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
    setScanning(true); setError(""); setProgress(0); setPending(0);
    logDebug("scan.start", { cachedShows: shows.length, pending });
    try {
      let savedCheckpoint: ScanCheckpoint | null = null;
      try { savedCheckpoint = JSON.parse(localStorage.getItem(CHECKPOINT_CACHE) || "null") as ScanCheckpoint | null; }
      catch { /* ignore invalid checkpoint data */ }
      // Resume from browser storage immediately. A temporary failure while
      // downloading the collection must not block hundreds of known shows.
      let library: CollectionShow[];
      if (savedCheckpoint?.library?.length && savedCheckpoint.completed.length < savedCheckpoint.library.length) {
        library = savedCheckpoint.library;
      } else {
        try {
          library = await traktFetchAll<CollectionShow>("/sync/collection/shows?extended=full,images");
        } catch (libraryError) {
          if (!shows.length) throw libraryError;
          library = shows;
        }
      }
      library = compactLibrary(library);
      setShows(library); setTotal(library.length);
      logDebug("scan.library-ready", { shows: library.length, resumed: Boolean(savedCheckpoint?.library?.length) });
      const signature = library.map(({ show }) => show.ids.trakt).sort((a, b) => a - b).join(",");
      // Collection membership is a fast, reliable change marker. The optional
      // last-activities endpoint must never delay the start of a scan.
      const activity = "";
      let checkpoint: ScanCheckpoint = { signature, library, completed: [], results: {}, activity };
      if (savedCheckpoint?.signature === signature && (!savedCheckpoint.activity || !activity || savedCheckpoint.activity === activity)) checkpoint = { ...savedCheckpoint, library, activity };
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
      };
      const scanOne = async (item: CollectionShow) => {
        const showStarted = Date.now();
        logDebug("show.start", { traktId: item.show.ids.trakt, title: item.show.title, completed: completed.size, total: library.length });
        const data = await traktFetch<{ seasons?: ProgressSeason[] }>(`/shows/${item.show.ids.trakt}/progress/collection?hidden=false&specials=false&count_specials=false`);
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
      await Promise.all(Array.from({ length: Math.min(1, queue.length || 1) }, worker));
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
      localStorage.setItem(REPORT_CACHE, JSON.stringify({ shows: compactLibrary(library), missing: compactMissing(results), lastScan: scanTime }));
      localStorage.removeItem(CHECKPOINT_CACHE);
      setPending(0);
    } catch (e) {
      logDebug("scan.error", { error: e instanceof Error ? e.message : String(e), processed, total });
      setError(e instanceof Error ? e.message : "The scan could not be completed.");
    } finally { setScanning(false); }
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
          <div className="radar"><span>{scanning ? `${progress}%` : missing.length}</span><small>{scanning ? "SCANNING" : "MISSING"}</small></div>
          <button className="primary" onClick={scanLibrary} disabled={scanning}>{scanning ? `Checking ${processed} of ${total || shows.length}…` : pending ? `Resume scan (${pending} left)` : lastScan ? "Scan again" : "Scan Trakt library"}<b>→</b></button>
          <p>{lastScan ? `Last scan ${lastScan}` : "Only your collection metadata is read."}</p>
        </div>
      </section>

      <section className="summary" aria-label="Scan summary">
        <div><span>COLLECTED SHOWS</span><strong>{shows.length || "—"}</strong></div>
        <div><span>MISSING EPISODES</span><strong>{lastScan ? missing.length : "—"}</strong></div>
        <div><span>SHOWS WITH GAPS</span><strong>{lastScan ? grouped.length : "—"}</strong></div>
        <div className="health"><span>COLLECTION STATUS</span><strong>{!lastScan ? "Not scanned" : missing.length ? "Needs attention" : "Complete"}</strong></div>
      </section>

      <section className="report">
        <div className="report-heading">
          <div><p className="eyebrow">MISSING REPORT</p><h2>{!lastScan ? "Ready when you are" : missing.length ? `${missing.length} episodes to find` : "Your collection is complete"}</h2></div>
          {lastScan && missing.length > 0 && <label className="search">⌕<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter shows" /></label>}
        </div>
        {error && <div className="error"><span>!</span><p><strong>Scan interrupted</strong>{error}</p></div>}
        {!lastScan && !scanning && !error && <div className="empty"><div>✓</div><h3>No report yet</h3><p>Connect Trakt and run your first scan. Shelfcheck will list every aired episode missing from your collection.</p></div>}
        {scanning && <div className="loading"><span style={{ width: `${progress}%` }} /><p>Comparing show {processed} of {total || shows.length || "…"}. Every completed show is saved automatically.</p></div>}
        {lastScan && grouped.length > 0 && <div className="show-list">{grouped.map(({ show, episodes }) => <article key={show.ids.trakt}>
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
            <h3>{show.title} <small>{show.year}</small></h3>
            <div className="show-links-row">
              <p>{episodes.length} missing {episodes.length === 1 ? "episode" : "episodes"}</p>
              <a className="brand-link" href={`https://app.trakt.tv/shows/${show.ids.slug}`} target="_blank" rel="noreferrer" aria-label={`Open ${show.title} on Trakt`} title="View on Trakt"><img src="/trakt-logomark.svg" alt="" /></a>
              {show.ids.tmdb && <a className="brand-link" href={`https://www.themoviedb.org/tv/${show.ids.tmdb}`} target="_blank" rel="noreferrer" aria-label={`Open ${show.title} on The Movie Database`} title="View on TMDB"><img src="/tmdb-blue-square.svg" alt="" /></a>}
            </div>
          </div>
          <div className="episode-tags">{episodes.map((ep) => <a
            key={`${ep.season}-${ep.episode}`}
            href={`https://app.trakt.tv/shows/${show.ids.slug}?season=${ep.season}&view=episode&episode=${ep.episode}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${show.title} season ${ep.season} episode ${ep.episode} on Trakt`}
          >S{String(ep.season).padStart(2,"0")}E{String(ep.episode).padStart(2,"0")}<b aria-hidden="true">↗</b></a>)}</div>
        </article>)}</div>}
      </section>

      <footer><span>SHELFCHECK / TRAKT API</span><span>Your credentials stay in this browser.</span></footer>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(e) => e.currentTarget === e.target && connected && setSettingsOpen(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button className="close" onClick={() => setSettingsOpen(false)} disabled={!connected} aria-label="Close">×</button>
          <p className="eyebrow">CONNECTION</p><h2 id="settings-title">Connect your Trakt library</h2>
          <p className="modal-copy">Use your Trakt application client ID and access token. They are saved only in this browser and sent directly to Trakt.</p>
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
