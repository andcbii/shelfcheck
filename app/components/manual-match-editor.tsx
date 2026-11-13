"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ReportPagination } from "@/app/reports/report-pagination";
import { INCOMPLETE_LABEL, missingPartsExplanation, missingPartsOf, reportMissingSelectionProblem, type CoverageEvidence, type CoverageMapping, type CoverageMember } from "@/lib/manual-coverage-model";
type Props = {
  initialUrls: string[];
  initialMappingId?: string;
  report?: boolean;
  episodeScope?: boolean;
  scanActive?: boolean;
  onChanged: (revision: number) => void;
};
// URL paths identify provider episodes independently of slugs, locale, and query strings.
function identifiesMember(input: string, member: CoverageMember) {
  const qualified = input.trim().match(/^(tmdb|tvdb):(\d+)(?:\s+show:\d+\s+season:\d+\s+episode:\d+)?$/i);
  if (qualified) return qualified[1].toUpperCase() === member.provider && Number(qualified[2]) === member.id;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "thetvdb.com" && member.provider === "TVDB") {
      const episode = url.pathname.match(/^\/(?:series\/[^/]+\/episodes|dereferrer\/episode)\/(\d+)\/?$/);
      return Boolean(episode && Number(episode[1]) === member.id);
    }
    if (host === "themoviedb.org" && member.provider === "TMDB") {
      const episode = url.pathname.match(/^\/tv\/(\d+)(?:-[^/]*)?\/season\/(\d+)\/episode\/(\d+)\/?$/);
      return Boolean(episode && Number(episode[1]) === member.showId && Number(episode[2]) === member.season && Number(episode[3]) === member.episode);
    }
  } catch { /* Unresolved or incomplete draft input has no saved membership. */ }
  return false;
}
const memberKey = (member: { provider: string; id: number }) => `${member.provider}:${member.id}`;
const flaggedKeys = (members: CoverageMember[]) => members.filter(member => member.reportMissing).map(memberKey).sort();
const episodeCode = (member: CoverageMember) => `S${String(member.season).padStart(2, "0")}E${String(member.episode).padStart(2, "0")}`;
const episodeName = (member: CoverageMember) => `${member.provider} ${member.title}`;
export function ManualMatchEditor({ initialUrls, initialMappingId, onChanged, report = false, episodeScope = false, scanActive = false }: Props) {
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
  const [pending, setPending] = useState(false);
  const [healthFilter, setHealthFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<string[] | null>(null);
  // Report Missing selections are a draft until the Manual Match is saved.
  const [draftFlags, setDraftFlags] = useState<string[]>([]);
  const uid = useId();
  const locked = busy || scanActive || scanning;
  const defaultUrls = initialUrls.length > 1 ? initialUrls : [initialUrls[0] || "", ""];
  const savedUrls = Boolean(editing && urls.length === editing.members.length && urls.every((url, index) => url === editing.members[index].url));
  // Saved members are editable in place; changed membership needs a reviewed preview first.
  const draftMembers = preview?.members || (editing && savedUrls ? editing.members : null);
  // The draft as it would be saved: explicit flags only. Derived status is recalculated from them.
  const draftState = draftMembers?.map(member => ({ ...member, reportMissing: draftFlags.includes(memberKey(member)) })) || [];
  // The server applies the same rule to every manual save; the draft is checked before sending it.
  const selectionProblem = reportMissingSelectionProblem(draftState);
  const draftFlagged = draftState.filter(member => member.reportMissing);
  const draftIncomplete = draftState.filter(member => !member.reportMissing && missingPartsOf(draftState, member).length);
  const flagsChanged = draftFlags.join() !== (editing ? flaggedKeys(editing.members) : []).join();
  const dirty = flagsChanged || Boolean(preview) || (editing ? !savedUrls : urls.join() !== defaultUrls.join());
  const scopedMappings = episodeScope ? mappings.filter(mapping => mapping.id === editing?.id) : mappings;
  const visibleMappings = scopedMappings.filter(mapping => healthFilter === "all" || (mapping.health || "healthy") === healthFilter);
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
    setDraftFlags(flaggedKeys(mapping.members));
    setError("");
    setMessage("Editing mapping. Add or remove episodes, then resolve and review before saving.");
  }
  function createMapping() {
    setFormOpen(true);
    setEditing(null);
    setUrls(["", ""]);
    setPreview(null);
    setDraftFlags([]);
    setError("");
    setMessage("");
  }
  function cancelDraft() {
    if (editing) return openMapping(editing);
    setUrls(defaultUrls);
    setPreview(null);
    setDraftFlags([]);
    setError("");
    setMessage("");
  }
  function toggleFlag(member: CoverageMember, checked: boolean) {
    const key = memberKey(member);
    setDraftFlags(current => (checked ? [...current.filter(item => item !== key), key] : current.filter(item => item !== key)).sort());
  }
  function saveDraft() {
    if (!draftMembers || selectionProblem) return;
    const reportMissing = draftFlagged.map(({ provider, id }) => ({ provider, id }));
    void action(preview
      ? { action: "save", preview: preview.preview, id: editing?.id, revision: editing?.revision, reportMissing }
      : { action: "save", id: editing?.id, revision: editing?.revision, reportMissing });
  }
  async function load() {
    const response = await fetch("/api/plex/manual-coverage", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error);
    if (typeof body.revision === "number" && body.revision < acceptedRevision.current) return;
    acceptedRevision.current = body.revision || acceptedRevision.current;
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
        if (typeof body.revision === "number" && body.revision < acceptedRevision.current) return;
        acceptedRevision.current = body.revision || acceptedRevision.current;
        setMappings(body.mappings);
        setSelected([]);
        setConfirmation(null);
        setPage(1);
        const existing = body.mappings.find((mapping: CoverageMapping) => initialMappingId ? mapping.id === initialMappingId : mapping.members.some(member => initialUrls.some(input => identifiesMember(input, member))));
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
        if (result.mapping) openMapping(result.mapping);
        else if (!episodeScope) setEditing(null);
        onChanged(result.revision);
        setMessage(result.pending ? "Saved. Some coverage checks need attention. See Scan Issues for details. Fresh provider verification will run on the next Plex search." : "Saved. Affected cached Plex comparisons have been rechecked. Fresh provider verification will run on the next Plex search.");
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
      setMessage(body.pending ? "Deleted. Some coverage checks need attention. See Scan Issues for details." : "Deleted. Affected cached Plex comparisons have been rechecked. Fresh provider verification will run on the next Plex search.");
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
      onChanged(body.revision);
      setMessage(`Deleted ${body.deleted.length} mappings.${body.missing.length ? ` ${body.missing.length} selected mappings were already removed.` : ""} Affected cached Plex comparisons have been rechecked. Fresh provider verification will run on the next Plex search.`);
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete selected mappings.");
    } finally { setBusy(false); }
  }
  function itemEvidence(mapping: CoverageMapping, item: CoverageEvidence) {
    return <p key={`${mapping.id}:${item.showKey}:${item.ratingKey}`}>Plex item {item.ratingKey} · {item.showKey} · Provider identities: {item.identities.map(i=>`${i.provider} ${i.id}`).join(", ")}</p>;
  }
  // A combined episode is incomplete while any of its split episodes is reported missing.
  // The status is derived from the given flags (saved, or the draft), never selected itself.
  function derivedStatus(members: CoverageMember[], member: CoverageMember) {
    const current = members.find(item => memberKey(item) === memberKey(member));
    if (!current || current.reportMissing) return null;
    const parts = missingPartsOf(members, current);
    return parts.length ? <p className="report-missing-status report-missing-derived"><span>{INCOMPLETE_LABEL}</span> <small>{missingPartsExplanation(members, parts)}</small></p> : null;
  }
  // One presentation for saved rows, the Matching Episodes dialog and the editor:
  // a panel per provider, preserving each provider's identities, numbering and links.
  function panels(members: CoverageMember[], scope: string, editable = false) {
    return <div className="manual-match-panels">{(["TMDB", "TVDB"] as const).map(provider => {
      const side = members.filter(member => member.provider === provider);
      return <section className="show-provider-matches" key={provider}><header><span className={`provider-badge ${provider.toLowerCase()}`}>{provider}</span><strong>{side.length} {side.length === 1 ? "episode" : "episodes"}</strong></header>
        {side.map(member => {
          const contextId = `${uid}-${scope}-${memberKey(member)}`;
          return <div className="provider-record manual-match-record" key={memberKey(member)}>
            <div id={contextId}><strong>{member.provider} / {member.show}</strong><p>{member.title} / {episodeCode(member)} / Episode ID {member.id}</p><p>Show ID {member.showId}</p></div>
            <a href={member.url} target="_blank" rel="noreferrer">{member.url}</a>
            {!editable && member.reportMissing && <p className="report-missing-status">Reported missing</p>}
            {!member.reportMissing && derivedStatus(editable ? draftState : members, member)}
            {editable && <label className="report-missing-toggle"><input type="checkbox" aria-describedby={contextId} disabled={locked} checked={draftFlags.includes(memberKey(member))} onChange={event => toggleFlag(member, event.target.checked)}/>Report Missing</label>}
          </div>;
        })}
      </section>;
    })}</div>;
  }
  function draftEditor(members: CoverageMember[]) {
    return <section aria-label={preview ? "Resolved episode preview" : "Manual Match episodes"}>
      <p className="report-missing-explanation"><strong>Report Missing</strong> keeps an episode missing in your Plex results when your local copy lacks its content, even if matching would mark it collected. Reporting a split episode missing also keeps its combined episode missing. When both sides list several episodes, report at least one episode missing on each side, or none. It is a local Shelfcheck override: Shelfcheck sends no report to Plex, TMDB, or TVDB.</p>
      {panels(members, "draft", true)}
      {selectionProblem
        ? <p className="report-missing-validation" id={`${uid}-report-missing-validation`} aria-live="polite">{selectionProblem}</p>
        : <p className="report-missing-impact" aria-live="polite"><strong>After saving</strong> {draftFlagged.length
        ? <>{draftFlagged.map(episodeName).join(", ")} {draftFlagged.length === 1 ? "stays" : "stay"} missing as Reported missing in Plex results.
          {draftIncomplete.map(member => ` ${episodeName(member)} stays missing as ${INCOMPLETE_LABEL} because it contains ${missingPartsOf(draftState, member).map(part => episodeName(draftState.find(item => memberKey(item) === memberKey(part))!)).join(" and ")}.`).join("")}
          {members.length - draftFlagged.length - draftIncomplete.length === 1 ? " The other episode follows normal matching." : members.length > draftFlagged.length + draftIncomplete.length ? " The other episodes follow normal matching." : ""}</>
        : "every episode follows normal matching."}</p>}
      <p className="manual-match-draft-state">{dirty ? "Unsaved changes" : "No unsaved changes"}</p>
      <button disabled={locked || !dirty} onClick={cancelDraft}>Cancel</button>
      <button disabled={locked || (!preview && !flagsChanged) || Boolean(selectionProblem)} aria-describedby={selectionProblem ? `${uid}-report-missing-validation` : undefined} onClick={saveDraft}>Save coverage mapping</button>
    </section>;
  }
  return <section className={`manual-match-editor ${report ? "manual-match-report" : ""}`}>
 {scanning || scanActive ? <p role="status">A Plex scan is running. Wait for it to finish before changing Manual Matches.</p> : null}
 {report && <button className="primary" disabled={locked} onClick={createMapping}>Add Manual Match</button>}
 {formOpen && <section className="manual-match-form" aria-label="Manual Match editor">
 {editing && <p>Editing mapping {editing.id} · Revision {editing.revision}</p>}
 {!episodeScope && <button disabled={locked} onClick={createMapping}>Create mapping</button>}
 <p>You can create a mapping before owning either set. Enter episode URLs, tvdb:200, or tmdb:100 show:10 season:1 episode:2. TMDB IDs require show, season and episode context; show IDs alone cannot identify episodes.</p>
 <p>Link complete TMDB and TVDB episode sets representing the same content. Each side needs at least one episode. Review every record before saving.</p>
 {urls.map((url, index) => <label key={index}>Episode URL or provider-qualified ID {index + 1}<input disabled={locked} aria-label={`Episode URL or provider-qualified ID ${index + 1}`} value={url} onChange={event => {
    setUrls(current => current.map((value, i) => i === index ? event.target.value : value));
    setPreview(null);
  }}/>{urls.length > 2 && <button disabled={locked} onClick={() => { setUrls(current => current.filter((_, i) => i !== index)); setPreview(null); }}>Remove episode {index + 1}</button>}</label>)}
 <button disabled={locked} onClick={() => { setUrls(current => [...current, ""]); setPreview(null); }}>Add episode</button>
 <button disabled={locked || urls.some(url => !url.trim())} onClick={() => void action({ action: "resolve", urls, id: editing?.id })}>Resolve and review</button>
 {draftMembers && draftEditor(draftMembers)}
 </section>}
 {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
 {!episodeScope && <><label>Mapping health<select aria-label="Mapping health" value={healthFilter} disabled={locked} onChange={event => {
    setHealthFilter(event.target.value);
    setPage(1);
    changeSelection([]);
    setMessage("Selection cleared because the health filter changed.");
  }}><option value="all">All mappings</option><option value="healthy">Healthy</option><option value="needs-review">Needs review</option><option value="pending">Pending</option></select></label>
 <p role="status">{pending ? <>Some coverage checks need attention. <a href="/reports/coverage-issues">See Scan Issues</a> for details.</> : ""}</p><h3>{report ? "Manual Matches" : "Saved mappings"} ({mappings.length})</h3>{!mappings.length && <div className="empty auto-match-empty"><h3>{report ? "No Manual Matches" : "No manual coverage mappings saved."}</h3><p>Create a Manual Match to link complete episode sets, even before either set is owned.</p></div>}
 <section aria-label="Mapping selection"><p role="status">{selectedIds.length} mappings selected. Selection spans pages; changing the health filter clears it.</p><button disabled={locked || !visibleMappings.length} onClick={() => changeSelection(visibleMappings.map(mapping => mapping.id))}>Select all {visibleMappings.length} matching mappings</button><button disabled={locked || !selectedIds.length} onClick={() => changeSelection([])}>Clear selection</button><button disabled={locked || !selectedIds.length} onClick={() => setConfirmation([...selectedIds])}>Delete selected mappings</button></section>
 {confirmation && <section role="alertdialog" aria-label="Confirm mapping deletion"><p>Delete {confirmation.length} selected mappings? Plex comparisons will be rechecked.</p><button disabled={locked} onClick={() => void removeSelected(confirmation)}>Confirm delete {confirmation.length} mappings</button><button disabled={locked} onClick={() => setConfirmation(null)}>Cancel bulk deletion</button></section>}
 <ReportPagination total={visibleMappings.length} page={currentPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }}/>
 </>}
 {pageMappings.map(mapping => <article className="provider-match-row" key={mapping.id}>{!episodeScope && <label><input type="checkbox" aria-label={`Select mapping ${mapping.id}`} disabled={locked} checked={selectedIds.includes(mapping.id)} onChange={event => changeSelection(event.target.checked ? [...selectedIds, mapping.id] : selectedIds.filter(id => id !== mapping.id))}/>Select mapping</label>}<p><strong>{mapping.health === "needs-review" ? "Needs review" : mapping.health === "pending" ? "Pending" : "Healthy"}</strong>{mapping.healthMessage && <> · {mapping.healthMessage}</>}</p>{panels(mapping.members, mapping.id)}<button disabled={locked} onClick={() => openMapping(mapping)}>Edit mapping</button><details><summary>Coverage evidence</summary><p>Mapping {mapping.id} · Revision {mapping.revision}</p>{mapping.evidence?.length ? mapping.evidence.map(item => itemEvidence(mapping,item)) : <p>No directly owned source items in the latest inventory.</p>}</details><button disabled={locked} onClick={() => void remove(mapping.id)}>Delete mapping</button></article>)}
 </section>;
}
