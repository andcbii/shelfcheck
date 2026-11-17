export type CatalogueProvider = "tmdb" | "tvdb";

export type CatalogueSelectionInput = {
  /** The last committed (completely observed) candidate set, if any. */
  previous?: number[];
  /** Distinct IDs seen in this scan's Plex metadata for the show's group. */
  observed: number[];
  /** Whether every record in the group returned usable metadata, so `observed` can replace `previous`. */
  complete: boolean;
  /** The saved catalogue override, if any. */
  override?: number;
};

export type CatalogueSelection = {
  /** Candidates this scan selects from. */
  candidates: number[];
  /** Whether `candidates` should replace the last observed set. */
  commit: boolean;
  /** The override that remains saved after reconciliation. */
  override?: number;
  /** A completed observation removed a candidate, which clears the override. */
  overrideCleared: boolean;
  automaticId?: number;
  /** The override when saved, else the automatic choice. */
  preferredId?: number;
};

const sorted = (ids: number[]) => [...new Set(ids)].sort((left, right) => left - right);

/**
 * Choose one comparison catalogue for a provider: the saved override when it is still a
 * candidate, else the lowest numeric candidate. Only a complete Plex observation can replace
 * the candidate set; removing any candidate from it clears the override.
 */
export function selectComparisonCatalogue(input: CatalogueSelectionInput): CatalogueSelection {
  const observed = sorted(input.observed);
  const previous = input.previous ? sorted(input.previous) : undefined;
  const commit = input.complete;
  const candidates = commit ? observed : previous || observed;
  const removed = commit && !!previous?.some(id => !observed.includes(id));
  const override = input.override !== undefined && !removed && candidates.includes(input.override) ? input.override : undefined;
  const automaticId = candidates[0];
  const preferredId = override ?? automaticId;
  return {
    candidates,
    commit,
    ...(override !== undefined ? { override } : {}),
    overrideCleared: input.override !== undefined && override === undefined,
    ...(automaticId !== undefined ? { automaticId } : {}),
    ...(preferredId !== undefined ? { preferredId } : {}),
  };
}
