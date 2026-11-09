"use client";
import { useEffect, useRef, useState } from "react";
import type { CoverageEvidence, CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
type Props = {
  initialUrls: string[];
  onClose: () => void;
  onChanged: (revision: number) => void;
};
export function ManualCoverageManager({ initialUrls, onClose, onChanged }: Props) {
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
  function openMapping(mapping: CoverageMapping) {
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
    setMappings(body.mappings);
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
        setRevision(body.revision);
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
      if (typeof result.revision === "number") {
        if (result.revision < acceptedRevision.current) return;
        acceptedRevision.current = result.revision;
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
      if (typeof body.revision === "number" && body.revision < acceptedRevision.current) return;
      acceptedRevision.current = body.revision || acceptedRevision.current;
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
  function itemCorrection(mapping: CoverageMapping, item: CoverageEvidence) {
    const key=`${mapping.id}:${item.showKey}:${item.ratingKey}`;
    const correction=mapping.corrections?.find(c=>c.ratingKey===item.ratingKey && c.showKey===item.showKey);
    return <fieldset key={key}><legend>Plex item {item.ratingKey} · {item.showKey}</legend>
      <p>Provider identities: {item.identities.map(i=>`${i.provider} ${i.id}`).join(", ")}</p>
      <p>{correction ? `Declared content: ${correction.identities.map(i=>`${i.provider} ${i.id}`).join(", ")}` : "No ownership correction. Conflicting combined/split identities cannot add manual coverage."}</p>
      {(["TMDB","TVDB"] as const).map(provider=><div key={provider}>
        <button disabled={busy} onClick={()=>void action({action:"correct",mappingId:mapping.id,revision,item,identities:mapping.members.filter(m=>m.provider===provider).map(m=>({provider:m.provider,id:m.id}))})}>Declare complete {provider} set</button>
        {mapping.members.filter(m=>m.provider===provider).map(member=><label key={member.id}><input type="checkbox" checked={(selectedParts[key]||[]).includes(`${provider}:${member.id}`)} onChange={event=>setSelectedParts(current=>({...current,[key]:event.target.checked ? [...(current[key]||[]).filter(v=>v.startsWith(provider+":")),`${provider}:${member.id}`] : (current[key]||[]).filter(v=>v!==`${provider}:${member.id}`)}))}/>{member.title} · {provider} {member.id} · S{member.season} E{member.episode}</label>)}
      </div>)}
      <button disabled={busy || !selectedParts[key]?.length} onClick={()=>void action({action:"correct",mappingId:mapping.id,revision,item,identities:mapping.members.filter(m=>selectedParts[key]?.includes(`${m.provider}:${m.id}`)).map(m=>({provider:m.provider,id:m.id}))})}>Declare selected parts</button>
    </fieldset>;
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
 <p>You can create a mapping before owning either set. Enter episode URLs, tvdb:200, or tmdb:100 show:10 season:1 episode:2. TMDB IDs require show, season and episode context; show IDs alone cannot identify episodes.</p>
 <p>Link complete TMDB and TVDB episode sets representing the same content. Each side needs at least one episode. Review every record before saving.</p>
 {urls.map((url, index) => <label key={index}>Episode URL or provider-qualified ID {index + 1}<input aria-label={`Episode URL or provider-qualified ID ${index + 1}`} value={url} onChange={event => {
    setUrls(current => current.map((value, i) => i === index ? event.target.value : value));
    setPreview(null);
  }}/>{urls.length > 2 && <button disabled={busy} onClick={() => { setUrls(current => current.filter((_, i) => i !== index)); setPreview(null); }}>Remove episode {index + 1}</button>}</label>)}
 <button disabled={busy} onClick={() => { setUrls(current => [...current, ""]); setPreview(null); }}>Add episode</button>
 <button disabled={busy || urls.some(url => !url.trim())} onClick={() => void action({ action: "resolve", urls, id: editing?.id })}>Resolve and review</button>
 {preview && <section aria-label="Resolved episode preview">{records(preview.members)}<button disabled={busy} onClick={() => void action({ action: "save", preview: preview.preview, id: editing?.id, revision: editing?.revision })}>Save coverage mapping</button></section>}
 {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
 <p role="status">{pending ? "Coverage comparisons are pending. Check Plex scan status or start a new Plex search if a provider is unavailable." : ""}</p><h3>Saved mappings ({mappings.length})</h3>{!mappings.length && <p>No manual coverage mappings saved.</p>}
 {mappings.map(mapping => <article key={mapping.id}>{records(mapping.members)}<button disabled={busy} onClick={() => openMapping(mapping)}>Edit mapping</button><details><summary>Coverage evidence</summary><p>Mapping {mapping.id} · Revision {mapping.revision}</p>{mapping.evidence?.length ? mapping.evidence.map(item => itemCorrection(mapping,item)) : <p>No directly owned source items in the latest inventory.</p>}</details><button disabled={busy} onClick={() => void remove(mapping.id)}>Delete mapping</button></article>)}
 </section></div>;
}

