"use client";
import { useEffect, useRef, useState } from "react";
import { ManualMatchForm } from "@/app/components/manual-match-form";
import { matchesHealthFilter, type HealthFilter } from "@/app/components/manual-match-card";
import { ManualMatchList, plural } from "@/app/components/manual-match-list";
import { Popup } from "@/app/components/popup";
import { memberKey, reportMissingSelectionProblem, type CoverageMapping, type CoverageMember } from "@/lib/manual-coverage-model";
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
// How long a saved card says "Saved".
const SAVED_NOTE_MS = 4000;
const flaggedKeys = (members: CoverageMember[]) => members.filter(member => member.reportMissing).map(memberKey).sort();
// Names a saved Manual Match by its show and episode, preferring the TMDB side.
function matchName(editing: CoverageMapping | null) {
  const member = editing?.members.find(item => item.provider === "TMDB") || editing?.members[0];
  return member ? `${member.show} · ${member.title}` : null;
}
function editorTitle(editing: CoverageMapping | null) {
  const name = matchName(editing);
  return name ? `Edit Manual Match · ${name}` : "Add Manual Match";
}
// Holds a Manual Match draft and the saved Manual Matches, and composes the editor form and the list.
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
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<string[] | null>(null);
  // Report Missing selections are a draft until the Manual Match is saved.
  const [draftFlags, setDraftFlags] = useState<string[]>([]);
  // The Manual Match the popup just saved, whose card briefly says so.
  // Each save is a new note, so saving the same Manual Match again restarts its time.
  const [savedNote, setSavedNote] = useState<{ id: string } | null>(null);
  // Asking "Discard your changes?" before the editor popup closes on unsaved changes.
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
  const scanRunning = scanActive || scanning;
  const locked = busy || scanRunning;
  // A scan only pauses saving in the editor popup, so its draft stays editable; elsewhere it locks the form.
  const draftLocked = report ? busy : locked;
  const defaultUrls = initialUrls.length > 1 ? initialUrls : [initialUrls[0] || "", ""];
  const savedUrls = Boolean(editing && urls.length === editing.members.length && urls.every((url, index) => url === editing.members[index].url));
  // Saved members are editable in place; changed membership needs a reviewed preview first.
  const draftMembers = preview?.members || (editing && savedUrls ? editing.members : null);
  // The draft as it would be saved: explicit flags only. Derived status is recalculated from them.
  const draftState = draftMembers?.map(member => ({ ...member, reportMissing: draftFlags.includes(memberKey(member)) })) || [];
  // The server applies the same rule to every manual save; the draft is checked before sending it.
  const selectionProblem = reportMissingSelectionProblem(draftState);
  const draftFlagged = draftState.filter(member => member.reportMissing);
  const flagsChanged = draftFlags.join() !== (editing ? flaggedKeys(editing.members) : []).join();
  const dirty = flagsChanged || Boolean(preview) || (editing ? !savedUrls : urls.join() !== defaultUrls.join());
  const scopedMappings = episodeScope ? mappings.filter(mapping => mapping.id === editing?.id) : mappings;
  function changeSelection(ids: string[]) {
    setSelected(ids);
    setConfirmation(null);
  }
  function acceptMappings(next: CoverageMapping[]) {
    setMappings(next);
    const matchingCount = next.filter(mapping => matchesHealthFilter(mapping, healthFilter)).length;
    setPage(current => Math.min(current, Math.max(1, Math.ceil(matchingCount / pageSize))));
    setSelected(current => current.filter(id => next.some(mapping => mapping.id === id && matchesHealthFilter(mapping, healthFilter))));
    setConfirmation(null);
  }
  // Loads a saved Manual Match into the draft. Opening the form is separate, so a
  // save or refresh that finishes after the popup closed does not reopen it.
  function openMapping(mapping: CoverageMapping) {
    setEditing(mapping);
    setUrls(mapping.members.map(member => member.url));
    setPreview(null);
    setDraftFlags(flaggedKeys(mapping.members));
    setError("");
    setMessage("Editing this Manual Match. Add or remove episodes, then resolve and review before saving.");
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
  function editMapping(mapping: CoverageMapping) {
    openMapping(mapping);
    setFormOpen(true);
  }
  // The single close hook for the editor popup: Close, Esc, a click outside and Cancel all
  // ask to close here, and unsaved changes are only thrown away once the user agrees. While a
  // save is in flight they wait for it, so a save cannot land after its changes were discarded.
  function requestFormClose() {
    if (busy) return;
    if (dirty) setDiscardPromptOpen(true);
    else closeForm();
  }
  // Closes the editor popup and any question over it; opening it again loads a fresh draft.
  function closeForm() {
    setDiscardPromptOpen(false);
    setFormOpen(false);
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
    if (!draftMembers || selectionProblem || scanRunning) return;
    const reportMissing = draftFlagged.map(({ provider, id }) => ({ provider, id }));
    void action(preview
      ? { action: "save", preview: preview.preview, id: editing?.id, revision: editing?.revision, reportMissing }
      : { action: "save", id: editing?.id, revision: editing?.revision, reportMissing });
  }
  async function load(): Promise<CoverageMapping[] | undefined> {
    const response = await fetch("/api/plex/manual-coverage", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error);
    if (typeof body.revision === "number" && body.revision < acceptedRevision.current) return;
    acceptedRevision.current = body.revision || acceptedRevision.current;
    acceptMappings(body.mappings);
    setPending(Boolean(body.pending));
    return body.mappings;
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
        if (existing) { openMapping(existing); setFormOpen(true); }
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
    if (!savedNote) return;
    const timer = setTimeout(() => setSavedNote(null), SAVED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [savedNote]);
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
  async function action(body: { action: "resolve" | "save" } & Record<string, unknown>) {
    // Resolving only reviews episodes, which the server allows during a scan.
    if (busy || (scanRunning && !(report && body.action === "resolve"))) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/plex/manual-coverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) {
        if (result.code === "stale-revision" || result.code === "not-found") {
          const latest = await load();
          // Reopen the latest saved state (for example, flags deleted by Ignore)
          // so the stale draft cannot be resubmitted and silently restore them.
          const refreshed = result.code === "stale-revision" && latest?.find(mapping => mapping.id === editing?.id);
          if (refreshed) {
            // Keep the typed episode list so a membership edit can be resolved again,
            // but drop the old review and flags, which belong to the stale revision.
            const typed = urls;
            openMapping(refreshed);
            setUrls(typed);
          }
        }
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
        setMessage("This episode already belongs to a Manual Match. Kept your resolved episodes and included its saved members. Check the complete sets, then resolve and review before saving.");
        return;
      }
      if (result.preview)
        setPreview(result);
      else {
        setPreview(null);
        if (result.mapping) openMapping(result.mapping);
        else if (!episodeScope) setEditing(null);
        onChanged(result.revision);
        if (report) {
          // The popup closes, and the saved card's own note confirms the save.
          closeForm();
          setSavedNote(result.mapping ? { id: result.mapping.id } : null);
        } else setMessage(result.pending ? "Saved. Some coverage checks need attention. See Scan Issues for details. Fresh provider verification will run on the next Plex search." : "Saved. Affected cached Plex comparisons have been rechecked. Fresh provider verification will run on the next Plex search.");
        await load();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save the Manual Match.");
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
      setError(error instanceof Error ? error.message : "Could not delete the Manual Match.");
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
      setMessage(`Deleted ${plural(body.deleted.length, "Manual Match", "Manual Matches")}.${body.missing.length ? ` ${plural(body.missing.length, "selected Manual Match was", "selected Manual Matches were")} already removed.` : ""} Affected cached Plex comparisons have been rechecked. Fresh provider verification will run on the next Plex search.`);
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete the selected Manual Matches.");
    } finally { setBusy(false); }
  }
  // On the Manual Matches page the whole editor opens in a popup; Matching Episodes is already one.
  const form = <ManualMatchForm editing={editing} creatable={!episodeScope && !report} urls={urls} onUrlsChange={update => { setUrls(update); setPreview(null); }} onResolve={() => void action({ action: "resolve", urls, id: editing?.id })} onCreate={createMapping}
   draftMembers={draftMembers} draft={{ members: draftState, flags: draftFlags, locked: draftLocked, onToggle: toggleFlag }} savePaused={scanRunning} hasPreview={Boolean(preview)} selectionProblem={selectionProblem} flagsChanged={flagsChanged} dirty={dirty}
   inPopup={report} onCancel={report ? requestFormClose : cancelDraft} onSave={saveDraft}/>;
  const editedName = matchName(editing);
  const feedback = <>{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}</>;
  return <section className={`manual-match-editor ${report ? "manual-match-report" : ""}`}>
 {scanRunning ? <p role="status">A Plex scan is running. Wait for it to finish before changing Manual Matches.</p> : null}
 {report && <button className="primary" disabled={locked} onClick={createMapping}>+ Add Manual Match</button>}
 {formOpen && !report && form}
 {formOpen && report
   ? <Popup title={editorTitle(editing)} className="manual-match-form-popup" onRequestClose={requestFormClose}>
     {scanRunning && <p role="status" className="manual-match-scan-paused"><strong>A Plex scan is running.</strong> Saving is paused until it finishes. Your changes are kept.</p>}
     {form}{feedback}
   </Popup>
   : feedback}
 {formOpen && report && discardPromptOpen && <Popup title="Discard your changes?" className="manual-match-discard-confirm" onRequestClose={() => setDiscardPromptOpen(false)}>
   <p className="modal-copy">{editedName ? <>You changed <strong>{editedName}</strong> but haven&apos;t saved it.</> : "You haven't saved this new Manual Match."} Closing now throws those changes away.</p>
   <div className="modal-actions"><button className="secondary" onClick={() => setDiscardPromptOpen(false)}>Keep editing</button><button className="danger" onClick={closeForm}>Discard changes</button></div>
 </Popup>}
 <ManualMatchList matches={scopedMappings} report={report} filterSelectAndPage={!episodeScope} locked={locked} pending={pending}
   healthFilter={healthFilter} onHealthFilterChange={filter => {
    setHealthFilter(filter);
    setPage(1);
    changeSelection([]);
    setMessage("Selection cleared because the health filter changed.");
  }}
   paging={{ page, pageSize, onPageChange: setPage, onPageSizeChange: size => { setPageSize(size); setPage(1); } }}
   selection={{ selected, onSelectionChange: changeSelection, confirmation, onConfirmationChange: setConfirmation }}
   onDeleteSelected={ids => void removeSelected(ids)} onEdit={editMapping} onDelete={id => void remove(id)} savedId={savedNote?.id}/>
 </section>;
}
