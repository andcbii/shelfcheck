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

export function ManualMatchCard({ match, locked, selection, onEdit, onDelete }: Props) {
  return <article className="provider-match-row">{selection && <label><input type="checkbox" aria-label={`Select mapping ${match.id}`} disabled={locked} checked={selection.selected} onChange={event => selection.onChange(event.target.checked)}/>Select mapping</label>}<p><strong>{MATCH_HEALTH_LABELS[match.health || "healthy"]}</strong>{match.healthMessage && <> · {match.healthMessage}</>}</p><ManualMatchPanels members={match.members} idPrefix={match.id}/><button disabled={locked} onClick={onEdit}>Edit mapping</button><details><summary>Coverage evidence</summary><p>Mapping {match.id} · Revision {match.revision}</p>{match.evidence?.length ? match.evidence.map(item => <p key={`${match.id}:${item.showKey}:${item.ratingKey}`}>Plex item {item.ratingKey} · {item.showKey} · Provider identities: {item.identities.map(i=>`${i.provider} ${i.id}`).join(", ")}</p>) : <p>No directly owned source items in the latest inventory.</p>}</details><button disabled={locked} onClick={onDelete}>Delete mapping</button></article>;
}
