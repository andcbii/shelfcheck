"use client";
import { MATCH_HEALTH_LABELS, ManualMatchCard, matchesHealthFilter, type HealthFilter, type MatchHealth } from "@/app/components/manual-match-card";
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

export function ManualMatchList({ matches, report, filterSelectAndPage, locked, pending, healthFilter, onHealthFilterChange, paging: { page, pageSize, onPageChange, onPageSizeChange }, selection: { selected, onSelectionChange, confirmation, onConfirmationChange }, onDeleteSelected, onEdit, onDelete }: Props) {
  const visibleMatches = matches.filter(match => matchesHealthFilter(match, healthFilter));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleMatches.length / pageSize)));
  const selectedIds = selected.filter(id => visibleMatches.some(match => match.id === id));
  const pageMatches = visibleMatches.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  return <>
 {filterSelectAndPage && <><label>Mapping health<select aria-label="Mapping health" value={healthFilter} disabled={locked} onChange={event => onHealthFilterChange(event.target.value as HealthFilter)}><option value="all">All mappings</option>{(Object.keys(MATCH_HEALTH_LABELS) as MatchHealth[]).map(health => <option key={health} value={health}>{MATCH_HEALTH_LABELS[health]}</option>)}</select></label>
 <p role="status">{pending ? <>Some coverage checks need attention. <a href="/reports/coverage-issues">See Scan Issues</a> for details.</> : ""}</p><h3>{report ? "Manual Matches" : "Saved mappings"} ({matches.length})</h3>{!matches.length && <div className="empty auto-match-empty"><h3>{report ? "No Manual Matches" : "No manual coverage mappings saved."}</h3><p>Create a Manual Match to link complete episode sets, even before either set is owned.</p></div>}
 <section aria-label="Mapping selection"><p role="status">{selectedIds.length} mappings selected. Selection spans pages; changing the health filter clears it.</p><button disabled={locked || !visibleMatches.length} onClick={() => onSelectionChange(visibleMatches.map(match => match.id))}>Select all {visibleMatches.length} matching mappings</button><button disabled={locked || !selectedIds.length} onClick={() => onSelectionChange([])}>Clear selection</button><button disabled={locked || !selectedIds.length} onClick={() => onConfirmationChange([...selectedIds])}>Delete selected mappings</button></section>
 {confirmation && <section role="alertdialog" aria-label="Confirm mapping deletion"><p>Delete {confirmation.length} selected mappings? Plex comparisons will be rechecked.</p><button disabled={locked} onClick={() => onDeleteSelected(confirmation)}>Confirm delete {confirmation.length} mappings</button><button disabled={locked} onClick={() => onConfirmationChange(null)}>Cancel bulk deletion</button></section>}
 <ReportPagination total={visibleMatches.length} page={currentPage} pageSize={pageSize} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange}/>
 </>}
 {pageMatches.map(match => <ManualMatchCard key={match.id} match={match} locked={locked} selection={filterSelectAndPage ? { selected: selectedIds.includes(match.id), onChange: checked => onSelectionChange(checked ? [...selectedIds, match.id] : selectedIds.filter(id => id !== match.id)) } : undefined} onEdit={() => onEdit(match)} onDelete={() => onDelete(match.id)}/>)}
 </>;
}
