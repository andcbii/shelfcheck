"use client";
import { CoverageWarning } from "@/app/reports/components/coverage-issue-report";
import type { CoverageIssue } from "@/lib/coverage-issues";
import type { PlexProviderResolution } from "@/lib/plex-scan";
import { shownScanIssues } from "@/lib/scan-issues-shown";

/* Plex artwork is served through an authenticated app-owned proxy. */
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { INCOMPLETE_LABEL, missingPartsExplanation, type CoverageGroup } from "@/lib/manual-coverage-model";
import { ManualCoverageManager } from "@/app/components/manual-coverage-manager";
import { CatalogueNotice } from "@/app/components/catalogue-notice";
import { useMenuClosing } from "@/app/hooks/use-menu-closing";
import type { ShowCatalogueSelection } from "@/lib/catalogue-selection-store";
import { useEffect, useMemo, useRef, useState } from "react";
import { SHELFCHECK_VERSION } from "@/lib/version";
import { DiagnosticLogActions } from "@/app/components/diagnostic-log-actions";
import { IgnoredShowsManager } from "@/app/components/ignored-shows-manager";
import { IgnoreDurationModal } from "@/app/components/ignore-duration-modal";
import { ScanSortControl } from "@/app/components/scan-sort-control";
import { SeasonIgnoreModal } from "@/app/components/season-ignore-modal";
import { ShowActionsMenu } from "@/app/components/show-actions-menu";
import { resultsView } from "@/lib/results-view";
import { scanProgressPercent } from "@/lib/scan-progress";
import { useScanPoller } from "@/app/hooks/use-scan-poller";
import { useScanRunActivity } from "@/app/hooks/use-scan-run-activity";
import { useIgnoreClock } from "@/app/hooks/use-ignore-clock";
import { useClearCache } from "@/app/hooks/use-clear-cache";
import { useLocalToday } from "@/app/hooks/use-local-today";
import { activeIgnores, applyIgnore, changeIgnoreDuration as changeIgnoreRuleDuration, decodePlexManagerKey, ignoreManagerKey, openSeasonIgnore as openSeasonIgnoreRule, restoreIgnore, saveSeasonIgnore, type IgnoreDuration, type IgnoreTiming } from "@/lib/ignored-shows";
import { parsePlexPreferences } from "@/lib/preferences";

type Missing = { season: number; episode: number; title?: string; airDate?: string; tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: ("TMDB" | "TVDB")[] };
type Show = { ratingKey: string; title: string; year?: number; thumb?: string; tmdbId?: number; tvdbId?: number; tvdbSlug?: string; plexEpisodes: number; missing: Missing[]; warning?: string; catalogueSelection?: ShowCatalogueSelection; providerResolution?: PlexProviderResolution };
type Report = { shows: Show[]; lastScan: string; coverageGroups?: CoverageGroup[]; scanCache?: Record<string, unknown> };
type Status = { status: "idle" | "running" | "completed" | "error"; processed: number; total: number; error?: string; rateLimitPaused?: boolean; rateLimitProvider?: "Plex" | "TMDB" | "TVDB" };
type ConfigStatus = { plexUrl: string; plexTokenSaved: boolean; tmdbTokenSaved: boolean; tvdbApiKeySaved: boolean; tvdbPinSaved: boolean; configured: boolean };
type FieldKey = "plexUrl" | "plexToken" | "tmdbToken" | "tvdbApiKey" | "tvdbPin";
type IgnoredShow = { ratingKey: string; title: string } & IgnoreTiming;
type IgnoredSeasons = { ratingKey: string; title: string; seasons: number[] } & IgnoreTiming;
const plexKey = (rule: { ratingKey: string }) => rule.ratingKey;
type PlexSettings = { ignoredShows: IgnoredShow[]; ignoredSeasons: IgnoredSeasons[]; hideUnairedEpisodes: boolean; airingOffsetDays: number; autoCompoundEpisodes: boolean; diagnosticsEnabled: boolean };

const EMPTY_CONFIG: ConfigStatus = { plexUrl: "", plexTokenSaved: false, tmdbTokenSaved: false, tvdbApiKeySaved: false, tvdbPinSaved: false, configured: false };
const EMPTY_SETTINGS: PlexSettings = { ignoredShows: [], ignoredSeasons: [], hideUnairedEpisodes: false, airingOffsetDays: 0, autoCompoundEpisodes: true, diagnosticsEnabled: true };
const TVDB_LOGO = "/tvdb-square.svg";

function pruneClientReport(report: Report, invalidated: Set<string>): Report {
  return {
    ...report,
    shows: report.shows.filter((show) => !invalidated.has(show.ratingKey)),
    scanCache: Object.fromEntries(Object.entries(report.scanCache || {}).filter(([key]) => !invalidated.has(key))),
  };
}

function episodeTileDate(airDate: string | undefined, today: string) {
  if (!airDate) return "No Aired Date";
  const date = airDate.slice(0, 10);
  return date >= today ? date : null;
}

function plexPercent(show: Show, missing: readonly Missing[]) {
  const total = show.plexEpisodes + missing.length;
  return total ? show.plexEpisodes / total : 0;
}

