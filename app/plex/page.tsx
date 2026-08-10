"use client";

/* Plex artwork is served through an authenticated app-owned proxy. */
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { matchesSearch } from "@/lib/search";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { DiagnosticLogActions } from "@/app/components/diagnostic-log-actions";
import { IgnoredShowsManager } from "@/app/components/ignored-shows-manager";
import { ScanSortControl } from "@/app/components/scan-sort-control";
import { shouldShowPlexMissingEpisode } from "@/lib/plex-airdate";
import { isActiveRateLimitPause } from "@/lib/rate-limit-status";

type Missing = { season: number; episode: number; title?: string; airDate?: string; tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: ("TMDB" | "TVDB")[] };
type Show = { ratingKey: string; title: string; year?: number; thumb?: string; tmdbId?: number; tvdbId?: number; tvdbSlug?: string; plexEpisodes: number; missing: Missing[]; warning?: string };
type Report = { shows: Show[]; lastScan: string; scanCache?: Record<string, unknown> };
type Status = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; error?: string; rateLimitPaused?: boolean; rateLimitProvider?: "Plex" | "TMDB" | "TVDB" };
type ConfigStatus = { plexUrl: string; plexTokenSaved: boolean; tmdbTokenSaved: boolean; tvdbApiKeySaved: boolean; tvdbPinSaved: boolean; configured: boolean };
type FieldKey = "plexUrl" | "plexToken" | "tmdbToken" | "tvdbApiKey" | "tvdbPin";
type IgnoredShow = { ratingKey: string; title: string };
type PlexSettings = { ignoredShows: IgnoredShow[]; hideUnairedEpisodes: boolean; airingOffsetDays: number; autoCompoundEpisodes: boolean; diagnosticsEnabled: boolean };

const EMPTY_CONFIG: ConfigStatus = { plexUrl: "", plexTokenSaved: false, tmdbTokenSaved: false, tvdbApiKeySaved: false, tvdbPinSaved: false, configured: false };
const EMPTY_SETTINGS: PlexSettings = { ignoredShows: [], hideUnairedEpisodes: false, airingOffsetDays: 0, autoCompoundEpisodes: true, diagnosticsEnabled: true };
const TVDB_LOGO = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/tvdb.svg";

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function episodeTileDate(airDate?: string) {
  if (!airDate) return "No Aired Date";
  const date = airDate.slice(0, 10);
  return date >= localToday() ? date : null;
}

