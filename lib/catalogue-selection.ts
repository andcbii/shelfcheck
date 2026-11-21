export type CatalogueProvider = "tmdb" | "tvdb";
export const PROVIDERS: readonly CatalogueProvider[] = ["tmdb", "tvdb"];
export const PROVIDER_NAME: Record<CatalogueProvider, "TMDB" | "TVDB"> = { tmdb: "TMDB", tvdb: "TVDB" };
/** The field a show's series ID is kept under for each provider, in saved comparisons and Coverage Issues. */
export const PROVIDER_ID_FIELD: Record<CatalogueProvider, "tmdbId" | "tvdbId"> = { tmdb: "tmdbId", tvdb: "tvdbId" };

/** A show's catalogue-refresh and catalogue-fallback-refresh Coverage Issue IDs for one provider. */
export function catalogueIssueIds(provider: CatalogueProvider, ratingKey: string) {
  const name = PROVIDER_NAME[provider];
  return { refreshId: `catalogue-refresh:${name}:${ratingKey}`, fallbackId: `catalogue-fallback-refresh:${name}:${ratingKey}` };
}

/** Distinct series IDs in ascending numeric order. */
export function distinctSortedIds(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

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
  /** The candidates Plex affirmatively removed (`removedCandidates`). */
  removed: number[];
};

/**
 * The candidates Plex affirmatively removed: IDs in the last committed candidate set that a complete
 * observation no longer reports. An incomplete observation removes nothing, and an ID never in the
 * committed set (such as a derived series) is never removed.
 */
export function removedCandidates(input: Pick<CatalogueSelectionInput, "previous" | "observed" | "complete">): number[] {
  if (!input.complete || !input.previous) return [];
  const observed = new Set(input.observed);
  return distinctSortedIds(input.previous).filter(id => !observed.has(id));
}

/**
 * Choose one comparison catalogue for a provider: the saved override when it is still a
 * candidate, else the lowest numeric candidate. Only a complete Plex observation can replace
 * the candidate set; removing any candidate from it clears the override.
 */
export function selectComparisonCatalogue(input: CatalogueSelectionInput): CatalogueSelection {
  const observed = distinctSortedIds(input.observed);
  const previous = input.previous ? distinctSortedIds(input.previous) : undefined;
  const commit = input.complete;
  const candidates = commit ? observed : previous || observed;
  const removed = removedCandidates(input);
  const override = input.override !== undefined && !removed.length && candidates.includes(input.override) ? input.override : undefined;
  const automaticId = candidates[0];
  const preferredId = override ?? automaticId;
  return {
    candidates,
    commit,
    ...(override !== undefined ? { override } : {}),
    overrideCleared: input.override !== undefined && override === undefined,
    ...(automaticId !== undefined ? { automaticId } : {}),
    ...(preferredId !== undefined ? { preferredId } : {}),
    removed,
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
