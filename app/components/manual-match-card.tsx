"use client";
import { ManualMatchPanels } from "@/app/components/manual-match-panels";
import type { CoverageMapping } from "@/lib/manual-coverage-model";

export type MatchHealth = NonNullable<CoverageMapping["health"]>;
// The health a Manual Match list is filtered to, or "all" for no filter.
export type HealthFilter = MatchHealth | "all";
// The one label for each health, in the order the health filter offers them.
export const MATCH_HEALTH_LABELS: Record<MatchHealth, string> = { healthy: "Healthy", "needs-review": "Needs review", pending: "Pending" };
// A Manual Match without a health yet counts as healthy.
export const healthOf = (match: CoverageMapping): MatchHealth => match.health || "healthy";
export const matchesHealthFilter = (match: CoverageMapping, filter: HealthFilter) => filter === "all" || healthOf(match) === filter;

type Props = {
  match: CoverageMapping;
  locked: boolean;
  // Just saved: the header row briefly says so.
  saved?: boolean;
  // Present when the card can be ticked for bulk actions.
  selection?: { selected: boolean; onChange: (selected: boolean) => void };
  onEdit: () => void;
  onDelete: () => void;
};

// A compact card: a header row (select, health, a brief Saved note, Edit, Delete), the health
// message on its own line when there is one, then the TMDB and TVDB columns.
export function ManualMatchCard({ match, locked, saved = false, selection, onEdit, onDelete }: Props) {
  const health = healthOf(match);
  return <article className="manual-match-card">
    <header>
      {selection && <input type="checkbox" aria-label={`Select Manual Match ${match.id}`} disabled={locked} checked={selection.selected} onChange={event => selection.onChange(event.target.checked)}/>}
      <span className={`manual-match-health ${health}`}>{MATCH_HEALTH_LABELS[health]}</span>
      <span className="manual-match-card-spacer"/>
      {saved && <span className="manual-match-saved" role="status"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Saved</span>}
      <button disabled={locked} onClick={onEdit}>Edit</button>
      <button className="manual-match-delete" disabled={locked} onClick={onDelete}>Delete</button>
    </header>
    {match.healthMessage && <p className="manual-match-health-message">{match.healthMessage}</p>}
    <ManualMatchPanels members={match.members} idPrefix={match.id}/>
  </article>;
}
