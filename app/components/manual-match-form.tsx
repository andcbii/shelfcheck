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
  // A Plex scan is running: Save waits for it to end, whatever the draft's lock.
  savePaused?: boolean;
  // The form fills the Manual Matches page's editor popup: the popup title names the edited
  // Manual Match instead of its ID and revision, the help text is short, a Review divider leads
  // into the reviewed episodes, and Cancel closes the popup, so it stays available without
  // unsaved changes. Otherwise Cancel resets the draft.
  inPopup?: boolean;
  onCancel: () => void;
  onSave: () => void;
};

// The Manual Match editor form: one column of episode inputs, the reviewed episodes with
// Report Missing, and a footer with Cancel, Resolve and review (always, so an expired preview can
// be resolved again), and Save once there are reviewed or saved episodes.
export function ManualMatchForm({ editing, creatable, urls, onUrlsChange, onResolve, onCreate, draftMembers, draft, hasPreview, selectionProblem, flagsChanged, dirty, savePaused = false, inPopup = false, onCancel, onSave }: Props) {
  const { members: draftState, locked } = draft;
  const uid = useId();
  const draftFlagged = draftState.filter(member => member.reportMissing);
  const draftIncomplete = draftState.filter(member => !member.reportMissing && missingPartsOf(draftState, member).length);
  function draftEditor(members: CoverageMember[]) {
    return <section aria-label={hasPreview ? "Resolved episode preview" : "Manual Match episodes"}>
      {inPopup && <p className="manual-match-review-divider">Review</p>}
      <ManualMatchPanels members={members} idPrefix="draft" draft={draft}/>
      <p className="report-missing-explanation"><strong>Report Missing</strong> {inPopup
        ? "keeps an episode missing in your Plex results when your copy lacks its content. It stays in Shelfcheck and is never sent to Plex, TMDB or TVDB."
        : "keeps an episode missing in your Plex results when your local copy lacks its content, even if matching would mark it collected. Reporting a split episode missing also keeps its combined episode missing. When both sides list several episodes, report at least one episode missing on each side, or none. It is a local Shelfcheck override: Shelfcheck sends no report to Plex, TMDB, or TVDB."}</p>
      {selectionProblem
        ? <p className="report-missing-validation" id={`${uid}-report-missing-validation`} aria-live="polite">{selectionProblem}</p>
        : <p className="report-missing-impact" aria-live="polite"><strong>After saving</strong> {draftFlagged.length
        ? <>{draftFlagged.map(episodeName).join(", ")} {draftFlagged.length === 1 ? "stays" : "stay"} missing as Reported missing in Plex results.
          {draftIncomplete.map(member => ` ${episodeName(member)} stays missing as ${INCOMPLETE_LABEL} because it contains ${missingPartsOf(draftState, member).map(part => episodeName(draftState.find(item => memberKey(item) === memberKey(part))!)).join(" and ")}.`).join("")}
          {members.length - draftFlagged.length - draftIncomplete.length === 1 ? " The other episode follows normal matching." : members.length > draftFlagged.length + draftIncomplete.length ? " The other episodes follow normal matching." : ""}</>
        : "every episode follows normal matching."}</p>}
    </section>;
  }
  return <section className="manual-match-form" aria-label="Manual Match editor">
 {editing && !inPopup && <p>Editing mapping {editing.id} · Revision {editing.revision}</p>}
 {creatable && <button disabled={locked} onClick={onCreate}>Create mapping</button>}
 {inPopup
   ? <p className="manual-match-help">Add each episode&apos;s TMDB or TVDB link (or an ID like <code>tvdb:200</code>) in any order. Each side needs at least one episode.</p>
   : <>
     <p>You can create a mapping before owning either set. Enter episode URLs, tvdb:200, or tmdb:100 show:10 season:1 episode:2. TMDB IDs require show, season and episode context; show IDs alone cannot identify episodes.</p>
     <p>Link complete TMDB and TVDB episode sets representing the same content. Each side needs at least one episode. Review every record before saving.</p>
   </>}
 <div className="manual-match-episodes">{urls.map((url, index) => <div className="manual-match-episode" key={index}><label>Episode {index + 1}<input disabled={locked} value={url} onChange={event => onUrlsChange(current => current.map((value, i) => i === index ? event.target.value : value))}/></label>{urls.length > 2 && <button disabled={locked} onClick={() => onUrlsChange(current => current.filter((_, i) => i !== index))}>Remove episode {index + 1}</button>}</div>)}</div>
 <button className="manual-match-add-episode" disabled={locked} onClick={() => onUrlsChange(current => [...current, ""])}>+ Add episode</button>
 {draftMembers && draftEditor(draftMembers)}
 <footer className="manual-match-form-footer">
   <p className="manual-match-draft-state">{!draftMembers ? "Nothing changes until you review and save." : dirty ? `${inPopup ? "● " : ""}Unsaved changes` : "No unsaved changes"}</p>
   <button disabled={locked || !(dirty || inPopup)} onClick={onCancel}>Cancel</button>
   <button className={draftMembers ? undefined : "primary"} disabled={locked || urls.some(url => !url.trim())} onClick={onResolve}>Resolve and review</button>
   {draftMembers && <button className="primary" disabled={locked || savePaused || (!hasPreview && !flagsChanged) || Boolean(selectionProblem)} aria-describedby={selectionProblem ? `${uid}-report-missing-validation` : undefined} onClick={onSave}>Save coverage mapping</button>}
 </footer>
 </section>;
}
