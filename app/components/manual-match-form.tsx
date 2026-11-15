"use client";
import { useId } from "react";
import { episodeName, ManualMatchPanels, type ReportMissingDraft } from "@/app/components/manual-match-panels";
import { INCOMPLETE_LABEL, memberKey, missingPartsOf, type CoverageMapping, type CoverageMember } from "@/lib/manual-coverage-model";

type Props = {
  editing: CoverageMapping | null;
  // Offers starting a new Manual Match from the form.
  creatable: boolean;
  urls: string[];
  // Edits the episode inputs; any change discards the preview.
  onUrlsChange: (update: (urls: string[]) => string[]) => void;
  onResolve: () => void;
  onCreate: () => void;
  // The reviewed episodes being edited, with null before the first review.
  draftMembers: CoverageMember[] | null;
  // The draft as it would be saved (explicit Report Missing flags only). Its lock applies to the whole form.
  draft: ReportMissingDraft;
  // A resolved preview of changed episodes is waiting to be saved.
  hasPreview: boolean;
  selectionProblem?: string | null;
  flagsChanged: boolean;
  dirty: boolean;
  onCancel: () => void;
  onSave: () => void;
};

// The Manual Match editor form: episode inputs, Resolve and review, Report Missing and Save.
export function ManualMatchForm({ editing, creatable, urls, onUrlsChange, onResolve, onCreate, draftMembers, draft, hasPreview, selectionProblem, flagsChanged, dirty, onCancel, onSave }: Props) {
  const { members: draftState, locked } = draft;
  const uid = useId();
  const draftFlagged = draftState.filter(member => member.reportMissing);
  const draftIncomplete = draftState.filter(member => !member.reportMissing && missingPartsOf(draftState, member).length);
  function draftEditor(members: CoverageMember[]) {
    return <section aria-label={hasPreview ? "Resolved episode preview" : "Manual Match episodes"}>
      <p className="report-missing-explanation"><strong>Report Missing</strong> keeps an episode missing in your Plex results when your local copy lacks its content, even if matching would mark it collected. Reporting a split episode missing also keeps its combined episode missing. When both sides list several episodes, report at least one episode missing on each side, or none. It is a local Shelfcheck override: Shelfcheck sends no report to Plex, TMDB, or TVDB.</p>
      <ManualMatchPanels members={members} idPrefix="draft" draft={draft}/>
      {selectionProblem
        ? <p className="report-missing-validation" id={`${uid}-report-missing-validation`} aria-live="polite">{selectionProblem}</p>
        : <p className="report-missing-impact" aria-live="polite"><strong>After saving</strong> {draftFlagged.length
        ? <>{draftFlagged.map(episodeName).join(", ")} {draftFlagged.length === 1 ? "stays" : "stay"} missing as Reported missing in Plex results.
          {draftIncomplete.map(member => ` ${episodeName(member)} stays missing as ${INCOMPLETE_LABEL} because it contains ${missingPartsOf(draftState, member).map(part => episodeName(draftState.find(item => memberKey(item) === memberKey(part))!)).join(" and ")}.`).join("")}
          {members.length - draftFlagged.length - draftIncomplete.length === 1 ? " The other episode follows normal matching." : members.length > draftFlagged.length + draftIncomplete.length ? " The other episodes follow normal matching." : ""}</>
        : "every episode follows normal matching."}</p>}
      <p className="manual-match-draft-state">{dirty ? "Unsaved changes" : "No unsaved changes"}</p>
      <button disabled={locked || !dirty} onClick={onCancel}>Cancel</button>
      <button disabled={locked || (!hasPreview && !flagsChanged) || Boolean(selectionProblem)} aria-describedby={selectionProblem ? `${uid}-report-missing-validation` : undefined} onClick={onSave}>Save coverage mapping</button>
    </section>;
  }
  return <section className="manual-match-form" aria-label="Manual Match editor">
 {editing && <p>Editing mapping {editing.id} · Revision {editing.revision}</p>}
 {creatable && <button disabled={locked} onClick={onCreate}>Create mapping</button>}
 <p>You can create a mapping before owning either set. Enter episode URLs, tvdb:200, or tmdb:100 show:10 season:1 episode:2. TMDB IDs require show, season and episode context; show IDs alone cannot identify episodes.</p>
 <p>Link complete TMDB and TVDB episode sets representing the same content. Each side needs at least one episode. Review every record before saving.</p>
 {urls.map((url, index) => <label key={index}>Episode URL or provider-qualified ID {index + 1}<input disabled={locked} aria-label={`Episode URL or provider-qualified ID ${index + 1}`} value={url} onChange={event => onUrlsChange(current => current.map((value, i) => i === index ? event.target.value : value))}/>{urls.length > 2 && <button disabled={locked} onClick={() => onUrlsChange(current => current.filter((_, i) => i !== index))}>Remove episode {index + 1}</button>}</label>)}
 <button disabled={locked} onClick={() => onUrlsChange(current => [...current, ""])}>Add episode</button>
 <button disabled={locked || urls.some(url => !url.trim())} onClick={onResolve}>Resolve and review</button>
 {draftMembers && draftEditor(draftMembers)}
 </section>;
}
