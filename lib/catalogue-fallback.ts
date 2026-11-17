import type { CatalogueUseState } from "@/lib/catalogue-selection";
import { withinCatalogueAgeLimit } from "@/lib/plex-catalogue-policy";

export type LoadedCatalogue<T> = { value: T; downloadedAt: string };

export type CatalogueChoice<T> = {
  state: Exclude<CatalogueUseState, "derived">;
  usingId?: number;
  loaded?: LoadedCatalogue<T>;
  /** Why the preferred series could not be loaded, when it could not. */
  preferredError?: unknown;
};

/**
 * Choose the catalogue compared for a provider with several Plex candidates. Any failure to load
 * the preferred series makes it unavailable; its saved catalogue is then used while it is within
 * the 60-day limit of its last successful download. Otherwise the lowest remaining candidate that
 * can supply a usable catalogue (loaded, or saved within the same limit) is the fallback.
 */
export async function chooseAvailableCatalogue<T>(input: {
  preferredId: number;
  candidates: number[];
  now: string;
  /** Load a series through the provider freshness policies; throws when it is unavailable. */
  load: (id: number, preferred: boolean) => Promise<LoadedCatalogue<T>>;
  /** A series' saved catalogue, if any, regardless of age. */
  saved: (id: number) => LoadedCatalogue<T> | undefined;
}): Promise<CatalogueChoice<T>> {
  const usableSaved = (id: number) => {
    const saved = input.saved(id);
    return saved && withinCatalogueAgeLimit(saved.downloadedAt, input.now) ? saved : undefined;
  };
  let preferredError: unknown;
  try {
    return { state: "preferred", usingId: input.preferredId, loaded: await input.load(input.preferredId, true) };
  } catch (error) {
    preferredError = error;
  }
  const saved = usableSaved(input.preferredId);
  if (saved) return { state: "saved-unavailable", usingId: input.preferredId, loaded: saved, preferredError };
  for (const id of [...new Set(input.candidates)].sort((left, right) => left - right)) {
    if (id === input.preferredId) continue;
    try {
      return { state: "fallback", usingId: id, loaded: await input.load(id, false), preferredError };
    } catch {
      const fallback = usableSaved(id);
      if (fallback) return { state: "fallback", usingId: id, loaded: fallback, preferredError };
    }
  }
  return { state: "unavailable", preferredError };
}
