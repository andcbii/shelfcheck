"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ManualMatchCard } from "@/app/components/manual-match-card";
import { Popup } from "@/app/components/popup";
import { ReportPagination } from "@/app/reports/report-pagination";
import type { CoverageMapping } from "@/lib/manual-coverage-model";

export type ManualMatchPaging = {
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
};
// Ticked Manual Matches, and those awaiting confirmation of a bulk delete.
export type ManualMatchSelection = {
  selected: string[];
  onSelectionChange: (ids: string[]) => void;
  confirmation: string[] | null;
  onConfirmationChange: (ids: string[] | null) => void;
};
type Props = {
  matches: CoverageMapping[];
  report: boolean;
  // Without selection and paging the list shows every card, unticked.
  filterSelectAndPage: boolean;
  locked: boolean;
  pending: boolean;
  paging: ManualMatchPaging;
  selection: ManualMatchSelection;
  onDeleteSelected: (ids: string[]) => void;
  onEdit: (match: CoverageMapping) => void;
  onDelete: (id: string) => void;
  // The Manual Match just saved, whose card says so.
  savedId?: string | null;
  // The report's show filters: their controls, the unfiltered count, and whether any is on.
  showFilters?: ManualMatchShowFilters;
};
type ManualMatchShowFilters = { controls: ReactNode; total: number; active: boolean; onClear: () => void };

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// A Manual Match named by its first episode, e.g. "Animaniacs · Murder Pals".
const matchName = (match: CoverageMapping) => match.members[0] ? `${match.members[0].show} · ${match.members[0].title}` : "Manual Match";
const episodeCounts = (match: CoverageMapping) => (["TMDB", "TVDB"] as const).map(provider => plural(match.members.filter(member => member.provider === provider).length, `${provider} episode`, `${provider} episodes`)).join(", ");

// Asks before deleting one or several Manual Matches; Cancel, Close, Esc and a click outside delete nothing.
function DeleteConfirmation({ matches, locked, onCancel, onConfirm }: { matches: CoverageMapping[]; locked: boolean; onCancel: () => void; onConfirm: () => void }) {
  const single = matches.length === 1 && matches[0];
  return <Popup title={single ? "Delete Manual Match" : "Delete Manual Matches"} className="manual-match-delete-confirm" onRequestClose={onCancel}>
    <p className="manual-match-delete-question">{single ? "Delete this match?" : `Delete ${plural(matches.length, "match", "matches")}?`}</p>
    {single ? <p>{matchName(single)} ({episodeCounts(single)}).</p> : <ul>{matches.map(match => <li key={match.id}>{matchName(match)}</li>)}</ul>}
    <p className="modal-copy">Plex comparisons will be rechecked. This can’t be undone.</p>
    <div className="modal-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="danger" disabled={locked} onClick={onConfirm}>{single ? "Delete match" : `Delete ${plural(matches.length, "match", "matches")}`}</button></div>
  </Popup>;
}

export function ManualMatchList({ matches, report, filterSelectAndPage, locked, pending, paging: { page, pageSize, onPageChange, onPageSizeChange }, selection: { selected, onSelectionChange, confirmation, onConfirmationChange }, onDeleteSelected, onEdit, onDelete, savedId, showFilters }: Props) {
  const currentPage = Math.min(page, Math.max(1, Math.ceil(matches.length / pageSize)));
  const selectedIds = selected.filter(id => matches.some(match => match.id === id));
  const pageMatches = matches.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  // The one Manual Match whose Delete awaits confirmation; a refresh that removes it closes the confirmation.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deleting = matches.find(match => match.id === deletingId) || null;
  if (deletingId && !deleting) setDeletingId(null);
  // A bulk confirmation shows only while every Manual Match it names is still listed; otherwise it is
  // cleared rather than shrunk, so it cannot reopen if the Manual Match comes back.
  const confirming = confirmation?.map(id => matches.find(match => match.id === id)).filter(match => match !== undefined);
  const bulkConfirmation = confirming?.length && confirming.length === confirmation?.length ? confirming : null;
  const staleConfirmation = Boolean(confirmation && !bulkConfirmation);
  useEffect(() => { if (staleConfirmation) onConfirmationChange(null); }, [staleConfirmation, onConfirmationChange]);
  return <>
 {filterSelectAndPage && <><p role="status">{pending ? <>Some coverage checks need attention. <a href="/reports/coverage-issues">See Scan Issues</a> for details.</> : ""}</p><h3>{report ? "Manual Matches" : "Saved Manual Matches"} ({showFilters?.active ? `${matches.length} of ${showFilters.total}` : matches.length})</h3>
 {showFilters && showFilters.total > 0 && showFilters.controls}
 {!matches.length && (showFilters?.active
   ? <div className="empty auto-match-empty"><h3>No Manual Matches match these filters</h3><button className="secondary" onClick={showFilters.onClear}>Clear filters</button></div>
   : <div className="empty auto-match-empty"><h3>{report ? "No Manual Matches" : "No Manual Matches saved."}</h3><p>Create a Manual Match to link complete episode sets, even before either set is owned.</p></div>)}
 {selectedIds.length > 0 && <section className="manual-match-bulk-bar" aria-label="Selected Manual Matches"><p role="status">{selectedIds.length} selected · Selection spans pages.</p><button disabled={locked || selectedIds.length === matches.length} onClick={() => onSelectionChange(matches.map(match => match.id))}>Select all {plural(matches.length, "Manual Match", "Manual Matches")}</button><button disabled={locked} onClick={() => onSelectionChange([])}>Clear selection</button><button className="danger" disabled={locked} onClick={() => onConfirmationChange([...selectedIds])}>Delete {plural(selectedIds.length, "selected match", "selected matches")}</button></section>}
 {bulkConfirmation && <DeleteConfirmation matches={bulkConfirmation} locked={locked} onCancel={() => onConfirmationChange(null)} onConfirm={() => { onConfirmationChange(null); onDeleteSelected(bulkConfirmation.map(match => match.id)); }}/>}
 <ReportPagination total={matches.length} page={currentPage} pageSize={pageSize} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange}/>
 </>}
 {pageMatches.map(match => <ManualMatchCard key={match.id} match={match} locked={locked} saved={match.id === savedId} selection={filterSelectAndPage ? { selected: selectedIds.includes(match.id), onChange: checked => onSelectionChange(checked ? [...selectedIds, match.id] : selectedIds.filter(id => id !== match.id)) } : undefined} onEdit={() => onEdit(match)} onDelete={() => setDeletingId(match.id)}/>)}
 {deleting && <DeleteConfirmation matches={[deleting]} locked={locked} onCancel={() => setDeletingId(null)} onConfirm={() => { setDeletingId(null); onDelete(deleting.id); }}/>}
 </>;
}
