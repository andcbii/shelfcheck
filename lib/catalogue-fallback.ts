import { distinctSortedIds, type CatalogueUseState } from "@/lib/catalogue-selection";
import type { CatalogueUse } from "@/lib/catalogue-selection-store";
import { catalogueUsableUntil, withinCatalogueAgeLimit } from "@/lib/plex-catalogue-policy";

export type LoadedCatalogue<T> = { value: T; downloadedAt: string };

export type CatalogueChoice<T> = {
  state: Exclude<CatalogueUseState, "derived">;
  usingId?: number;
  loaded?: LoadedCatalogue<T>;
  /** Why the preferred series could not be loaded, when it could not. */
  preferredError?: unknown;
  /** Why the fallback in use could not be loaded, when its saved catalogue is compared instead. */
  fallbackError?: unknown;
};

/**
 * Choose the catalogue compared for a provider with several Plex candidates. Any failure to load
 * the preferred series makes it unavailable; its saved catalogue is then used while it is within
 * the 60-day limit of its last successful download. Otherwise the lowest remaining candidate that
 * can supply a usable catalogue (loaded, or saved within the same limit) is the fallback; when it
 * is its saved catalogue, the fallback's own load failure is kept too.
 */
export async function chooseAvailableCatalogue<T>(input: {
  preferredId: number;
  candidates: number[];
  now: string;
  /** Load a series through the provider freshness policies; throws when it is unavailable. */
  load: (id: number) => Promise<LoadedCatalogue<T>>;
  /** A series' saved catalogue, if any, regardless of age. */
  saved: (id: number) => LoadedCatalogue<T> | undefined;
}): Promise<CatalogueChoice<T>> {
  const usableSaved = (id: number) => {
    const saved = input.saved(id);
    return saved && withinCatalogueAgeLimit(saved.downloadedAt, input.now) ? saved : undefined;
  };
  let preferredError: unknown;
  try {
    return { state: "preferred", usingId: input.preferredId, loaded: await input.load(input.preferredId) };
  } catch (error) {
    preferredError = error;
  }
  const saved = usableSaved(input.preferredId);
  if (saved) return { state: "saved-unavailable", usingId: input.preferredId, loaded: saved, preferredError };
  for (const id of distinctSortedIds(input.candidates)) {
    if (id === input.preferredId) continue;
    try {
      return { state: "fallback", usingId: id, loaded: await input.load(id), preferredError };
    } catch (fallbackError) {
      const fallback = usableSaved(id);
      if (fallback) return { state: "fallback", usingId: id, loaded: fallback, preferredError, fallbackError };
    }
  }
  return { state: "unavailable", preferredError };
}

/** The catalogue a provider with several Plex IDs is using, with the preferred series' 60-day deadline. */
export function multipleIdUse<T>(choice: CatalogueChoice<T>, preferredId: number, preferredDownloadedAt: string | undefined, now: string): CatalogueUse {
  return {
    preferredId, ...(choice.usingId ? { usingId: choice.usingId } : {}), state: choice.state,
    ...(preferredDownloadedAt ? { preferredDownloadedAt, preferredUsableUntil: catalogueUsableUntil(preferredDownloadedAt) } : {}),
    ...(choice.preferredError ? { preferredFailedAt: now } : {}),
    ...(choice.loaded ? { usingDownloadedAt: choice.loaded.downloadedAt } : {}),
    ...(choice.fallbackError ? { usingFailedAt: now } : {}),
  };
}

/** The catalogue in use for a provider with one Plex ID (`reported`), or a series derived from the other provider's catalogue. */
export function singleIdUse(usingId: number, reported: boolean, derivedFrom: number | undefined, downloadedAt: string | undefined): CatalogueUse {
  return reported
    ? { preferredId: usingId, usingId, state: "preferred", ...(downloadedAt ? { preferredDownloadedAt: downloadedAt, usingDownloadedAt: downloadedAt } : {}) }
    : { usingId, state: "derived", ...(derivedFrom ? { derivedFrom } : {}), ...(downloadedAt ? { usingDownloadedAt: downloadedAt } : {}) };
}

/** A single-ID provider whose series failed to load: its saved catalogue, at any age, stays in use (ADR-0003). */
export function failedSingleIdUse(preferredId: number, savedDownloadedAt: string | undefined, failedAt: string): CatalogueUse {
  return { preferredId, ...(savedDownloadedAt ? { usingId: preferredId, preferredDownloadedAt: savedDownloadedAt, usingDownloadedAt: savedDownloadedAt } : {}), state: savedDownloadedAt ? "saved-unavailable" : "unavailable", preferredFailedAt: failedAt };
}