export default function PlexPage() {
  const pollAbortControllerRef = useRef<AbortController | null>(null);
  const [configured, setConfigured] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [openShowMenu, setOpenShowMenu] = useState<string | null>(null);
  const [openEpisodeMenu, setOpenEpisodeMenu] = useState<string | null>(null);
  const [collapsedShows, setCollapsedShows] = useState<Set<string>>(new Set());
  const [collapsedSeasons, setCollapsedSeasons] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<Status>({ status: "idle", processed: 0, total: 0 });
  const [report, setReport] = useState<Report | null>(null);
  const [settings, setSettings] = useState<PlexSettings>(EMPTY_SETTINGS);
  const [query, setQuery] = useState("");
  const [sortField, setSortField] = useState<"title" | "percent">("title");
  const [sortAscending, setSortAscending] = useState(true);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [cacheClearConfirmOpen, setCacheClearConfirmOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] = useState("");
  const [fields, setFields] = useState({ plexUrl: "", plexToken: "", tmdbToken: "", tvdbApiKey: "", tvdbPin: "" });
  const [changedFields, setChangedFields] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [configStatus, setConfigStatus] = useState<ConfigStatus>(EMPTY_CONFIG);

  useEffect(() => {
    void fetch("/api/plex/config", { cache: "no-store" }).then((response) => response.json()).then((body: ConfigStatus) => {
      setConfigStatus(body); setConfigured(body.configured); setFields((current) => ({ ...current, plexUrl: body.plexUrl }));
    }).catch(() => setError("Plex configuration could not be loaded."));
    void fetch("/api/plex/state", { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Plex preferences could not be loaded.");
      return body;
    }).then(({ settings: savedSettings }) => {
      setSettings({
        ignoredShows: Array.isArray(savedSettings?.ignoredShows) ? savedSettings.ignoredShows : [],
        hideUnairedEpisodes: savedSettings?.hideUnairedEpisodes === true,
        airingOffsetDays: Math.max(0, Math.min(30, Math.trunc(Number(savedSettings?.airingOffsetDays) || 0))),
        autoCompoundEpisodes: savedSettings?.autoCompoundEpisodes !== false,
        diagnosticsEnabled: savedSettings?.diagnosticsEnabled !== false,
      });
    }).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Plex preferences could not be loaded."));
    void fetch("/api/plex/scan", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      setStatus(body.scan); setReport(body.report);
      if (body.scan?.status === "running") void poll();
    }).catch(() => setError("The previous Plex scan status could not be loaded."));
    return () => pollAbortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!ignoredOpen && openShowMenu === null && openEpisodeMenu === null && !connectionOpen && !preferencesOpen && !sortMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (ignoredOpen && !target.closest(".summary-wrap")) setIgnoredOpen(false);
      if (openShowMenu !== null && !target.closest("[data-show-menu-id]")) setOpenShowMenu(null);
      if (openEpisodeMenu !== null && !target.closest(".plex-episode-item")) setOpenEpisodeMenu(null);
      if (sortMenuOpen && !target.closest('[data-menu-root="sort"]')) setSortMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIgnoredOpen(false); setOpenShowMenu(null); setOpenEpisodeMenu(null); setConnectionOpen(false); setPreferencesOpen(false); setSortMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [connectionOpen, ignoredOpen, openEpisodeMenu, openShowMenu, preferencesOpen, sortMenuOpen]);

  const ignoredIds = useMemo(() => new Set(settings.ignoredShows.map((show) => show.ratingKey)), [settings.ignoredShows]);
  const resultShows = useMemo(() => {
    const today = localToday();
    return (report?.shows || []).map((show) => ({ ...show, missing: show.missing.filter((episode) => shouldShowPlexMissingEpisode(episode.airDate, settings.hideUnairedEpisodes, settings.airingOffsetDays, today)) }));
  }, [report, settings.hideUnairedEpisodes, settings.airingOffsetDays]);
  const activeShows = useMemo(() => resultShows.filter((show) => !ignoredIds.has(show.ratingKey)), [resultShows, ignoredIds]);
  const missingCount = activeShows.reduce((sum, show) => sum + show.missing.length, 0);
  const activelyRateLimitPaused = isActiveRateLimitPause(scanning && status.status === "running", status.rateLimitPaused);
  const cacheCount = Object.keys(report?.scanCache || {}).length;
  const visible = useMemo(() => activeShows.filter((show) => show.missing.length && matchesSearch(show.title, query)).sort((a, b) => {
    if (sortField === "title") { const result = a.title.localeCompare(b.title); return sortAscending ? result : -result; }
    const aTotal = a.plexEpisodes + a.missing.length; const bTotal = b.plexEpisodes + b.missing.length;
    const result = (aTotal ? a.plexEpisodes / aTotal : 0) - (bTotal ? b.plexEpisodes / bTotal : 0) || a.title.localeCompare(b.title);
    return sortAscending ? result : -result;
  }), [activeShows, query, sortAscending, sortField]);

  async function poll() {
    pollAbortControllerRef.current?.abort();
    const controller = new AbortController();
    pollAbortControllerRef.current = controller;
    setScanning(true);
    try {
      while (!controller.signal.aborted) {
        const response = await fetch("/api/plex/scan", { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => ({})) as { scan?: Status; report?: Report | null; error?: string };
        if (!response.ok || !body.scan) throw new Error(body.error || "Plex scan status could not be loaded.");
        setStatus(body.scan);
        if (body.scan.status === "completed") { setReport(body.report || null); return; }
        if (body.scan.status === "error") { setError(body.scan.error || "The Plex scan failed."); return; }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    } catch (pollError) {
      if (!controller.signal.aborted) setError(pollError instanceof Error ? pollError.message : "Plex scan status could not be loaded.");
    } finally {
      if (pollAbortControllerRef.current === controller) pollAbortControllerRef.current = null;
      if (!controller.signal.aborted) setScanning(false);
    }
  }

  async function scan() {
    if (!configured) { setConnectionOpen(true); return; }
    setError("");
    const response = await fetch("/api/plex/scan", { method: "POST" });
    if (!response.ok) { setError("Shelfcheck could not start the Plex scan."); return; }
    await poll();
  }

  async function saveConfig() {
    setSaving(true); setError("");
    const patch = Object.fromEntries((Object.keys(changedFields) as FieldKey[]).filter((key) => changedFields[key]).map((key) => [key, fields[key]]));
    const response = await fetch("/api/plex/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const body = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) { setError(body.error || "Credentials could not be saved."); return; }
    setConfigured(body.configured === true); setConfigStatus(body as ConfigStatus); setConnectionOpen(false); setChangedFields({});
    setFields({ plexUrl: body.plexUrl || "", plexToken: "", tmdbToken: "", tvdbApiKey: "", tvdbPin: "" });
  }

  function saveSettings(next: PlexSettings) {
    setSettings(next);
    void fetch("/api/plex/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
  }

  function ignoreShow(show: Show) {
    saveSettings({ ...settings, ignoredShows: [...settings.ignoredShows.filter((item) => item.ratingKey !== show.ratingKey), { ratingKey: show.ratingKey, title: show.title }].sort((a, b) => a.title.localeCompare(b.title)) });
    setOpenShowMenu(null);
  }

  function restoreShow(ratingKey: string) { saveSettings({ ...settings, ignoredShows: settings.ignoredShows.filter((show) => show.ratingKey !== ratingKey) }); }
  function chooseSort(field: "title" | "percent") {
    if (field === sortField) setSortAscending((ascending) => !ascending);
    else { setSortField(field); setSortAscending(field === "title"); }
    setSortMenuOpen(false);
  }
  function toggleShow(ratingKey: string) {
    setCollapsedShows((current) => {
      const next = new Set(current);
      if (next.has(ratingKey)) next.delete(ratingKey); else next.add(ratingKey);
      return next;
    });
    setOpenShowMenu(null); setOpenEpisodeMenu(null);
  }
  function setAllShows(collapsed: boolean) {
    setCollapsedShows(collapsed ? new Set(visible.map((show) => show.ratingKey)) : new Set());
    setOpenShowMenu(null); setOpenEpisodeMenu(null);
  }
  function seasonKey(show: Show, season: number) { return `${show.ratingKey}:${season}`; }
  function setAllSeasons(show: Show, collapsed: boolean) {
    setCollapsedSeasons((current) => {
      const next = new Set(current);
      for (const season of new Set(show.missing.map((episode) => episode.season))) {
        if (collapsed) next.add(seasonKey(show, season)); else next.delete(seasonKey(show, season));
      }
      return next;
    });
    setOpenEpisodeMenu(null);
  }
  function toggleSeason(show: Show, season: number) {
    setCollapsedSeasons((current) => {
      const next = new Set(current); const key = seasonKey(show, season);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setOpenEpisodeMenu(null);
  }
  async function clearCache() {
    setClearingCache(true); setCacheMessage("");
    const response = await fetch("/api/plex/scan", { method: "DELETE" });
    const body = await response.json().catch(() => ({})) as { cleared?: number; error?: string };
    setClearingCache(false);
    if (!response.ok) { setError(body.error || "Shelfcheck could not clear the Plex scan cache."); return; }
    setReport(null); setCacheClearConfirmOpen(false);
    setCacheMessage(`${body.cleared || 0} cached Plex show results cleared. The next scan will rebuild them.`);
  }
  const saved = (key: FieldKey) => key === "plexUrl" ? Boolean(configStatus.plexUrl) : configStatus[`${key}Saved` as keyof ConfigStatus] === true;
  const updateField = (key: FieldKey, value: string) => { setFields((current) => ({ ...current, [key]: value })); setChangedFields((current) => ({ ...current, [key]: true })); };

  return <main>
    <header className="topbar">
      <div className="header-left"><Link className="brand" href="/"><span className="brandmark">S</span><span>Shelfcheck</span></Link><nav className="mode-switch" aria-label="Search source"><Link href="/trakt">Trakt</Link><Link className="active" href="/plex" aria-current="page">Plex</Link></nav></div>
      <div className="header-actions"><button className={`status ${configured ? "online" : ""}`} onClick={() => setConnectionOpen(true)}><i />{configured ? "Plex configured" : "Configure Plex Scan"}</button><button className="icon-button" onClick={() => setPreferencesOpen(true)} aria-label="Plex preferences">⚙</button></div>
    </header>
    <section className="hero">
      <div><p className="eyebrow">PLEX LIBRARY AUDIT</p><h1>Find what Plex<br />doesn’t have.</h1><p className="intro">Shelfcheck scans every show in your Plex TV libraries, resolves its TMDB and TVDB IDs, and compares your files with every non-special episode listed by both providers.</p></div>
      <div className="scan-panel"><div className="radar"><span>{scanning ? Math.round(status.processed / Math.max(status.total, 1) * 100) + "%" : missingCount}</span><small>{activelyRateLimitPaused ? `PAUSED · ${status.rateLimitProvider}` : scanning ? "SCANNING" : "MISSING"}</small></div><button className="primary" onClick={scan} disabled={scanning}>{activelyRateLimitPaused ? `Paused for ${status.rateLimitProvider} rate limit` : scanning ? `Checking ${status.processed} of ${status.total}…` : "New Plex search"}<b>→</b></button><p>{report ? `Last scan ${new Date(report.lastScan).toLocaleString()}` : "Only library metadata is read from Plex."}</p></div>
    </section>
    <div className="summary-wrap"><section className="summary scan-summary"><div><span>SHOWS IN COLLECTION</span><strong>{report?.shows.length || 0}</strong></div><div><span>SHOWS WITH MISSING EPISODES</span><strong>{activeShows.filter((show) => show.missing.length).length}</strong></div><div><span>MISSING EPISODES</span><strong>{missingCount}</strong></div><div className="ignored-stat"><button type="button" onClick={() => setIgnoredOpen((open) => !open)}><span>IGNORED SHOWS ↗</span><strong>{settings.ignoredShows.length}</strong></button></div></section>
      {ignoredOpen && <IgnoredShowsManager items={settings.ignoredShows.map((show) => ({ key: show.ratingKey, title: show.title }))} onClose={() => setIgnoredOpen(false)} onRestore={(key) => restoreShow(String(key))} />}
    </div>
    <section className="report"><div className="report-heading"><p className="eyebrow">PLEX MISSING REPORT</p><div className="report-primary-row"><h2>{missingCount} missing episodes</h2><ScanSortControl field={sortField} ascending={sortAscending} open={sortMenuOpen} onToggle={() => setSortMenuOpen((open) => !open)} onChoose={chooseSort} /></div><div className="report-secondary-row"><label className="search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search shows" /></label><div className="show-all-controls"><button onClick={() => setAllShows(false)}>Expand all</button><button onClick={() => setAllShows(true)}>Collapse all</button></div></div></div>
      {error && <div className="error"><span>!</span><p><strong>Scan error</strong>{error}</p></div>}
      {scanning ? <div className="loading"><span style={{ width: `${status.processed / Math.max(status.total, 1) * 100}%` }} /><p>SCANNING PLEX AND PROVIDERS…</p></div> : visible.length ? <div className="show-list">{visible.map((show, index) => {
        const seasons = [...new Set(show.missing.map((episode) => episode.season))].sort((a, b) => a - b);
        const showCollapsed = collapsedShows.has(show.ratingKey);
        const totalEpisodes = show.plexEpisodes + show.missing.length;
        const percentCollected = totalEpisodes ? Math.round((show.plexEpisodes / totalEpisodes) * 100) : null;
        return <article key={show.ratingKey}>
          <div className="collection-percent"><strong>{percentCollected === null ? "—" : `${percentCollected}%`}</strong><span>COLLECTED</span></div>
          <div className="show-index">{show.thumb ? <img src={`/api/plex/poster?thumb=${encodeURIComponent(show.thumb)}`} alt="" /> : String(index + 1).padStart(2, "0")}</div>
          <div className="show-info" data-show-menu-id={show.ratingKey}>
            <div className="show-title-line"><button className="show-name-button" onClick={() => setOpenShowMenu((current) => current === show.ratingKey ? null : show.ratingKey)}>{show.title}</button>{show.year && <small>{show.year}</small>}{show.tmdbId && <a className="brand-link" href={`https://www.themoviedb.org/tv/${show.tmdbId}`} target="_blank" rel="noreferrer" title="View show on TMDB"><img src="/tmdb-blue-square.svg" alt="TMDB" /></a>}{show.tvdbSlug && <a className="brand-link" href={`https://thetvdb.com/series/${encodeURIComponent(show.tvdbSlug)}`} target="_blank" rel="noreferrer" title="View show on TVDB"><img src={TVDB_LOGO} alt="TVDB" /></a>}<button className="show-collapse-toggle" onClick={() => toggleShow(show.ratingKey)} aria-expanded={!showCollapsed} aria-label={`${showCollapsed ? "Expand" : "Collapse"} ${show.title}`}>{showCollapsed ? "+" : "−"}</button></div>
            {openShowMenu === show.ratingKey && <div className="show-action-menu" role="menu"><button type="button" role="menuitem" onClick={() => ignoreShow(show)}>⊘ <span>Ignore this show</span></button></div>}
            {!showCollapsed && <><div className="compact-show-meta"><p>{show.plexEpisodes} collected · {show.missing.length} missing {show.missing.length === 1 ? "episode" : "episodes"}</p><div className="season-all-controls"><button onClick={() => setAllSeasons(show, false)}>Show all</button><button onClick={() => setAllSeasons(show, true)}>Collapse all</button></div></div>
            {show.warning && <p className="plex-warning">{show.warning}</p>}
            <div className="plex-seasons">{seasons.map((season) => {
              const episodes = show.missing.filter((episode) => episode.season === season).sort((a, b) => a.episode - b.episode);
              const collapsed = collapsedSeasons.has(seasonKey(show, season));
              return <section className="plex-season" key={season}>
                <button className="plex-season-heading" onClick={() => toggleSeason(show, season)} aria-expanded={!collapsed}><span>Season {String(season).padStart(2, "0")}</span><small>{episodes.length} missing</small><b>{collapsed ? "+" : "−"}</b></button>
                {!collapsed && <div className="plex-episode-grid">{episodes.map((episode) => {
                  const episodeKey = `${show.ratingKey}:${episode.season}:${episode.episode}`;
                  const tileDate = episodeTileDate(episode.airDate);
                  return <div className="plex-episode-item" key={episodeKey}>
                    <div className="episode-tile-row"><button className="episode-code-tile plex-episode-trigger" onClick={() => setOpenEpisodeMenu((current) => current === episodeKey ? null : episodeKey)} aria-expanded={openEpisodeMenu === episodeKey}><span>S{String(episode.season).padStart(2, "0")}E{String(episode.episode).padStart(2, "0")}</span>{tileDate && <small>{tileDate}</small>}</button><div className="episode-provider-links">{show.tmdbId && episode.sources.includes("TMDB") && <a href={`https://www.themoviedb.org/tv/${show.tmdbId}/season/${episode.season}/episode/${episode.episode}`} target="_blank" rel="noreferrer" title="View episode on TMDB" aria-label="View episode on TMDB"><img src="/tmdb-blue-square.svg" alt="" /></a>}{show.tvdbSlug && episode.tvdbEpisodeId && <a href={`https://thetvdb.com/series/${encodeURIComponent(show.tvdbSlug)}/episodes/${episode.tvdbEpisodeId}`} target="_blank" rel="noreferrer" title="View episode on TVDB" aria-label="View episode on TVDB"><img src={TVDB_LOGO} alt="" /></a>}</div></div>
                    {openEpisodeMenu === episodeKey && <div className="plex-episode-menu"><p><span>Aired</span><strong>{episode.airDate || "No Aired Date"}</strong></p><div>{show.tmdbId && episode.sources.includes("TMDB") && <a href={`https://www.themoviedb.org/tv/${show.tmdbId}/season/${episode.season}/episode/${episode.episode}`} target="_blank" rel="noreferrer"><img src="/tmdb-blue-square.svg" alt="" />View on TMDB</a>}{show.tvdbSlug && episode.tvdbEpisodeId && <a href={`https://thetvdb.com/series/${encodeURIComponent(show.tvdbSlug)}/episodes/${episode.tvdbEpisodeId}`} target="_blank" rel="noreferrer"><img src={TVDB_LOGO} alt="" />View on TVDB</a>}</div></div>}
                  </div>;
                })}</div>}
              </section>;
            })}</div></>}
          </div>
        </article>;
      })}</div> : <div className="empty"><div>✓</div><h3>{report ? "No matching episode gaps" : "Ready for a new Plex search"}</h3><p>{report ? "No episodes match the current airing and ignored-show preferences." : "Configure your providers, then scan every TV show library."}</p></div>}
    </section>
    <footer><span>SHELFCHECK / PLEX API</span><span>Your credentials stay in your private configuration volume.</span></footer>
    {connectionOpen && <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setConnectionOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="plex-providers-title"><button className="close" onClick={() => setConnectionOpen(false)} aria-label="Close">×</button><p className="eyebrow">CONFIG.YML</p><h2 id="plex-providers-title">Plex providers</h2><p className="modal-copy">Saved values are kept unless you replace them or click Clear. Secrets stay masked and are never returned to the browser. Saving does not start a scan.</p>{([ ["plexUrl","Plex server URL"], ["plexToken","Plex token"], ["tmdbToken","TMDB API read access token"], ["tvdbApiKey","TVDB v4 API key"], ["tvdbPin","TVDB subscriber PIN (optional)"] ] as [FieldKey,string][]).map(([key,label]) => <label key={key}><span className="credential-label"><span>{label} {saved(key) && <b>Saved</b>}</span>{saved(key) && <button type="button" onClick={() => updateField(key, "")}>Clear</button>}</span><input type={key === "plexUrl" ? "url" : "password"} value={fields[key]} placeholder={saved(key) && key !== "plexUrl" ? "Saved — enter a new value to replace" : ""} onChange={(event) => updateField(key, event.target.value)} /></label>)}<button className="primary full" onClick={saveConfig} disabled={saving}>{saving ? "Saving…" : "Save to config.yml"}<b>→</b></button></section></div>}
    {preferencesOpen && <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setPreferencesOpen(false)}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="plex-preferences-title">
        <button className="close" onClick={() => setPreferencesOpen(false)} aria-label="Close">×</button>
        <p className="eyebrow">SETTINGS</p><h2 id="plex-preferences-title">Shelfcheck preferences</h2>
        <div className="plex-preference"><div><strong>Hide unaired episodes</strong><p>Hide episodes until their listed air date plus the offset below. Episodes without an air date are also hidden.</p></div><input type="checkbox" checked={settings.hideUnairedEpisodes} onChange={(event) => saveSettings({ ...settings, hideUnairedEpisodes: event.target.checked })} /></div>
        <div className="grace-period"><div><p className="grace-title">Aired-date offset</p><p>Wait this many calendar days after an episode’s air date before showing it.</p></div><div className="grace-input"><input type="number" min="0" max="30" value={settings.airingOffsetDays} onChange={(event) => saveSettings({ ...settings, airingOffsetDays: Math.max(0, Math.min(30, Math.trunc(Number(event.target.value) || 0))) })} /><span>Days</span></div></div>
        <div className="plex-preference"><div><strong>Auto Compound Episodes</strong><p>As a final check, let one owned double-length TMDB episode satisfy matching split TVDB episodes.</p></div><input type="checkbox" checked={settings.autoCompoundEpisodes} onChange={(event) => saveSettings({ ...settings, autoCompoundEpisodes: event.target.checked })} /></div>
        <div className="diagnostics scan-cache-settings">
          <p className="diagnostics-toggle scan-cache-title">Scan cache</p>
          <p>Plex scans save the latest provider comparison so results remain available between visits. Clear the cache to remove that report and make the next scan rebuild every show.</p>
          <p className="scan-cache-status">Cached results for {cacheCount} {cacheCount === 1 ? "show" : "shows"}{report ? ` · Latest scan ${new Date(report.lastScan).toLocaleString()}` : ""}</p>
          {!cacheClearConfirmOpen ? <button type="button" onClick={() => { setCacheMessage(""); setCacheClearConfirmOpen(true); }} disabled={scanning || cacheCount === 0}>Clear scan cache</button> : <div className="cache-confirm">
            <p>This clears Plex scan results only. Your credentials, preferences, ignored shows, Trakt data, and logs will not change.</p>
            <div><button type="button" onClick={() => setCacheClearConfirmOpen(false)} disabled={clearingCache}>Cancel</button><button type="button" className="cache-clear-confirm" onClick={clearCache} disabled={clearingCache}>{clearingCache ? "Clearing…" : "Clear cache"}</button></div>
          </div>}
          {cacheMessage && <p className="cache-message">{cacheMessage}</p>}
        </div>
        <div className="diagnostics">
          <label className="diagnostics-toggle"><input type="checkbox" checked={settings.diagnosticsEnabled} onChange={(event) => saveSettings({ ...settings, diagnosticsEnabled: event.target.checked })} /> Enable diagnostic logging</label>
          <p>Records safe Plex scan details in /data/logs. Credentials and authorization headers are never logged. The latest 10 Plex scans are retained.</p>
          <DiagnosticLogActions endpoint="/api/plex/logs" filename="shelfcheck-plex.log" confirmMessage="Delete shelfcheck-plex.log and all nine retained Plex scan logs? This cannot be undone." downloadError="Shelfcheck could not download the current Plex log." deleteError="Shelfcheck could not delete the Plex diagnostic logs." onError={setError} />
        </div>
        <p className="build-info">Shelfcheck build {SHELFCHECK_VERSION}</p>
      </section>
    </div>}
  </main>;
}