export default function PlexPage() {
  const [coverageMappingId, setCoverageMappingId] = useState<string | undefined>();
  const [coverageUrls, setCoverageUrls] = useState<string[] | null>(null);
  const minimumCoverageRevision = useRef(0);
  const [coverageIssues, setCoverageIssues] = useState<CoverageIssue[]>([]);
  const [configured, setConfigured] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [openShowMenu, setOpenShowMenu] = useState<string | null>(null);
  const [showToIgnore, setShowToIgnore] = useState<Show | null>(null);
  const [openEpisodeMenu, setOpenEpisodeMenu] = useState<string | null>(null);
  const [seasonIgnoreShow, setSeasonIgnoreShow] = useState<Show | null>(null);
  const [seasonIgnoreDraft, setSeasonIgnoreDraft] = useState<number[]>([]);
  const [seasonIgnoreOptions, setSeasonIgnoreOptions] = useState<number[]>([]);
  const [seasonIgnoreDuration, setSeasonIgnoreDuration] = useState<IgnoreDuration>("forever");
  const [seasonIgnoreOriginalTiming, setSeasonIgnoreOriginalTiming] = useState<IgnoreTiming | null>(null);
  const [collapsedShows, setCollapsedShows] = useState<Set<string>>(new Set());
  const [collapsedSeasons, setCollapsedSeasons] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<Status>({ status: "idle", processed: 0, total: 0 });
  const [report, setReport] = useState<Report | null>(null);
  const reportInvalidations = useRef(new Set<string>());
  const scanRequestPending = useRef(false);
  const scanInProgress = useRef(false);
  const settingsSaves = useRef(0);
  const [settings, setSettings] = useState<PlexSettings>(EMPTY_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const today = useLocalToday();
  const [query, setQuery] = useState("");
  const [sortField, setSortField] = useState<"title" | "percent">("title");
  const [sortAscending, setSortAscending] = useState(true);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Plex's whole clear removes its report; a show's clear removes only its cache key.
  const { confirmOpen: cacheClearConfirmOpen, clearing: clearingCache, message: cacheMessage, clearMessage: clearCacheMessage, openConfirm: openCacheClearConfirm, cancelConfirm: cancelCacheClear, clearCache, clearShowCache } = useClearCache<Show>({
    cacheAddress: "/api/plex/scan",
    showAddress: (show) => `/api/plex/scan?ratingKey=${encodeURIComponent(show.ratingKey)}`,
    showTitle: (show) => show.title,
    cacheName: "Plex",
    onCacheCleared: () => setReport(null),
    onShowCleared: (show) => setReport((current) => current ? { ...current, scanCache: Object.fromEntries(Object.entries(current.scanCache || {}).filter(([key]) => key !== show.ratingKey)) } : current),
    closeShowMenu: () => setOpenShowMenu(null),
    onError: setError,
  });
  const [fields, setFields] = useState({ plexUrl: "", plexToken: "", tmdbToken: "", tvdbApiKey: "", tvdbPin: "" });
  const [changedFields, setChangedFields] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [configStatus, setConfigStatus] = useState<ConfigStatus>(EMPTY_CONFIG);
  const { poll, abort } = useScanPoller<{ scan?: Status; report?: Report | null; coverage?: { revision: number; pending: number; issues: CoverageIssue[] }; error?: string }>({
    url: "/api/plex/scan",
    onPollingChange: (polling) => { scanInProgress.current = polling; setScanning(polling); },
    onResponse: (body) => {
      if (!body.scan) throw new Error(body.error || "Plex scan status could not be loaded.");
      if ((body.coverage?.revision || 0) < minimumCoverageRevision.current) return false;
      minimumCoverageRevision.current = body.coverage?.revision || 0;
      setCoverageIssues(body.coverage?.issues || []);
      setStatus(body.scan);
      if (body.scan.status === "completed") { setReport(body.report ? pruneClientReport(body.report, reportInvalidations.current) : null); return true; }
      if (body.scan.status === "error") throw new Error(body.scan.error || "The Plex scan failed.");
      return false;
    },
  });
  const activity = useScanRunActivity("plex", {
    isFollowing: () => scanInProgress.current || scanRequestPending.current,
    poll: () => poll().catch((pollError) => {
      if (!(pollError instanceof DOMException && pollError.name === "AbortError")) setError(pollError instanceof Error ? pollError.message : "Plex scan status could not be loaded.");
    }),
  });

  useEffect(() => {
    const initialInvalidations = reportInvalidations.current;
    void fetch("/api/plex/config", { cache: "no-store" }).then((response) => response.json()).then((body: ConfigStatus) => {
      setConfigStatus(body); setConfigured(body.configured); setFields((current) => ({ ...current, plexUrl: body.plexUrl }));
    }).catch(() => setError("Plex configuration could not be loaded."));
    void fetch("/api/plex/state", { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Plex preferences could not be loaded.");
      return body;
    }).then(({ settings: savedSettings }) => {
      const parsedSettings = parsePlexPreferences(savedSettings);
      for (const show of activeIgnores(parsedSettings.ignoredShows)) reportInvalidations.current.add(show.ratingKey);
      setReport((current) => current ? pruneClientReport(current, reportInvalidations.current) : current);
      setSettings(parsedSettings);
      setSettingsLoaded(true);
    }).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Plex preferences could not be loaded."));
    void fetch("/api/plex/scan", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      if (initialInvalidations !== reportInvalidations.current || (body.coverage?.revision || 0) < minimumCoverageRevision.current) return;
      minimumCoverageRevision.current = body.coverage?.revision || 0;
      setCoverageIssues(body.coverage?.issues || []);
      setStatus(body.scan); setReport(body.report ? pruneClientReport(body.report, initialInvalidations) : null);
      if (body.scan?.status === "running") void poll().catch((pollError) => { if (!(pollError instanceof DOMException && pollError.name === "AbortError")) setError(pollError instanceof Error ? pollError.message : "Plex scan status could not be loaded."); });
    }).catch(() => setError("The previous Plex scan status could not be loaded."));
  }, [poll]);

  useMenuClosing([
    { open: ignoredOpen, isInside: (target) => target.closest(".summary-wrap") !== null, close: () => setIgnoredOpen(false) },
    { open: openShowMenu !== null, isInside: (target) => target.closest("[data-show-menu-id]") !== null, close: () => setOpenShowMenu(null) },
    { open: openEpisodeMenu !== null, isInside: (target) => target.closest(".plex-episode-item") !== null, close: () => setOpenEpisodeMenu(null) },
    { open: sortMenuOpen, isInside: (target) => target.closest('[data-menu-root="sort"]') !== null, close: () => setSortMenuOpen(false) },
    { open: connectionOpen, close: () => setConnectionOpen(false) },
    { open: preferencesOpen, close: () => setPreferencesOpen(false) },
  ], [() => setSeasonIgnoreShow(null)]);

  const ignoreRules = useMemo(() => [...settings.ignoredShows, ...settings.ignoredSeasons], [settings.ignoredShows, settings.ignoredSeasons]);
  const ignoreNow = useIgnoreClock(ignoreRules);
  const activeIgnoredShows = useMemo(() => activeIgnores(settings.ignoredShows, ignoreNow), [settings.ignoredShows, ignoreNow]);
  const activeIgnoredSeasons = useMemo(() => activeIgnores(settings.ignoredSeasons, ignoreNow), [settings.ignoredSeasons, ignoreNow]);
  const view = useMemo(() => resultsView({
    shows: (report?.shows || []).map((show) => ({ key: show.ratingKey, title: show.title, source: show, episodes: show.missing })),
    ignoredShows: new Set(activeIgnoredShows.map((show) => show.ratingKey)),
    ignoredSeasons: new Map(activeIgnoredSeasons.map((show) => [show.ratingKey, new Set(show.seasons)])),
    airedPolicy: settings.hideUnairedEpisodes ? "aired-only" : "show-all",
    airDateDelayDays: settings.airingOffsetDays,
    today,
    search: query,
    sortField,
    sortAscending,
    percent: plexPercent,
  }), [activeIgnoredSeasons, activeIgnoredShows, query, report, settings.airingOffsetDays, settings.hideUnairedEpisodes, sortAscending, sortField, today]);
  const visible = useMemo(() => view.shows.map((show) => ({ ...show.source, missing: show.episodes, percent: show.percent })), [view]);
  const missingCount = view.totals.missingEpisodes;
  const activelyRateLimitPaused = scanning && status.status === "running" && status.rateLimitPaused === true;
  const progress = scanProgressPercent(status.processed, status.total, scanning && status.status === "running");
  const cacheCount = Object.keys(report?.scanCache || {}).length;

  const visibleCoverageMissing = (member: CoverageGroup["missing"][number]) => visible.some(show => show.ratingKey === member.showKey && show.missing.some(episode => member.provider === "TMDB" ? episode.tmdbEpisodeId === member.id : episode.tvdbEpisodeId === member.id));
  const coverageGroups = (report?.coverageGroups || []).filter(group => group.missing.some(visibleCoverageMissing)).map(group => ({
    ...group,
    // Every missing variant (missing, Reported missing, incomplete) obeys Active ignores and the Aired rule
    // (the results view); hidden members stay as alternative context.
    members: group.members.map(member => (member.status === "missing" || member.status === "reported-missing" || member.status === "incomplete") && !group.missing.some(missing => missing.provider === member.provider && missing.id === member.id && visibleCoverageMissing(missing)) ? { ...member, status: "alternative" as const } : member),
  }));
  const groupedIdentities = new Set(coverageGroups.flatMap(group => group.members.map(member => `${member.provider}:${member.id}`)));
  function ungroupedMissing(show: Show) {
    return show.missing.map(episode => ({ ...episode, sources: episode.sources.filter(provider => !groupedIdentities.has(`${provider}:${provider === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)) })).filter(episode => episode.sources.length);
  }

  async function scan(show?: Show) {
    if (scanRequestPending.current || activity.isLocked()) return;
    if (!configured) { setConnectionOpen(true); return; }
    scanRequestPending.current = true;
    // Only a new scan can return results removed by a previous whole-show ignore.
    // Replace before POST so ignores applied while it is pending stay invalidated.
    reportInvalidations.current = new Set(activeIgnores(settings.ignoredShows).map((item) => item.ratingKey));
    abort();
    setError("");
    try {
      const response = await fetch("/api/plex/scan", {
        method: "POST",
        ...(show ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ratingKey: show.ratingKey }) } : {}),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; activeScanRun?: unknown };
      if (response.status === 409) activity.report(body.activeScanRun);
      if (!response.ok) throw new Error(body.error || (show ? `Shelfcheck could not check ${show.title}.` : "Shelfcheck could not start the Plex scan."));
      await poll();
      activity.refresh();
    } catch (scanError) { if (!(scanError instanceof DOMException && scanError.name === "AbortError")) setError(scanError instanceof Error ? scanError.message : "Shelfcheck could not start the Plex scan."); }
    finally { scanRequestPending.current = false; }
  }

  async function forceCheckShow(show: Show) {
    if (activity.isLocked()) return;
    setOpenShowMenu(null); clearCacheMessage();
    await scan(show);
  }

  async function saveConfig() {
    setSaving(true); setError("");
    try {
      const patch = Object.fromEntries((Object.keys(changedFields) as FieldKey[]).filter((key) => changedFields[key]).map((key) => [key, fields[key]]));
      const response = await fetch("/api/plex/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Credentials could not be saved.");
      setConfigured(body.configured === true); setConfigStatus(body as ConfigStatus); setConnectionOpen(false); setChangedFields({});
      setFields({ plexUrl: body.plexUrl || "", plexToken: "", tmdbToken: "", tvdbApiKey: "", tvdbPin: "" });
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Credentials could not be saved."); }
    finally { setSaving(false); }
  }

  function saveSettings(next: PlexSettings, patch: Partial<PlexSettings>, onRejected?: (saved: PlexSettings | undefined) => void) {
    if (!settingsLoaded) { setError("Wait for Plex preferences to finish loading."); return; }
    const save = ++settingsSaves.current;
    setSettings(next);
    void fetch("/api/plex/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          // A rejected Ignore (for example, flag cleanup during a scan) saved nothing:
          // show the saved preferences again instead of the optimistic ones.
          const saved = await fetch("/api/plex/state", { cache: "no-store" }).then((reply) => reply.ok ? reply.json() : null).catch(() => null) as { settings?: PlexSettings } | null;
          // A newer save owns the displayed settings; never roll it back.
          if (save === settingsSaves.current) {
            if (saved?.settings) setSettings(saved.settings);
            onRejected?.(saved?.settings);
          }
          throw new Error(body.error || "Plex preferences could not be saved.");
        }
        // Ignore cleanup rechecked cached comparisons on the server; show them now,
        // through the same revision and stale-response guards as Manual Match saves.
        const body = await response.json().catch(() => ({})) as { coverageRevision?: number };
        if (typeof body.coverageRevision === "number") coverageChanged(body.coverageRevision);
      })
      .catch((saveError) => setError(saveError instanceof Error ? saveError.message : "Plex preferences could not be saved."));
  }

  function ignoreShow(show: Show, duration: IgnoreDuration) {
    const ignoredShows = applyIgnore(settings.ignoredShows, plexKey, { ratingKey: show.ratingKey, title: show.title }, duration, Date.now());
    const hidden = report?.shows.filter((item) => item.ratingKey === show.ratingKey) || [];
    const hiddenCache = report?.scanCache?.[show.ratingKey];
    saveSettings({ ...settings, ignoredShows }, { ignoredShows }, (saved) => {
      // Restore results only when the server confirms the Ignore was not saved.
      if (!saved || activeIgnores(saved.ignoredShows).some((item) => item.ratingKey === show.ratingKey)) return;
      reportInvalidations.current.delete(show.ratingKey);
      setReport((current) => current && !current.shows.some((item) => item.ratingKey === show.ratingKey) ? { ...current, shows: [...current.shows, ...hidden], ...(hiddenCache === undefined ? {} : { scanCache: { ...current.scanCache, [show.ratingKey]: hiddenCache } }) } : current);
    });
    reportInvalidations.current.add(show.ratingKey);
    setReport((current) => current ? pruneClientReport(current, reportInvalidations.current) : current);
    setShowToIgnore(null);
    setOpenShowMenu(null);
  }

  function restoreShow(ratingKey: string) { const ignoredShows = restoreIgnore(settings.ignoredShows, plexKey, ratingKey, Date.now()); saveSettings({ ...settings, ignoredShows }, { ignoredShows }); }
  function restoreSeasons(ratingKey: string) { const ignoredSeasons = restoreIgnore(settings.ignoredSeasons, plexKey, ratingKey, Date.now()); saveSettings({ ...settings, ignoredSeasons }, { ignoredSeasons }); }
  function restoreManagerItem(key: string | number) {
    const target = decodePlexManagerKey(key);
    if (target?.kind === "show") restoreShow(target.key);
    else if (target?.kind === "seasons") restoreSeasons(target.key);
  }
  function changeIgnoreDuration(key: string | number, duration: IgnoreDuration) {
    const target = decodePlexManagerKey(key);
    const now = Date.now();
    if (target?.kind === "show") {
      const ignoredShows = changeIgnoreRuleDuration(settings.ignoredShows, plexKey, target.key, duration, now);
      saveSettings({ ...settings, ignoredShows }, { ignoredShows });
    } else if (target?.kind === "seasons") {
      const ignoredSeasons = changeIgnoreRuleDuration(settings.ignoredSeasons, plexKey, target.key, duration, now);
      saveSettings({ ...settings, ignoredSeasons }, { ignoredSeasons });
    }
  }
  function openSeasonIgnore(show: Show) {
    const fullShow = report?.shows.find((item) => item.ratingKey === show.ratingKey) || show;
    setSeasonIgnoreShow(fullShow);
    const draft = openSeasonIgnoreRule(settings.ignoredSeasons, plexKey, show.ratingKey, fullShow.missing.map((episode) => episode.season), Date.now());
    setSeasonIgnoreDraft(draft.selected);
    setSeasonIgnoreOptions(draft.options);
    setSeasonIgnoreDuration(draft.duration);
    setSeasonIgnoreOriginalTiming(draft.originalTiming);
    setOpenShowMenu(null);
  }
  function saveIgnoredSeasons() {
    if (!seasonIgnoreShow) return;
    const ignoredSeasons = saveSeasonIgnore(settings.ignoredSeasons, plexKey, { ratingKey: seasonIgnoreShow.ratingKey, title: seasonIgnoreShow.title }, { selected: seasonIgnoreDraft, duration: seasonIgnoreDuration, originalTiming: seasonIgnoreOriginalTiming }, Date.now());
    saveSettings({ ...settings, ignoredSeasons }, { ignoredSeasons });
    setSeasonIgnoreShow(null);
  }
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
  function linkEpisode(show: Show, episode: Missing) {
    setCoverageMappingId(undefined);
    const url = show.tmdbId && episode.tmdbEpisodeId
      ? `tmdb:${episode.tmdbEpisodeId} show:${show.tmdbId} season:${episode.season} episode:${episode.episode}`
      : show.tvdbSlug && episode.tvdbEpisodeId
        ? `https://thetvdb.com/series/${encodeURIComponent(show.tvdbSlug)}/episodes/${episode.tvdbEpisodeId}`
        : "";
    setCoverageUrls([url]);
    setOpenEpisodeMenu(null);
  }

  function coverageChanged(revision: number) {
    minimumCoverageRevision.current = Math.max(minimumCoverageRevision.current, revision);
    reportInvalidations.current = new Set(reportInvalidations.current);
    const invalidations=reportInvalidations.current;
    abort();
    void fetch("/api/plex/scan",{cache:"no-store"}).then(async response=>{
      const body=await response.json();
      if(!response.ok || !body.scan) throw new Error(body.error || "Coverage recheck could not be loaded.");
      if(invalidations!==reportInvalidations.current || (body.coverage?.revision || 0)<minimumCoverageRevision.current) return;
      minimumCoverageRevision.current=body.coverage?.revision || 0;
      setCoverageIssues(body.coverage?.issues || []);
      setStatus(body.scan);
      setReport(body.report ? pruneClientReport(body.report,invalidations) : null);
      if(body.scan.status==="running") await poll();
    }).catch(error=>{
      if (!(error instanceof DOMException && error.name === "AbortError")) setError(error instanceof Error ? error.message : "Coverage recheck failed.");
    });
  }

  const saved = (key: FieldKey) => key === "plexUrl" ? Boolean(configStatus.plexUrl) : configStatus[`${key}Saved` as keyof ConfigStatus] === true;
  const updateField = (key: FieldKey, value: string) => { setFields((current) => ({ ...current, [key]: value })); setChangedFields((current) => ({ ...current, [key]: true })); };

  return <main>
    <header className="topbar">
      <div className="header-left"><Link className="brand" href="/"><span className="brandmark">S</span><span>Shelfcheck</span></Link><nav className="mode-switch" aria-label="Search source"><Link href="/trakt">Trakt</Link><Link className="active" href="/plex" aria-current="page">Plex</Link></nav></div>
      <div className="header-actions"><button className={`status ${configured ? "online" : ""}`} onClick={() => setConnectionOpen(true)}><i />{configured ? "Plex configured" : "Configure Plex Scan"}</button><button className="icon-button" onClick={() => setPreferencesOpen(true)} aria-label="Plex preferences" disabled={!settingsLoaded}>⚙</button></div>
    </header>
    <section className="hero">
      <div><p className="eyebrow">PLEX LIBRARY AUDIT</p><h1>Find what Plex<br />doesn’t have.</h1><p className="intro">Shelfcheck scans every show in your Plex TV libraries, resolves its TMDB and TVDB IDs, and compares your files with every non-special episode listed by both providers.</p></div>
      <div className="scan-panel"><div className="radar"><span>{scanning ? `${progress}%` : missingCount}</span><small>{activelyRateLimitPaused ? `PAUSED · ${status.rateLimitProvider}` : scanning ? "SCANNING" : "MISSING"}</small></div><button className="primary" onClick={() => void scan()} disabled={scanning || activity.locked}>{activelyRateLimitPaused ? `Paused for ${status.rateLimitProvider} rate limit` : scanning ? `Checking ${status.processed} of ${status.total}…` : "New Plex search"}<b>→</b></button><p>{report ? `Last scan ${new Date(report.lastScan).toLocaleString()}` : "Only library metadata is read from Plex."}</p>{activity.lockMessage && <p className="scan-run-lock" role="status">{activity.lockMessage}</p>}</div>
    </section>
    <div className="summary-wrap"><section className="summary scan-summary"><div><span>SHOWS IN COLLECTION</span><strong>{report?.shows.length || 0}</strong></div><div><span>SHOWS WITH MISSING EPISODES</span><strong>{view.totals.shows}</strong></div><div><span>MISSING EPISODES</span><strong>{missingCount}</strong></div><div className="ignored-stat"><button type="button" onClick={() => setIgnoredOpen((open) => !open)}><span>IGNORED SHOWS ↗</span><strong>{activeIgnoredShows.length + activeIgnoredSeasons.length}</strong></button></div></section>
      {ignoredOpen && <IgnoredShowsManager items={[...activeIgnoredShows.map((show) => ({ ...show, key: ignoreManagerKey("show", show.ratingKey), title: show.title })), ...activeIgnoredSeasons.map((show) => ({ ...show, key: ignoreManagerKey("seasons", show.ratingKey), title: show.title, detail: `▤ ${show.seasons.map((season) => `S${String(season).padStart(2, "0")}`).join(", ")}` }))]} onClose={() => setIgnoredOpen(false)} onChangeDuration={changeIgnoreDuration} onRestore={restoreManagerItem} />}
    </div>
    <div className="episode-reports-nav"><Link className="episode-reports-link" href="/reports">Reports <span>→</span></Link></div>
    <section className="report"><div className="report-heading"><p className="eyebrow">PLEX MISSING REPORT</p><div className="report-primary-row"><h2>{missingCount} missing episodes</h2><ScanSortControl field={sortField} ascending={sortAscending} open={sortMenuOpen} onToggle={() => setSortMenuOpen((open) => !open)} onChoose={chooseSort} /></div><div className="report-secondary-row"><label className="search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search shows" /></label><div className="show-all-controls"><button onClick={() => setAllShows(false)}>Expand all</button><button onClick={() => setAllShows(true)}>Collapse all</button></div></div></div>
      {error && <div className="error"><span>!</span><p><strong>Scan error</strong>{error}</p></div>}
      <CoverageWarning issues={shownScanIssues(coverageIssues, report?.shows || [])} />
      {cacheMessage && !preferencesOpen && <p className="cache-message show-cache-message">{cacheMessage}</p>}
      {!scanning && coverageGroups.map(group => <section key={group.mappingId} className="coverage-result-group" aria-label="Incomplete coverage group">
        <div className="coverage-group-heading"><h3>Incomplete episode coverage</h3><button onClick={() => { setCoverageMappingId(group.mappingId); setCoverageUrls([]); }}>Edit coverage mapping</button></div>
        <p>Owning every TMDB episode in this Manual Match covers its TVDB episodes; owning TVDB episodes never covers a TMDB episode. Automatic matches keep their status and do not count as directly owned members.</p>
        {(["TMDB", "TVDB"] as const).map(provider => <section key={provider}><h4>Alternative complete {provider} set</h4><ul>{group.members.filter(member => member.provider === provider).map(member => <li key={`${member.provider}:${member.id}`}><a href={member.url} target="_blank" rel="noreferrer">{member.provider} · {member.show} · S{String(member.season).padStart(2, "0")}E{String(member.episode).padStart(2, "0")} · {member.title} · Episode ID {member.id}</a><strong>{member.status === "reported-missing" ? "Reported missing" : member.status === "incomplete" ? INCOMPLETE_LABEL : member.status === "direct" ? "Directly owned" : member.status === "automatic" ? "Satisfied automatically" : member.status === "manual" ? "Covered by complete alternative set" : member.status === "missing" ? "Missing" : "Alternative · outside this comparison"}</strong>{member.status === "incomplete" && member.missingParts?.length ? <small>{missingPartsExplanation(group.members, member.missingParts)}</small> : null}</li>)}</ul></section>)}
      </section>)}
      {scanning ? <div className="loading"><span style={{ width: `${progress}%` }} /><p>SCANNING PLEX AND PROVIDERS…</p></div> : visible.length ? <div className="show-list">{visible.map((show, index) => {
        const seasons = [...new Set(ungroupedMissing(show).map((episode) => episode.season))].sort((a, b) => a - b);
        const showCollapsed = collapsedShows.has(show.ratingKey);
        const percentCollected = Math.round(show.percent * 100);
        return <article key={show.ratingKey}>
          <div className="collection-percent"><strong>{`${percentCollected}%`}</strong><span>COLLECTED</span></div>
          <div className="show-index">{show.thumb ? <img src={`/api/plex/poster?thumb=${encodeURIComponent(show.thumb)}`} alt="" /> : String(index + 1).padStart(2, "0")}</div>
          <div className="show-info" data-show-menu-id={show.ratingKey}>
            <div className="show-title-line"><button className="show-name-button" onClick={() => setOpenShowMenu((current) => current === show.ratingKey ? null : show.ratingKey)}>{show.title}</button>{show.year && <small>{show.year}</small>}{show.tmdbId && <a className="brand-link" href={`https://www.themoviedb.org/tv/${show.tmdbId}`} target="_blank" rel="noreferrer" title="View show on TMDB"><img src="/tmdb-blue-square.svg" alt="TMDB" /></a>}{show.tvdbSlug && <a className="brand-link" href={`https://thetvdb.com/series/${encodeURIComponent(show.tvdbSlug)}`} target="_blank" rel="noreferrer" title="View show on TVDB"><img src={TVDB_LOGO} alt="TVDB" /></a>}<button className="show-collapse-toggle" onClick={() => toggleShow(show.ratingKey)} aria-expanded={!showCollapsed} aria-label={`${showCollapsed ? "Expand" : "Collapse"} ${show.title}`}>{showCollapsed ? "+" : "−"}</button></div>
            {activeIgnoredSeasons.find((item) => item.ratingKey === show.ratingKey) && <div className="ignored-season-status">Ignored {activeIgnoredSeasons.find((item) => item.ratingKey === show.ratingKey)!.seasons.map((season) => `S${String(season).padStart(2, "0")}`).join(", ")}</div>}
            {openShowMenu === show.ratingKey && <ShowActionsMenu onIgnoreShow={() => { setShowToIgnore(show); setOpenShowMenu(null); }} onForceCheck={() => void forceCheckShow(show)} forceCheckDisabled={activity.locked} onClearCache={() => void clearShowCache(show)} onIgnoreSeasons={() => openSeasonIgnore(show)} />}
            {!showCollapsed && <><div className="compact-show-meta"><p>{show.plexEpisodes} collected · {show.missing.length} missing {show.missing.length === 1 ? "episode" : "episodes"}</p><div className="season-all-controls"><button onClick={() => setAllSeasons(show, false)}>Show all</button><button onClick={() => setAllSeasons(show, true)}>Collapse all</button></div></div>
            <CatalogueNotice identity={show.ratingKey} selection={show.catalogueSelection} />
            {show.warning && <p className="plex-warning">{show.warning}</p>}
            <div className="plex-seasons">{seasons.map((season) => {
              const episodes = ungroupedMissing(show).filter((episode) => episode.season === season).sort((a, b) => a.episode - b.episode);
              const collapsed = collapsedSeasons.has(seasonKey(show, season));
              return <section className="plex-season" key={season}>
                <button className="plex-season-heading" onClick={() => toggleSeason(show, season)} aria-expanded={!collapsed}><span>Season {String(season).padStart(2, "0")}</span><small>{episodes.length} missing</small><b>{collapsed ? "+" : "−"}</b></button>
                {!collapsed && <div className="plex-episode-grid">{episodes.map((episode) => {
                  const episodeKey = `${show.ratingKey}:${episode.season}:${episode.episode}`;
                  const tileDate = episodeTileDate(episode.airDate, today);
                  return <div className="plex-episode-item" key={episodeKey}>
                    <div className="episode-tile-row"><button className="episode-code-tile plex-episode-trigger" onClick={() => setOpenEpisodeMenu((current) => current === episodeKey ? null : episodeKey)} aria-expanded={openEpisodeMenu === episodeKey}><span>S{String(episode.season).padStart(2, "0")}E{String(episode.episode).padStart(2, "0")}</span>{tileDate && <small>{tileDate}</small>}</button><div className="episode-provider-links">{show.tmdbId && episode.sources.includes("TMDB") && <a href={`https://www.themoviedb.org/tv/${show.tmdbId}/season/${episode.season}/episode/${episode.episode}`} target="_blank" rel="noreferrer" title="View episode on TMDB" aria-label="View episode on TMDB"><img src="/tmdb-blue-square.svg" alt="" /></a>}{show.tvdbSlug && episode.tvdbEpisodeId && <a href={`https://thetvdb.com/series/${encodeURIComponent(show.tvdbSlug)}/episodes/${episode.tvdbEpisodeId}`} target="_blank" rel="noreferrer" title="View episode on TVDB" aria-label="View episode on TVDB"><img src={TVDB_LOGO} alt="" /></a>}</div></div>
                    {openEpisodeMenu === episodeKey && <div className="plex-episode-menu"><button onClick={() => linkEpisode(show, episode)}>Matching Episodes</button><p><span>Aired</span><strong>{episode.airDate || "No Aired Date"}</strong></p><div>{show.tmdbId && episode.sources.includes("TMDB") && <a href={`https://www.themoviedb.org/tv/${show.tmdbId}/season/${episode.season}/episode/${episode.episode}`} target="_blank" rel="noreferrer"><img src="/tmdb-blue-square.svg" alt="" />View on TMDB</a>}{show.tvdbSlug && episode.tvdbEpisodeId && <a href={`https://thetvdb.com/series/${encodeURIComponent(show.tvdbSlug)}/episodes/${episode.tvdbEpisodeId}`} target="_blank" rel="noreferrer"><img src={TVDB_LOGO} alt="" />View on TVDB</a>}</div></div>}
                  </div>;
                })}</div>}
              </section>;
            })}</div></>}
          </div>
        </article>;
      })}</div> : <div className="empty"><div>✓</div><h3>{report ? "No matching episode gaps" : "Ready for a new Plex search"}</h3><p>{report ? "No episodes match the current airing and ignored-show preferences." : "Configure your providers, then scan every TV show library."}</p></div>}
    </section>
    <footer><span>SHELFCHECK / PLEX API</span><span>Your credentials stay in your private configuration volume.</span></footer>
    {coverageUrls && <ManualCoverageManager initialMappingId={coverageMappingId} initialUrls={coverageUrls} scanActive={scanning} onClose={() => setCoverageUrls(null)} onChanged={coverageChanged} />}
    {showToIgnore && <IgnoreDurationModal showTitle={showToIgnore.title} onClose={() => setShowToIgnore(null)} onSelect={(duration) => ignoreShow(showToIgnore, duration)} />}
      {seasonIgnoreShow && <SeasonIgnoreModal showTitle={seasonIgnoreShow.title} seasons={seasonIgnoreOptions.map((season) => ({ number: season, issueCount: seasonIgnoreShow.missing.filter((episode) => episode.season === season).length }))} selected={seasonIgnoreDraft} duration={seasonIgnoreDuration} onDurationChange={setSeasonIgnoreDuration} onChange={setSeasonIgnoreDraft} onClose={() => setSeasonIgnoreShow(null)} onSave={saveIgnoredSeasons} />}
    {connectionOpen && <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setConnectionOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="plex-providers-title"><button className="close" onClick={() => setConnectionOpen(false)} aria-label="Close">×</button><p className="eyebrow">CONFIG.YML</p><h2 id="plex-providers-title">Plex providers</h2><p className="modal-copy">Saved values are kept unless you replace them or click Clear. Secrets stay masked and are never returned to the browser. Saving does not start a scan.</p>{([ ["plexUrl","Plex server URL"], ["plexToken","Plex token"], ["tmdbToken","TMDB API read access token"], ["tvdbApiKey","TVDB v4 API key"], ["tvdbPin","TVDB subscriber PIN (optional)"] ] as [FieldKey,string][]).map(([key,label]) => <label key={key}><span className="credential-label"><span>{label} {saved(key) && <b>Saved</b>}</span>{saved(key) && <button type="button" onClick={() => updateField(key, "")}>Clear</button>}</span><input type={key === "plexUrl" ? "url" : "password"} value={fields[key]} placeholder={saved(key) && key !== "plexUrl" ? "Saved — enter a new value to replace" : ""} onChange={(event) => updateField(key, event.target.value)} /></label>)}<button className="primary full" onClick={saveConfig} disabled={saving}>{saving ? "Saving…" : "Save to config.yml"}<b>→</b></button></section></div>}
    {preferencesOpen && <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setPreferencesOpen(false)}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="plex-preferences-title">
        <button className="close" onClick={() => setPreferencesOpen(false)} aria-label="Close">×</button>
        <p className="eyebrow">SETTINGS</p><h2 id="plex-preferences-title">Shelfcheck preferences</h2>
        <div className="plex-preference"><div><strong>Hide unaired episodes</strong><p>Hide episodes until their listed air date plus the Air-date delay below. Episodes without an air date are also hidden.</p></div><input type="checkbox" checked={settings.hideUnairedEpisodes} onChange={(event) => { const hideUnairedEpisodes = event.target.checked; saveSettings({ ...settings, hideUnairedEpisodes }, { hideUnairedEpisodes }); }} /></div>
        <div className="grace-period"><div><p className="grace-title">Air-date delay</p><p>Treat each episode’s air date as this many calendar days later before showing it as missing.</p></div><div className="grace-input"><input type="number" min="0" max="30" value={settings.airingOffsetDays} onChange={(event) => { const airingOffsetDays = Math.max(0, Math.min(30, Math.trunc(Number(event.target.value) || 0))); saveSettings({ ...settings, airingOffsetDays }, { airingOffsetDays }); }} /><span>Days</span></div></div>
        <div className="plex-preference"><div><strong>Auto Compound Episodes</strong><p>As a final check, let one owned double-length TMDB episode satisfy matching split TVDB episodes.</p></div><input type="checkbox" checked={settings.autoCompoundEpisodes} onChange={(event) => { const autoCompoundEpisodes = event.target.checked; saveSettings({ ...settings, autoCompoundEpisodes }, { autoCompoundEpisodes }); }} /></div>
        <div className="diagnostics scan-cache-settings">
          <p className="diagnostics-toggle scan-cache-title">Scan cache</p>
          <p>Plex scans save the latest provider comparison so results remain available between visits. Clear the cache to remove that report and make the next scan rebuild every show.</p>
          <p className="scan-cache-status">Cached results for {cacheCount} {cacheCount === 1 ? "show" : "shows"}{report ? ` · Latest scan ${new Date(report.lastScan).toLocaleString()}` : ""}</p>
          {!cacheClearConfirmOpen ? <button type="button" onClick={openCacheClearConfirm} disabled={scanning || cacheCount === 0}>Clear scan cache</button> : <div className="cache-confirm">
            <p>This clears Plex scan results only. Your credentials, preferences, ignored shows, Trakt data, and logs will not change.</p>
            <div><button type="button" onClick={cancelCacheClear} disabled={clearingCache}>Cancel</button><button type="button" className="cache-clear-confirm" onClick={clearCache} disabled={clearingCache}>{clearingCache ? "Clearing…" : "Clear cache"}</button></div>
          </div>}
          {cacheMessage && <p className="cache-message">{cacheMessage}</p>}
        </div>
        <div className="diagnostics">
          <label className="diagnostics-toggle"><input type="checkbox" checked={settings.diagnosticsEnabled} onChange={(event) => { const diagnosticsEnabled = event.target.checked; saveSettings({ ...settings, diagnosticsEnabled }, { diagnosticsEnabled }); }} /> Enable diagnostic logging</label>
          <p>Records safe Plex scan details in /data/logs. Credentials and authorization headers are never logged. The latest 10 Plex scans are retained.</p>
          <DiagnosticLogActions endpoint="/api/plex/logs" filename="shelfcheck-plex.log" confirmMessage="Delete shelfcheck-plex.log and all nine retained Plex scan logs? This cannot be undone." downloadError="Shelfcheck could not download the current Plex log." deleteError="Shelfcheck could not delete the Plex diagnostic logs." onError={setError} />
        </div>
        <p className="build-info">Shelfcheck build {SHELFCHECK_VERSION}</p>
      </section>
    </div>}
  </main>;
}
