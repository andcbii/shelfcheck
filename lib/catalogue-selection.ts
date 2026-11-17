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

/**
 * How a scan is using a provider's comparison catalogue:
 * - `preferred`: the preferred series (override or automatic choice) loaded or was reused under the freshness policies.
 * - `saved-unavailable`: the preferred series could not be loaded; its saved catalogue, within the 60-day limit, is compared.
 * - `fallback`: the preferred series could not be loaded and has no usable saved catalogue; another Plex candidate is compared.
 * - `unavailable`: no candidate could supply a usable catalogue; last-good results are kept.
 * - `derived`: Plex reported no ID for this provider; the series came from the other provider's catalogue in use.
 */
export type CatalogueUseState = "preferred" | "saved-unavailable" | "fallback" | "unavailable" | "derived";
