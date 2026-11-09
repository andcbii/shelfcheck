"use client";
import { useEffect, useState } from "react";
import { ReportPagination } from "@/app/reports/report-pagination";
import type { CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
type Props = {
  initialUrls: string[];
  onClose: () => void;
  onChanged: (revision: number) => void;
};
export function ManualCoverageManager({ initialUrls, onClose, onChanged }: Props) {
  const [urls, setUrls] = useState([initialUrls[0] || "", initialUrls[1] || ""]);
  const [editing, setEditing] = useState<CoverageMapping | null>(null);
  const [mappings, setMappings] = useState<CoverageMapping[]>([]);
  const [preview, setPreview] = useState<{
    preview: string;
    members: CoverageMember[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [healthFilter, setHealthFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<string[] | null>(null);
  const visibleMappings = mappings.filter(mapping => healthFilter === "all" || mapping.health === healthFilter);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleMappings.length / pageSize)));
  const selectedIds = selected.filter(id => visibleMappings.some(mapping => mapping.id === id));
  const pageMappings = visibleMappings.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  function changeSelection(ids: string[]) {
    setSelected(ids);
    setConfirmation(null);
  }
  function acceptMappings(next: CoverageMapping[]) {
    setMappings(next);
    setSelected(current => current.filter(id => next.some(mapping => mapping.id === id && (healthFilter === "all" || mapping.health === healthFilter))));
    setConfirmation(null);
  }
  function openMapping(mapping: CoverageMapping) {
    setEditing(mapping);
    setUrls(mapping.members.map(member => member.url));
    setPreview(null);
    setError("");
    setMessage("Editing mapping. Replace either episode, then resolve and review before saving.");
  }
  async function load() {
    const response = await fetch("/api/plex/manual-coverage", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error);
    acceptMappings(body.mappings);
    setPending(Boolean(body.pending));
  }
  useEffect(() => {
    let active = true;
    void fetch("/api/plex/manual-coverage", { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error);
      if (active) {
        setMappings(body.mappings);
        const existing = body.mappings.find((mapping: CoverageMapping) => mapping.members.some(member => initialUrls.includes(member.url)));
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
  }, [initialUrls]);
  async function action(body: unknown) {
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
      if (result.existingMapping) {
        openMapping(result.existingMapping);
        return;
      }
      if (result.preview)
        setPreview(result);
      else {
        setPreview(null);
        setEditing(null);
        onChanged(result.revision);
        setMessage("Saved. Plex comparisons are pending recheck.");
        await load();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save mapping.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/plex/manual-coverage?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error);
      if (editing?.id === id) {
        setEditing(null);
        setPreview(null);
      }
      onChanged(body.revision);
      setMessage("Deleted. Plex comparisons are pending recheck.");
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete mapping.");
    } finally {
      setBusy(false);
    }
  }
  async function removeSelected(ids: string[]) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/plex/manual-coverage", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      if (editing && ids.includes(editing.id)) { setEditing(null); setPreview(null); }
      changeSelection([]);
      onChanged(body.revision);
      setMessage(`Deleted ${body.deleted.length} mappings.${body.missing.length ? ` ${body.missing.length} selected mappings were already removed.` : ""} Plex comparisons are pending recheck.`);
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete selected mappings.");
    } finally { setBusy(false); }
  }
  function records(members: CoverageMember[]) {
    return members.map(member => <p key={`${member.provider}:${member.id}`}><strong>{member.provider} · {member.show}</strong><br />{member.title} · S{member.season} E{member.episode} · Episode ID {member.id}<br /><a href={member.url} target="_blank" rel="noreferrer">{member.url}</a></p>);
  }
  return <div className="modal-backdrop"><section className="modal manual-coverage-manager" role="dialog" aria-modal="true" aria-label="Manual Coverage"><header><h2>Manual Coverage</h2><button onClick={onClose} aria-label="Close manual coverage">Close</button></header>
 {editing && <p>Editing mapping {editing.id} � Revision {editing.revision}</p>}
 <button disabled={busy} onClick={() => {
    setEditing(null);
    setUrls(["", ""]);
    setPreview(null);
    setError("");
    setMessage("");
  }}>Create mapping</button>
 <p>You can create a mapping before owning either episode. Enter episode URLs, tvdb:200, or tmdb:100 show:10 season:1 episode:2. TMDB IDs require show, season and episode context; show IDs alone cannot identify episodes.</p>
 <p>Link one TMDB episode to one TVDB episode representing the same content. Review both records before saving.</p>
 {urls.map((url, index) => <label key={index}>Episode URL or provider-qualified ID {index + 1}<input aria-label={`Episode URL or provider-qualified ID ${index + 1}`} value={url} onChange={event => {
    setUrls(current => current.map((value, i) => i === index ? event.target.value : value));
    setPreview(null);
  }}/></label>)}
 <button disabled={busy || urls.some(url => !url.trim())} onClick={() => void action({ action: "resolve", urls, id: editing?.id })}>Resolve and review</button>
 {preview && <section aria-label="Resolved episode preview">{records(preview.members)}<button disabled={busy} onClick={() => void action({ action: "save", preview: preview.preview, id: editing?.id, revision: editing?.revision })}>Save coverage mapping</button></section>}
 {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
 <label>Mapping health<select aria-label="Mapping health" value={healthFilter} disabled={busy} onChange={event => {
    setHealthFilter(event.target.value);
    setPage(1);
    changeSelection([]);
    setMessage("Selection cleared because the health filter changed.");
  }}><option value="all">All mappings</option><option value="needs-review">Needs review</option><option value="pending">Pending</option></select></label>
 <p role="status">{pending ? "Coverage comparisons are pending. Check Plex scan status or start a new Plex search if a provider is unavailable." : ""}</p><h3>Saved mappings ({mappings.length})</h3>{!mappings.length && <p>No manual coverage mappings saved.</p>}
 <section aria-label="Mapping selection"><p role="status">{selectedIds.length} mappings selected. Selection spans pages; changing the health filter clears it.</p><button disabled={busy || !visibleMappings.length} onClick={() => changeSelection(visibleMappings.map(mapping => mapping.id))}>Select all {visibleMappings.length} matching mappings</button><button disabled={busy || !selectedIds.length} onClick={() => changeSelection([])}>Clear selection</button><button disabled={busy || !selectedIds.length} onClick={() => setConfirmation([...selectedIds])}>Delete selected mappings</button></section>
 {confirmation && <section role="alertdialog" aria-label="Confirm mapping deletion"><p>Delete {confirmation.length} selected mappings? Plex comparisons will be rechecked.</p><button disabled={busy} onClick={() => void removeSelected(confirmation)}>Confirm delete {confirmation.length} mappings</button><button disabled={busy} onClick={() => setConfirmation(null)}>Cancel bulk deletion</button></section>}
 <ReportPagination total={visibleMappings.length} page={currentPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }}/>
 {pageMappings.map(mapping => <article key={mapping.id}><label><input type="checkbox" aria-label={`Select mapping ${mapping.id}`} disabled={busy} checked={selectedIds.includes(mapping.id)} onChange={event => changeSelection(event.target.checked ? [...selectedIds, mapping.id] : selectedIds.filter(id => id !== mapping.id))}/>Select mapping</label><p><strong>{mapping.health === "needs-review" ? "Needs review" : mapping.health === "pending" ? "Pending" : "Healthy"}</strong>{mapping.healthMessage && <> · {mapping.healthMessage}</>}</p>{records(mapping.members)}<button disabled={busy} onClick={() => openMapping(mapping)}>Edit mapping</button><details><summary>Coverage evidence</summary><p>Mapping {mapping.id} · Revision {mapping.revision}</p>{mapping.evidence?.length ? mapping.evidence.map(item => <p key={`${item.showKey}:${item.ratingKey}`}>Plex item {item.ratingKey} · {item.showKey}<br />{item.identities.map(identity => `${identity.provider} ${identity.id}`).join(", ")}</p>) : <p>No directly owned source items in the latest inventory.</p>}</details><button disabled={busy} onClick={() => void remove(mapping.id)}>Delete mapping</button></article>)}
 </section></div>;
}

