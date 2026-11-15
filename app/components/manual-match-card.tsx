"use client";
import { ManualMatchPanels } from "@/app/components/manual-match-panels";
import type { CoverageMapping } from "@/lib/manual-coverage-model";

export type MatchHealth = NonNullable<CoverageMapping["health"]>;
// The health a Manual Match list is filtered to, or "all" for no filter.
export type HealthFilter = MatchHealth | "all";
// The one label for each health, in the order the health filter offers them.
export const MATCH_HEALTH_LABELS: Record<MatchHealth, string> = { healthy: "Healthy", "needs-review": "Needs review", pending: "Pending" };
// A Manual Match without a health yet counts as healthy.
export const matchesHealthFilter = (match: CoverageMapping, filter: HealthFilter) => filter === "all" || (match.health || "healthy") === filter;

type Props = {
  match: CoverageMapping;
  locked: boolean;
  // Present when the card can be ticked for bulk actions.
  selection?: { selected: boolean; onChange: (selected: boolean) => void };
  onEdit: () => void;
  onDelete: () => void;
};

// A compact card: a header row (select, health, room for a note, Edit, Delete), the health
// message on its own line when there is one, then the TMDB and TVDB columns.
export function ManualMatchCard({ match, locked, selection, onEdit, onDelete }: Props) {
  const health = match.health || "healthy";
  return <article className="manual-match-card">
    <header>
      {selection && <input type="checkbox" aria-label={`Select mapping ${match.id}`} disabled={locked} checked={selection.selected} onChange={event => selection.onChange(event.target.checked)}/>}
      <span className={`manual-match-health ${health}`}>{MATCH_HEALTH_LABELS[health]}</span>
      <span className="manual-match-card-spacer"/>
      <button disabled={locked} onClick={onEdit}>Edit</button>
      <button className="danger" disabled={locked} onClick={onDelete}>Delete</button>
    </header>
    {match.healthMessage && <p className="manual-match-health-message">{match.healthMessage}</p>}
    <ManualMatchPanels members={match.members} idPrefix={match.id}/>
  </article>;
}
