"use client";

type ScanSortField = "title" | "percent";

type Props = {
  field: ScanSortField;
  ascending: boolean;
  open: boolean;
  onToggle: () => void;
  onChoose: (field: ScanSortField) => void;
};

export function ScanSortControl({ field, ascending, open, onToggle, onChoose }: Props) {
  return (
    <div className="sort-control-wrap">
      <span>Sort</span>
      <div className="sort-control" data-menu-root="sort">
        <button type="button" className="sort-trigger" onClick={onToggle} aria-haspopup="menu" aria-expanded={open}>
          <span>{field === "title" ? "By title" : "By percent collected"}</span>
          <b aria-label={ascending ? "Ascending" : "Descending"}>{ascending ? "▲" : "▼"}</b>
        </button>
        {open && (
          <div className="sort-menu" role="menu">
            {(["title", "percent"] as const).map((option) => (
              <button type="button" role="menuitem" className={field === option ? "selected" : ""} onClick={() => onChoose(option)} key={option}>
                <span>{option === "title" ? "Title" : "Percent collected"}</span>
                <b>{field === option ? (ascending ? "↑" : "↓") : ""}</b>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
