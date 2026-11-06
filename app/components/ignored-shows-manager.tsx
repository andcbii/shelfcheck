"use client";

import { useEffect, useRef, useState } from "react";
import type { IgnoreDuration, IgnoreTiming } from "@/lib/ignored-shows";
import { IgnoreDurationOptions } from "@/app/components/ignore-duration-controls";

type IgnoredItem = { key: string | number; title: string; detail?: string } & IgnoreTiming;

type Props = {
  items: IgnoredItem[];
  onClose: () => void;
  onRestore: (key: string | number) => void;
  onChangeDuration: (key: string | number, duration: IgnoreDuration) => void;
  showCount?: boolean;
};

export function IgnoredShowsManager({ items, onClose, onRestore, onChangeDuration, showCount = false }: Props) {
  const [editingKey, setEditingKey] = useState<string | number | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const changeButtons = useRef(new Map<string | number, HTMLButtonElement>());
  useEffect(() => { editorRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [editingKey]);
  function closeEditor(key: string | number) {
    setEditingKey(null);
    changeButtons.current.get(key)?.focus();
  }

  return (
    <section className="ignored-manager" aria-label="Ignored shows" data-menu-root="ignored">
      <div>
        <h3>Ignored shows{showCount ? ` (${items.length})` : ""}</h3>
        <button type="button" onClick={onClose} aria-label="Close ignored shows">×</button>
      </div>
      {items.length === 0 ? <p>No shows are ignored.</p> : items.map((show) => (
        <div className="ignored-row" key={show.key}>
          <span>{show.title}{show.detail && <small>{show.detail}</small>}<small className="ignore-expiry">{show.expiresAt ? <>Until <time dateTime={show.expiresAt}>{new Date(show.expiresAt).toLocaleString()}</time></> : "Forever"}</small></span>
          <div className="ignored-row-actions"><button ref={(button) => { if (button) changeButtons.current.set(show.key, button); else changeButtons.current.delete(show.key); }} type="button" aria-expanded={editingKey === show.key} aria-label={`Change ignore duration for ${show.title}${show.detail ? ` (${show.detail})` : ""}`} onClick={() => setEditingKey((current) => current === show.key ? null : show.key)}>Change duration</button><button type="button" aria-label={`Restore ${show.title}${show.detail ? ` (${show.detail})` : ""}`} onClick={() => onRestore(show.key)}>Restore</button></div>
          {editingKey === show.key && <div className="ignored-duration-editor" ref={editorRef}>
            <p>Choose a new duration starting now.</p>
            <IgnoreDurationOptions currentDuration={show.duration ?? (show.expiresAt ? undefined : "forever")} onSelect={(duration) => { onChangeDuration(show.key, duration); closeEditor(show.key); }} />
            <button type="button" className="ignore-duration-cancel" onClick={() => closeEditor(show.key)}>Cancel</button>
          </div>}
        </div>
      ))}
    </section>
  );
}
