"use client";

import { useEffect, useState } from "react";
import type { CatalogueProvider } from "@/lib/catalogue-selection";
import type { ShowCatalogueSelection } from "@/lib/catalogue-selection-store";
import type { MultipleProviderIdEntry, ProviderPanel } from "@/lib/multiple-provider-ids-report";
import { ReportPagination } from "@/app/reports/report-pagination";

const NAME: Record<CatalogueProvider, string> = { tmdb: "TMDB", tvdb: "TVDB" };
type Feedback = { tone: "saved" | "error"; text: string };
type Props = { entries: MultipleProviderIdEntry[]; initialScanning: boolean; onChanged: () => void };

/** The persisted choice a panel's radios start from: the saved override, else the automatic choice. */
const persistedChoice = (panel: ProviderPanel) => panel.selection.override ?? panel.selection.automaticId;

function CandidatePanel({ entry, panel, locked, onSaved }: { entry: MultipleProviderIdEntry; panel: ProviderPanel; locked: boolean; onSaved: () => void }) {
  const [choice, setChoice] = useState(persistedChoice(panel));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const override = panel.selection.override;
  useEffect(() => { setChoice(persistedChoice(panel)); }, [panel]);

  async function save(seriesId: number | null) {
    if (locked || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/plex/catalogue-selection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: entry.identity, provider: panel.provider, seriesId }) });
      const body = await response.json() as { error?: string; selection?: ShowCatalogueSelection | null };
      const persisted = body.selection?.[panel.provider];
      // Always show what the server persisted, including after a rejection.
      setChoice(persisted ? persisted.override ?? persisted.automaticId : persistedChoice(panel));
      if (!response.ok) throw new Error(body.error || "The catalogue selection could not be saved.");
      const compared = persisted?.current?.preferredId === persisted?.preferredId;
      const what = seriesId === null ? "Automatic selection restored" : "Override saved";
      setFeedback({ tone: "saved", text: compared ? `${what}; the show was rechecked from saved data.` : `${what}; the next Plex scan downloads and compares it.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "The catalogue selection could not be saved." });
    } finally {
      setBusy(false);
      onSaved();
    }
  }

  const name = NAME[panel.provider];
  const count = panel.candidates.length;
  return <section className="show-provider-matches catalogue-panel">
    <header><span className={`provider-badge ${panel.provider}`}>{name}</span><strong>{count} {count === 1 ? "ID" : "IDs"}</strong></header>
    {count ? <fieldset disabled={locked || busy || !panel.multiple}><legend>{name} series reported by Plex</legend>{panel.candidates.map(candidate => {
      const marks = [candidate.automatic ? (panel.multiple ? "Automatic" : "Automatic selection") : "", candidate.override ? "Saved preference" : "", candidate.using ? "In use" : "", candidate.unavailable ? "Unavailable" : ""].filter(Boolean);
      const content = <><div><strong>{candidate.name || `${name} series ${candidate.id}`}</strong>{candidate.year ? <small>{candidate.year}</small> : null}</div><code>{candidate.id}</code><span className="catalogue-marks">{marks.map(mark => <em key={mark} className={mark === "Unavailable" ? "unavailable" : undefined}>{mark}</em>)}</span><a href={candidate.href} target="_blank" rel="noreferrer" aria-label={`Open ${name} ${candidate.id}`}>↗</a></>;
      return panel.multiple
        ? <label className="catalogue-candidate" key={candidate.id}><input type="radio" name={`${entry.anchor}-${panel.provider}`} value={candidate.id} checked={choice === candidate.id} disabled={locked || busy} onChange={() => setChoice(candidate.id)} />{content}</label>
        : <div className="catalogue-candidate" key={candidate.id}>{content}</div>;
    })}</fieldset> : <p className="catalogue-none">Plex reports no {name} series for this show.</p>}
    {panel.multiple ? <div className="catalogue-actions">
      <button type="button" onClick={() => void save(choice ?? null)} disabled={locked || busy || choice === undefined || choice === override}>Save override</button>
      <button type="button" onClick={() => void save(null)} disabled={locked || busy || override === undefined}>Use automatic</button>
    </div> : null}
    {feedback ? <p className={`catalogue-feedback ${feedback.tone}`} role="status">{feedback.text}</p> : null}
  </section>;
}

function Entry({ entry, locked, onChanged }: { entry: MultipleProviderIdEntry; locked: boolean; onChanged: () => void }) {
  const providers = (["tmdb", "tvdb"] as const).filter(provider => entry.panels[provider].candidates.length || entry.panels[provider].selection.current);
  return <article className="provider-match-row multiple-id-row" id={entry.anchor}>
    <header><div><span>Plex show</span><h2>{entry.title}{entry.year ? <small>{entry.year}</small> : null}</h2></div><div className="plex-guid-list"><code>{entry.identity}</code></div></header>
    <div className="provider-match-columns">{(["tmdb", "tvdb"] as const).map(provider => <CandidatePanel key={provider} entry={entry} panel={entry.panels[provider]} locked={locked} onSaved={onChanged} />)}</div>
    <div className="catalogue-summary">{providers.map(provider => {
      const summary = entry.panels[provider].summary;
      return <div key={provider}><span className={`provider-badge ${provider}`}>{NAME[provider]}</span><dl><div><dt>Currently using</dt><dd>{summary.using}</dd></div><div><dt>Preference</dt><dd>{summary.preference}</dd></div></dl>{summary.explanation ? <p>{summary.explanation}</p> : null}</div>;
    })}</div>
    {entry.issues.length ? <ul className="catalogue-issues">{entry.issues.map(issue => <li key={issue.id}><strong>Scan Issue</strong> {issue.lookup?.impact || issue.cause} <a href="/reports/coverage-issues">View Scan Issues</a></li>)}</ul> : null}
  </article>;
}

/** The page holding an entry whose anchor is the location fragment, if any. */
function linkedIndex(entries: MultipleProviderIdEntry[]) {
  const fragment = window.location.hash.slice(1);
  if (!fragment) return -1;
  let decoded = fragment;
  try { decoded = decodeURIComponent(fragment); } catch { /* keep the raw fragment */ }
  return entries.findIndex(entry => entry.anchor === fragment || entry.anchor === decoded || `show-${entry.identity}` === decoded);
}

export function MultipleProviderIdReport({ entries, initialScanning, onChanged }: Props) {
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [scanning, setScanning] = useState(initialScanning);
  const [linked, setLinked] = useState<string | null>(null);

  useEffect(() => {
    // A linked show can be on any page: open the page that holds it.
    const open = () => {
      const index = linkedIndex(entries);
      if (index < 0) return;
      setPage(Math.floor(index / pageSize) + 1);
      setLinked(entries[index].anchor);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [entries, pageSize]);
  useEffect(() => {
    if (linked) document.getElementById(linked)?.scrollIntoView?.({ block: "start" });
  }, [linked, page]);
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const response = await fetch("/api/plex/scan", { cache: "no-store" });
        const body = await response.json();
        if (active && response.ok) setScanning(body.scan?.status === "running");
      } catch { /* The API still rejects a change during a scan if polling fails. */ }
    }
    const timer = setInterval(() => void poll(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const visible = entries.slice((page - 1) * pageSize, page * pageSize);
  function choosePageSize(value: number) { setPageSize(value); setPage(1); }
  return <>
    {scanning ? <p className="catalogue-scan-note" role="status">A Plex scan is running. Wait for it to finish before changing comparison catalogues.</p> : null}
    {visible.length ? <div className="provider-match-list">{visible.map(entry => <Entry key={entry.identity} entry={entry} locked={scanning} onChanged={onChanged} />)}</div>
      : <div className="empty auto-match-empty"><div>✓</div><h3>No shows with multiple provider IDs</h3><p>Plex reports at most one TMDB and one TVDB series for every scanned show.</p></div>}
    <ReportPagination total={entries.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={choosePageSize} />
  </>;
}
