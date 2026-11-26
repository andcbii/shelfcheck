"use client";
import { useId, useState, type KeyboardEvent } from "react";
import type { ShowOption } from "@/lib/manual-match-filters";

type Props = {
  label: string;
  options: ShowOption[];
  picked: number[];
  onChange: (picked: number[]) => void;
};

/**
 * A type-to-search, multi-select show filter: a combobox whose listbox lists
 * the shows. Typing narrows the shows by name; clicking or Enter picks or
 * unpicks the highlighted show, and the arrow keys move the highlight.
 */
export function ManualMatchShowFilter({ label, options, picked, onChange }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = query.trim().toLowerCase();
  const matchingOptions = options.filter(option => option.label.toLowerCase().includes(search));
  const highlighted = matchingOptions[Math.min(active, matchingOptions.length - 1)];
  const optionId = (option: ShowOption) => `${id}-show-${option.showId}`;
  function toggle(option: ShowOption) {
    onChange(picked.includes(option.showId) ? picked.filter(showId => showId !== option.showId) : [...picked, option.showId]);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.max(0, Math.min(matchingOptions.length - 1, Math.min(active, matchingOptions.length - 1) + step)));
    } else if (event.key === "Enter" && open && highlighted) {
      event.preventDefault();
      toggle(highlighted);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }
  const pickedOptions = options.filter(option => picked.includes(option.showId));
  return <div className="show-filter" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <label htmlFor={`${id}-input`}>{label}</label>
    {pickedOptions.length > 0 && <ul className="show-filter-picks" aria-label={`Picked ${label}`}>
      {pickedOptions.map(option => <li key={option.showId}>{option.label}<button type="button" aria-label={`Remove ${option.label}`} onClick={() => toggle(option)}>×</button></li>)}
    </ul>}
    <input id={`${id}-input`} role="combobox" aria-expanded={open} aria-controls={`${id}-listbox`} aria-autocomplete="list" aria-activedescendant={open && highlighted ? optionId(highlighted) : undefined}
      autoComplete="off" placeholder={pickedOptions.length ? "Add a show" : "All shows"} value={query}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} onKeyDown={onKeyDown}/>
    {open && <ul id={`${id}-listbox`} role="listbox" aria-label={label} aria-multiselectable="true">
      {matchingOptions.map(option => <li key={option.showId} id={optionId(option)} role="option" aria-selected={picked.includes(option.showId)} className={option === highlighted ? "active" : undefined}
        onMouseDown={event => event.preventDefault()} onClick={() => toggle(option)}>{option.label}</li>)}
    </ul>}
    <p className="show-filter-none" role="status">{open && !matchingOptions.length ? "No shows match" : ""}</p>
  </div>;
}
