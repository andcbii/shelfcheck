"use client";

type Props = { total: number; page: number; pageSize: number; onPageChange: (page: number) => void; onPageSizeChange: (pageSize: number) => void };

export function ReportPagination({ total, page, pageSize, onPageChange, onPageSizeChange }: Props) {
  if (!total) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="report-pagination"><p>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</p><label>Results per page<select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>{[10, 25, 50, 100].map((size) => <option value={size} key={size}>{size}</option>)}</select></label><div><button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page === 1}>← Previous</button><span>{page} / {totalPages}</span><button type="button" onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page === totalPages}>Next →</button></div></div>;
}
