"use client";

type SeasonOption = { number: number; issueCount: number };

type Props = {
  showTitle: string;
  seasons: SeasonOption[];
  selected: number[];
  onChange: (seasons: number[]) => void;
  onClose: () => void;
  onSave: () => void;
};

export function SeasonIgnoreModal({ showTitle, seasons, selected, onChange, onClose, onSave }: Props) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
    <section className="modal season-ignore-modal" role="dialog" aria-modal="true" aria-labelledby="season-ignore-title">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <p className="eyebrow">IGNORE SEASONS</p><h2 id="season-ignore-title">{showTitle}</h2>
      <p className="modal-copy">Choose seasons whose missing-episode issues should be hidden. This does not change the provider or the saved scan cache.</p>
      <div className="season-ignore-list">{seasons.map((season) => <label key={season.number}><input type="checkbox" checked={selected.includes(season.number)} onChange={(event) => onChange(event.target.checked ? [...new Set([...selected, season.number])] : selected.filter((item) => item !== season.number))} /><span>Season {String(season.number).padStart(2, "0")}</span><small>{season.issueCount} issues</small></label>)}</div>
      <div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={onSave}>Save seasons<b>→</b></button></div>
    </section>
  </div>;
}
