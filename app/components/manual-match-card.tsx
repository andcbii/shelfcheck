"use client";
import { ManualMatchPanels } from "@/app/components/manual-match-panels";
import type { CoverageMapping } from "@/lib/manual-coverage-model";

type Props = {
  mapping: CoverageMapping;
  locked: boolean;
  // Present when the card can be ticked for bulk actions.
  selection?: { selected: boolean; onChange: (selected: boolean) => void };
  onEdit: () => void;
  onDelete: () => void;
};

export function ManualMatchCard({ mapping, locked, selection, onEdit, onDelete }: Props) {
  return <article className="provider-match-row">{selection && <label><input type="checkbox" aria-label={`Select mapping ${mapping.id}`} disabled={locked} checked={selection.selected} onChange={event => selection.onChange(event.target.checked)}/>Select mapping</label>}<p><strong>{mapping.health === "needs-review" ? "Needs review" : mapping.health === "pending" ? "Pending" : "Healthy"}</strong>{mapping.healthMessage && <> · {mapping.healthMessage}</>}</p><ManualMatchPanels members={mapping.members} scope={mapping.id}/><button disabled={locked} onClick={onEdit}>Edit mapping</button><details><summary>Coverage evidence</summary><p>Mapping {mapping.id} · Revision {mapping.revision}</p>{mapping.evidence?.length ? mapping.evidence.map(item => <p key={`${mapping.id}:${item.showKey}:${item.ratingKey}`}>Plex item {item.ratingKey} · {item.showKey} · Provider identities: {item.identities.map(i=>`${i.provider} ${i.id}`).join(", ")}</p>) : <p>No directly owned source items in the latest inventory.</p>}</details><button disabled={locked} onClick={onDelete}>Delete mapping</button></article>;
}
