"use client";

type IgnoredItem = { key: string | number; title: string; detail?: string };

type Props = {
  items: IgnoredItem[];
  onClose: () => void;
  onRestore: (key: string | number) => void;
  showCount?: boolean;
};

export function IgnoredShowsManager({ items, onClose, onRestore, showCount = false }: Props) {
  return (
    <section className="ignored-manager" aria-label="Ignored shows" data-menu-root="ignored">
      <div>
        <h3>Ignored shows{showCount ? ` (${items.length})` : ""}</h3>
        <button type="button" onClick={onClose} aria-label="Close ignored shows">×</button>
      </div>
      {items.length === 0 ? <p>No shows are ignored.</p> : items.map((show) => (
        <div className="ignored-row" key={show.key}>
          <span>{show.title}{show.detail && <small>{show.detail}</small>}</span>
          <button type="button" onClick={() => onRestore(show.key)}>Restore</button>
        </div>
      ))}
    </section>
  );
}
