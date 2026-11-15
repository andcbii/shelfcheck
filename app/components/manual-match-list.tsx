"use client";
import { ManualMatchCard } from "@/app/components/manual-match-card";
import { ReportPagination } from "@/app/reports/report-pagination";
import type { CoverageMapping } from "@/lib/manual-coverage-model";

type Props = {
  mappings: CoverageMapping[];
  report: boolean;
  // Filter, selection and paging controls. Without them the list shows every card, unticked.
  controls: boolean;
  locked: boolean;
  pending: boolean;
  healthFilter: string;
  onHealthFilterChange: (filter: string) => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  selected: string[];
  onSelectionChange: (ids: string[]) => void;
  confirmation: string[] | null;
  onConfirmationChange: (ids: string[] | null) => void;
  onDeleteSelected: (ids: string[]) => void;
  onEdit: (mapping: CoverageMapping) => void;
  onDelete: (id: string) => void;
};

export function ManualMatchList({ mappings, report, controls, locked, pending, healthFilter, onHealthFilterChange, page, pageSize, onPageChange, onPageSizeChange, selected, onSelectionChange, confirmation, onConfirmationChange, onDeleteSelected, onEdit, onDelete }: Props) {
  const visibleMappings = mappings.filter(mapping => healthFilter === "all" || (mapping.health || "healthy") === healthFilter);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleMappings.length / pageSize)));
  const selectedIds = selected.filter(id => visibleMappings.some(mapping => mapping.id === id));
  const pageMappings = visibleMappings.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  return <>
 {controls && <><label>Mapping health<select aria-label="Mapping health" value={healthFilter} disabled={locked} onChange={event => onHealthFilterChange(event.target.value)}><option value="all">All mappings</option><option value="healthy">Healthy</option><option value="needs-review">Needs review</option><option value="pending">Pending</option></select></label>
 <p role="status">{pending ? <>Some coverage checks need attention. <a href="/reports/coverage-issues">See Scan Issues</a> for details.</> : ""}</p><h3>{report ? "Manual Matches" : "Saved mappings"} ({mappings.length})</h3>{!mappings.length && <div className="empty auto-match-empty"><h3>{report ? "No Manual Matches" : "No manual coverage mappings saved."}</h3><p>Create a Manual Match to link complete episode sets, even before either set is owned.</p></div>}
 <section aria-label="Mapping selection"><p role="status">{selectedIds.length} mappings selected. Selection spans pages; changing the health filter clears it.</p><button disabled={locked || !visibleMappings.length} onClick={() => onSelectionChange(visibleMappings.map(mapping => mapping.id))}>Select all {visibleMappings.length} matching mappings</button><button disabled={locked || !selectedIds.length} onClick={() => onSelectionChange([])}>Clear selection</button><button disabled={locked || !selectedIds.length} onClick={() => onConfirmationChange([...selectedIds])}>Delete selected mappings</button></section>
 {confirmation && <section role="alertdialog" aria-label="Confirm mapping deletion"><p>Delete {confirmation.length} selected mappings? Plex comparisons will be rechecked.</p><button disabled={locked} onClick={() => onDeleteSelected(confirmation)}>Confirm delete {confirmation.length} mappings</button><button disabled={locked} onClick={() => onConfirmationChange(null)}>Cancel bulk deletion</button></section>}
 <ReportPagination total={visibleMappings.length} page={currentPage} pageSize={pageSize} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange}/>
 </>}
 {pageMappings.map(mapping => <ManualMatchCard key={mapping.id} mapping={mapping} locked={locked} selection={controls ? { selected: selectedIds.includes(mapping.id), onChange: checked => onSelectionChange(checked ? [...selectedIds, mapping.id] : selectedIds.filter(id => id !== mapping.id)) } : undefined} onEdit={() => onEdit(mapping)} onDelete={() => onDelete(mapping.id)}/>)}
 </>;
}
