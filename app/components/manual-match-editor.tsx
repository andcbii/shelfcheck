"use client";
import { useEffect, useRef, useState } from "react";
import { ReportPagination } from "@/app/reports/report-pagination";
import type { CoverageEvidence, CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
type Props = {
  initialUrls: string[];
  initialMappingId?: string;
  report?: boolean;
  scanActive?: boolean;
  onChanged: (revision: number) => void;
};
export function ManualMatchEditor({ initialUrls, initialMappingId, onChanged, report = false, scanActive = false }: Props) {
  const [formOpen, setFormOpen] = useState(!report);
  const [scanning, setScanning] = useState(scanActive);
  const [urls, setUrls] = useState(initialUrls.length > 1 ? initialUrls : [initialUrls[0] || "", ""]);
  const [editing, setEditing] = useState<CoverageMapping | null>(null);
  const [mappings, setMappings] = useState<CoverageMapping[]>([]);
  const [preview, setPreview] = useState<{
    preview: string;
    members: CoverageMember[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const acceptedRevision = useRef(0);
  const [revision, setRevision] = useState(0);
  const [selectedParts, setSelectedParts] = useState<Record<string, string[]>>({});
  const [pending, setPending] = useState(false);
  const [healthFilter, setHealthFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<string[] | null>(null);
  const locked = busy || scanActive || scanning;
  const visibleMappings = mappings.filter(mapping => healthFilter === "all" || (mapping.health || "healthy") === healthFilter);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleMappings.length / pageSize)));
  const selectedIds = selected.filter(id => visibleMappings.some(mapping => mapping.id === id));
  const pageMappings = visibleMappings.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  function changeSelection(ids: string[]) {
    setSelected(ids);
    setConfirmation(null);
  }
  function acceptMappings(next: CoverageMapping[]) {
    setMappings(next);
    const matchingCount = next.filter(mapping => healthFilter === "all" || (mapping.health || "healthy") === healthFilter).length;
    setPage(current => Math.min(current, Math.max(1, Math.ceil(matchingCount / pageSize))));
    setSelected(current => current.filter(id => next.some(mapping => mapping.id === id && (healthFilter === "all" || (mapping.health || "healthy") === healthFilter))));
    setConfirmation(null);
  }
  function openMapping(mapping: CoverageMapping) {
    setFormOpen(true);
    setEditing(mapping);
    setUrls(mapping.members.map(member => member.url));
    setPreview(null);
    setError("");
    setMessage("Editing mapping. Add or remove episodes, then resolve and review before saving.");
  }
  async function load() {
    const response = await fetch("/api/plex/manual-coverage", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error);
    if (typeof body.revision === "number" && body.revision < acceptedRevision.current) return;
    acceptedRevision.current = body.revision || acceptedRevision.current;
    acceptMappings(body.mappings);
    setRevision(body.revision);
    setPending(Boolean(body.pending));
  }
  useEffect(() => {
    let active = true;
    void fetch("/api/plex/manual-coverage", { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error);
      if (active) {
        if (typeof body.revision === "number" && body.revision < acceptedRevision.current) return;
        acceptedRevision.current = body.revision || acceptedRevision.current;
        setMappings(body.mappings);
        setSelected([]);
        setConfirmation(null);
        setPage(1);
        setRevision(body.revision);
        const existing = body.mappings.find((mapping: CoverageMapping) => initialMappingId ? mapping.id === initialMappingId : mapping.members.some(member => initialUrls.includes(member.url)));
        if (existing) openMapping(existing);
        setPending(Boolean(body.pending));
      }
    }).catch(error => {
      if (active)
        setError(error.message);
    });
    return () => {
      active = false;
    };
  }, [initialUrls, initialMappingId]);
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const response = await fetch("/api/plex/scan", { cache: "no-store" });
        const body = await response.json();
        if (active && response.ok) setScanning(body.scan?.status === "running");
      } catch { /* Mutation API still rejects an active scan if polling fails. */ }
    }
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function action(body: unknown) {
    if (locked) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/plex/manual-coverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) {
        if (result.code === "stale-revision" || result.code === "not-found") await load();
        if (result.mappingId && result.code === "membership-conflict") {
          const existing = mappings.find(mapping => mapping.id === result.mappingId);
          if (existing && !editing) openMapping(existing);
        }
        throw new Error(result.error);
      }
      if (typeof result.revision === "number") {
        if (result.revision < acceptedRevision.current) return;
        acceptedRevision.current = result.revision;
      }
      if (result.existingMapping) {
        openMapping(result.existingMapping);
        // A submitted episode may be another part of a saved combined episode.
        // Keep the submitted records first, then include the saved complete set.
        const members: CoverageMember[] = [...result.members];
        for (const member of result.existingMapping.members as CoverageMember[]) {
          if (!members.some(candidate => candidate.provider === member.provider && candidate.id === member.id)) members.push(member);
        }
        setUrls(members.map(member => member.url));
        setMessage("This episode already belongs to a mapping. Kept your resolved episodes and included its saved members. Check the complete sets, then resolve and review before saving.");
        return;
      }
      if (result.preview)
        setPreview(result);
      else {
        setPreview(null);
        setEditing(null);
        onChanged(result.revision);
        setMessage(result.pending ? "Saved. Some coverage checks need attention. See Coverage Issues for details. Fresh provider verification will run on the next Plex search." : "Saved. Affected cached Plex comparisons have been rechecked. Fresh provider verification will run on the next Plex search.");
        await load();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save mapping.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (locked) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/plex/manual-coverage?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error);
      if (typeof body.revision === "number" && body.revision < acceptedRevision.current) return;
      acceptedRevision.current = body.revision || acceptedRevision.current;
      if (editing?.id === id) {
        setEditing(null);
        setPreview(null);
      }
      onChanged(body.revision);
      setMessage(body.pending ? "Deleted. Some coverage checks need attention. See Coverage Issues for details." : "Deleted. Affected cached Plex comparisons have been rechecked. Fresh provider verification will run on the next Plex search.");
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete mapping.");
    } finally {
      setBusy(false);
    }
  }
  async function removeSelected(ids: string[]) {
    if (locked) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/plex/manual-coverage", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      if (editing && ids.includes(editing.id)) { setEditing(null); setPreview(null); }
      changeSelection([]);
      acceptedRevision.current = Math.max(acceptedRevision.current, body.revision);
      setRevision(body.revision);
      onChanged(body.revision);
      setMessage(`Deleted ${body.deleted.length} mappings.${body.missing.length ? ` ${body.missing.length} selected mappings were already removed.` : ""} Affected cached Plex comparisons have been rechecked. Fresh provider verification will run on the next Plex search.`);
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete selected mappings.");
    } finally { setBusy(false); }
  }
  function itemCorrection(mapping: CoverageMapping, item: CoverageEvidence) {
    const key=`${mapping.id}:${item.showKey}:${item.ratingKey}`;
    const correction=mapping.corrections?.find(c=>c.ratingKey===item.ratingKey && c.showKey===item.showKey);
    return <fieldset key={key}><legend>Plex item {item.ratingKey} · {item.showKey}</legend>
      <p>Provider identities: {item.identities.map(i=>`${i.provider} ${i.id}`).join(", ")}</p>
      <p>{correction ? `Declared content: ${correction.identities.map(i=>`${i.provider} ${i.id}`).join(", ")}` : "No ownership correction. Conflicting combined/split identities cannot add manual coverage."}</p>
      {(["TMDB","TVDB"] as const).map(provider=><div key={provider}>
        <button disabled={locked} onClick={()=>void action({action:"correct",mappingId:mapping.id,revision,item,identities:mapping.members.filter(m=>m.provider===provider).map(m=>({provider:m.provider,id:m.id}))})}>Declare complete {provider} set</button>
        {mapping.members.filter(m=>m.provider===provider).map(member=><label key={member.id}><input type="checkbox" disabled={locked} checked={(selectedParts[key]||[]).includes(`${provider}:${member.id}`)} onChange={event=>setSelectedParts(current=>({...current,[key]:event.target.checked ? [...(current[key]||[]).filter(v=>v.startsWith(provider+":")),`${provider}:${member.id}`] : (current[key]||[]).filter(v=>v!==`${provider}:${member.id}`)}))}/>{member.title} · {provider} {member.id} · S{member.season} E{member.episode}</label>)}
      </div>)}
      <button disabled={locked || !selectedParts[key]?.length} onClick={()=>void action({action:"correct",mappingId:mapping.id,revision,item,identities:mapping.members.filter(m=>selectedParts[key]?.includes(`${m.provider}:${m.id}`)).map(m=>({provider:m.provider,id:m.id}))})}>Declare selected parts</button>
    </fieldset>;
  }
  function records(members: CoverageMember[]) {
    return members.map(member => <div className="provider-record" key={`${member.provider}:${member.id}`}><strong>{member.provider} / {member.show}</strong><p>{member.title} / {report ? `S${String(member.season).padStart(2,"0")}E${String(member.episode).padStart(2,"0")}` : `S${member.season} E${member.episode}`} / Episode ID {member.id}</p>{report && <p>Show ID {member.showId}</p>}<a href={member.url} target="_blank" rel="noreferrer">{member.url}</a></div>);
  }
  return <section className={`manual-match-editor ${report ? "manual-match-report" : ""}`}>
 {scanning || scanActive ? <p role="status">A Plex scan is running. Wait for it to finish before changing Manual Matches or ownership corrections.</p> : null}
 {report && <button className="primary" disabled={locked} onClick={() => {setFormOpen(true);setEditing(null);setUrls(["", ""]);setPreview(null);setError("");setMessage("");}}>Add Manual Match</button>}
 {formOpen && <section className="manual-match-form" aria-label="Manual Match editor">
 {editing && <p>Editing mapping {editing.id} · Revision {editing.revision}</p>}
 <button disabled={locked} onClick={() => {
    setEditing(null);
    setUrls(["", ""]);
    setPreview(null);
    setError("");
    setMessage("");
  }}>Create mapping</button>
 <p>You can create a mapping before owning either set. Enter episode URLs, tvdb:200, or tmdb:100 show:10 season:1 episode:2. TMDB IDs require show, season and episode context; show IDs alone cannot identify episodes.</p>
 <p>Link complete TMDB and TVDB episode sets representing the same content. Each side needs at least one episode. Review every record before saving.</p>
 {urls.map((url, index) => <label key={index}>Episode URL or provider-qualified ID {index + 1}<input disabled={locked} aria-label={`Episode URL or provider-qualified ID ${index + 1}`} value={url} onChange={event => {
    setUrls(current => current.map((value, i) => i === index ? event.target.value : value));
    setPreview(null);
  }}/>{urls.length > 2 && <button disabled={locked} onClick={() => { setUrls(current => current.filter((_, i) => i !== index)); setPreview(null); }}>Remove episode {index + 1}</button>}</label>)}
 <button disabled={locked} onClick={() => { setUrls(current => [...current, ""]); setPreview(null); }}>Add episode</button>
 <button disabled={locked || urls.some(url => !url.trim())} onClick={() => void action({ action: "resolve", urls, id: editing?.id })}>Resolve and review</button>
 {preview && <section aria-label="Resolved episode preview">{records(preview.members)}<button disabled={locked} onClick={() => void action({ action: "save", preview: preview.preview, id: editing?.id, revision: editing?.revision })}>Save coverage mapping</button></section>}
 </section>}
 {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
 <label>Mapping health<select aria-label="Mapping health" value={healthFilter} disabled={locked} onChange={event => {
    setHealthFilter(event.target.value);
    setPage(1);
    changeSelection([]);
    setMessage("Selection cleared because the health filter changed.");
  }}><option value="all">All mappings</option><option value="healthy">Healthy</option><option value="needs-review">Needs review</option><option value="pending">Pending</option></select></label>
 <p role="status">{pending ? <>Some coverage checks need attention. <a href="/reports/coverage-issues">See Coverage Issues</a> for details.</> : ""}</p><h3>{report ? "Manual Matches" : "Saved mappings"} ({mappings.length})</h3>{!mappings.length && <div className="empty auto-match-empty"><h3>{report ? "No Manual Matches" : "No manual coverage mappings saved."}</h3><p>Create a Manual Match to link complete episode sets, even before either set is owned.</p></div>}
 <section aria-label="Mapping selection"><p role="status">{selectedIds.length} mappings selected. Selection spans pages; changing the health filter clears it.</p><button disabled={locked || !visibleMappings.length} onClick={() => changeSelection(visibleMappings.map(mapping => mapping.id))}>Select all {visibleMappings.length} matching mappings</button><button disabled={locked || !selectedIds.length} onClick={() => changeSelection([])}>Clear selection</button><button disabled={locked || !selectedIds.length} onClick={() => setConfirmation([...selectedIds])}>Delete selected mappings</button></section>
 {confirmation && <section role="alertdialog" aria-label="Confirm mapping deletion"><p>Delete {confirmation.length} selected mappings? Plex comparisons will be rechecked.</p><button disabled={locked} onClick={() => void removeSelected(confirmation)}>Confirm delete {confirmation.length} mappings</button><button disabled={locked} onClick={() => setConfirmation(null)}>Cancel bulk deletion</button></section>}
 <ReportPagination total={visibleMappings.length} page={currentPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }}/>
 {pageMappings.map(mapping => <article className="provider-match-row" key={mapping.id}><label><input type="checkbox" aria-label={`Select mapping ${mapping.id}`} disabled={locked} checked={selectedIds.includes(mapping.id)} onChange={event => changeSelection(event.target.checked ? [...selectedIds, mapping.id] : selectedIds.filter(id => id !== mapping.id))}/>Select mapping</label><p><strong>{mapping.health === "needs-review" ? "Needs review" : mapping.health === "pending" ? "Pending" : "Healthy"}</strong>{mapping.healthMessage && <> · {mapping.healthMessage}</>}</p>{report ? <div className="provider-match-columns">{(["TMDB", "TVDB"] as const).map(provider => <section className="show-provider-matches" key={provider}><header><span className={`provider-badge ${provider.toLowerCase()}`}>{provider}</span><strong>{mapping.members.filter(member => member.provider === provider).length} episodes</strong></header>{records(mapping.members.filter(member => member.provider === provider))}</section>)}</div> : records(mapping.members)}<button disabled={locked} onClick={() => openMapping(mapping)}>Edit mapping</button><details><summary>Coverage evidence</summary><p>Mapping {mapping.id} · Revision {mapping.revision}</p>{mapping.evidence?.length ? mapping.evidence.map(item => itemCorrection(mapping,item)) : <p>No directly owned source items in the latest inventory.</p>}</details><button disabled={locked} onClick={() => void remove(mapping.id)}>Delete mapping</button></article>)}
 </section>;
}

