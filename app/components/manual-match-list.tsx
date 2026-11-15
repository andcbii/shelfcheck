"use client";
import { useState } from "react";
import { MATCH_HEALTH_LABELS, ManualMatchCard, matchesHealthFilter, type HealthFilter, type MatchHealth } from "@/app/components/manual-match-card";
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
  // Without the health filter, selection and paging the list shows every card, unticked.
  filterSelectAndPage: boolean;
  locked: boolean;
  pending: boolean;
  healthFilter: HealthFilter;
  onHealthFilterChange: (filter: HealthFilter) => void;
  paging: ManualMatchPaging;
  selection: ManualMatchSelection;
  onDeleteSelected: (ids: string[]) => void;
  onEdit: (match: CoverageMapping) => void;
  onDelete: (id: string) => void;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// A Manual Match named by its first episode, e.g. "Animaniacs · Murder Pals".
const matchName = (match: CoverageMapping) => match.members[0] ? `${match.members[0].show} · ${match.members[0].title}` : "Manual Match";
const episodeCounts = (match: CoverageMapping) => (["TMDB", "TVDB"] as const).map(provider => plural(match.members.filter(member => member.provider === provider).length, `${provider} episode`, `${provider} episodes`)).join(", ");

// Asks before deleting one or several Manual Matches; Cancel, Close, Esc and a click outside delete nothing.
function DeleteConfirmation({ matches, locked, onCancel, onConfirm }: { matches: CoverageMapping[]; locked: boolean; onCancel: () => void; onConfirm: () => void }) {
  const single = matches.length === 1 && matches[0];
  return <Popup title={single ? "Delete Manual Match" : "Delete Manual Matches"} className="manual-match-delete" onRequestClose={onCancel}>
    <p className="manual-match-delete-question">{single ? "Delete this match?" : `Delete ${plural(matches.length, "match", "matches")}?`}</p>
    {single ? <p>{matchName(single)} ({episodeCounts(single)}).</p> : <ul>{matches.map(match => <li key={match.id}>{matchName(match)}</li>)}</ul>}
    <p className="modal-copy">Plex comparisons will be rechecked. This can’t be undone.</p>
    <div className="modal-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="danger" disabled={locked} onClick={onConfirm}>{single ? "Delete match" : `Delete ${plural(matches.length, "match", "matches")}`}</button></div>
  </Popup>;
}

export function ManualMatchList({ matches, report, filterSelectAndPage, locked, pending, healthFilter, onHealthFilterChange, paging: { page, pageSize, onPageChange, onPageSizeChange }, selection: { selected, onSelectionChange, confirmation, onConfirmationChange }, onDeleteSelected, onEdit, onDelete }: Props) {
  const visibleMatches = matches.filter(match => matchesHealthFilter(match, healthFilter));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleMatches.length / pageSize)));
  const selectedIds = selected.filter(id => visibleMatches.some(match => match.id === id));
  const pageMatches = visibleMatches.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  // The one Manual Match whose Delete awaits confirmation; a refresh that removes it closes the confirmation.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deleting = matches.find(match => match.id === deletingId) || null;
  if (deletingId && !deleting) setDeletingId(null);
  // A bulk confirmation shows only while every Manual Match it names is still listed, never a shrunken one.
  const confirming = confirmation?.map(id => matches.find(match => match.id === id)).filter(match => match !== undefined);
  const bulkConfirmation = confirming?.length && confirming.length === confirmation?.length ? confirming : null;
  return <>
 {filterSelectAndPage && <><label>Mapping health<select aria-label="Mapping health" value={healthFilter} disabled={locked} onChange={event => onHealthFilterChange(event.target.value as HealthFilter)}><option value="all">All mappings</option>{(Object.keys(MATCH_HEALTH_LABELS) as MatchHealth[]).map(health => <option key={health} value={health}>{MATCH_HEALTH_LABELS[health]}</option>)}</select></label>
 <p role="status">{pending ? <>Some coverage checks need attention. <a href="/reports/coverage-issues">See Scan Issues</a> for details.</> : ""}</p><h3>{report ? "Manual Matches" : "Saved mappings"} ({matches.length})</h3>{!matches.length && <div className="empty auto-match-empty"><h3>{report ? "No Manual Matches" : "No manual coverage mappings saved."}</h3><p>Create a Manual Match to link complete episode sets, even before either set is owned.</p></div>}
 {selectedIds.length > 0 && <section className="manual-match-bulk-bar" aria-label="Selected Manual Matches"><p role="status">{selectedIds.length} selected · Selection spans pages; changing the health filter clears it.</p><button disabled={locked || selectedIds.length === visibleMatches.length} onClick={() => onSelectionChange(visibleMatches.map(match => match.id))}>Select all {visibleMatches.length} matching mappings</button><button disabled={locked} onClick={() => onSelectionChange([])}>Clear selection</button><button className="danger" disabled={locked} onClick={() => onConfirmationChange([...selectedIds])}>Delete {plural(selectedIds.length, "selected match", "selected matches")}</button></section>}
 {bulkConfirmation && <DeleteConfirmation matches={bulkConfirmation} locked={locked} onCancel={() => onConfirmationChange(null)} onConfirm={() => { onConfirmationChange(null); onDeleteSelected(bulkConfirmation.map(match => match.id)); }}/>}
 <ReportPagination total={visibleMatches.length} page={currentPage} pageSize={pageSize} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange}/>
 </>}
 {pageMatches.map(match => <ManualMatchCard key={match.id} match={match} locked={locked} selection={filterSelectAndPage ? { selected: selectedIds.includes(match.id), onChange: checked => onSelectionChange(checked ? [...selectedIds, match.id] : selectedIds.filter(id => id !== match.id)) } : undefined} onEdit={() => onEdit(match)} onDelete={() => setDeletingId(match.id)}/>)}
 {deleting && <DeleteConfirmation matches={[deleting]} locked={locked} onCancel={() => setDeletingId(null)} onConfirm={() => { setDeletingId(null); onDelete(deleting.id); }}/>}
 </>;
}
