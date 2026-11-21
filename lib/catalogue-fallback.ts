import { distinctSortedIds, type CatalogueUseState } from "@/lib/catalogue-selection";
import type { CatalogueUse } from "@/lib/catalogue-selection-store";
import { catalogueUsableUntil, withinCatalogueAgeLimit } from "@/lib/plex-catalogue-policy";

type LoadedCatalogue<T> = { value: T; downloadedAt: string };

export type CatalogueChoice<T> = {
  state: Exclude<CatalogueUseState, "derived">;
  usingId?: number;
  loaded?: LoadedCatalogue<T>;
  /** Why the preferred series could not be loaded, when it could not. */
  preferredError?: unknown;
  /** Why the fallback in use could not be loaded, when its saved catalogue is compared instead. */
  fallbackError?: unknown;
  /** Every candidate whose load failed, in the order tried; candidates not tried are absent. */
  failures: { id: number; error: unknown }[];
  /** Unavailable because every candidate is a Gone provider record. */
  gone?: true;
};

/**
 * Choose the catalogue compared for a provider with several Plex candidates. Any failure to load
 * the preferred series makes it unavailable; its saved catalogue is then used while it is within
 * the 60-day limit of its last successful download. Otherwise the lowest remaining candidate that
 * can supply a usable catalogue (loaded, or saved within the same limit) is the fallback; when it
 * is its saved catalogue, the fallback's own load failure is kept too. Only when no candidate
 * qualifies is the most recently saved catalogue that is not a Gone provider record compared, at
 * any age (ADR-0006); with none, the provider is gone only when every candidate is gone.
 */
export async function chooseAvailableCatalogue<T>(input: {
  preferredId: number;
  candidates: number[];
  now: string;
  /** Load a series through the provider freshness policies; throws when it is unavailable. */
  load: (id: number) => Promise<LoadedCatalogue<T>>;
  /** A series' saved catalogue, if any, regardless of age. */
  saved: (id: number) => LoadedCatalogue<T> | undefined;
  /** Whether a series is a Gone provider record, whose saved catalogue is never compared. */
  gone: (id: number) => boolean;
}): Promise<CatalogueChoice<T>> {
  const usableSaved = (id: number) => {
    const saved = input.saved(id);
    return saved && withinCatalogueAgeLimit(saved.downloadedAt, input.now) ? saved : undefined;
  };
  let preferredError: unknown;
  const failures: CatalogueChoice<T>["failures"] = [];
  try {
    return { state: "preferred", usingId: input.preferredId, loaded: await input.load(input.preferredId), failures };
  } catch (error) {
    preferredError = error;
    failures.push({ id: input.preferredId, error });
  }
  const saved = usableSaved(input.preferredId);
  if (saved) return { state: "saved-unavailable", usingId: input.preferredId, loaded: saved, preferredError, failures };
  for (const id of distinctSortedIds(input.candidates)) {
    if (id === input.preferredId) continue;
    try {
      return { state: "fallback", usingId: id, loaded: await input.load(id), preferredError, failures };
    } catch (fallbackError) {
      failures.push({ id, error: fallbackError });
      const fallback = usableSaved(id);
      if (fallback) return { state: "fallback", usingId: id, loaded: fallback, preferredError, fallbackError, failures };
    }
  }
  const candidates = distinctSortedIds(input.candidates);
  const lastResort = newestSavedNotGone(candidates, id => input.saved(id)?.downloadedAt, input.gone);
  if (lastResort !== undefined) {
    const loaded = input.saved(lastResort)!;
    if (lastResort === input.preferredId) return { state: "saved-unavailable", usingId: lastResort, loaded, preferredError, failures };
    const fallbackError = failures.find(failure => failure.id === lastResort)?.error;
    return { state: "fallback", usingId: lastResort, loaded, preferredError, fallbackError, failures };
  }
  return { state: "unavailable", preferredError, failures, ...(candidates.every(input.gone) ? { gone: true as const } : {}) };
}

/** The last resort: the candidate with the most recently saved catalogue that is not gone, at any age; the lowest ID on a tie. */
function newestSavedNotGone(candidates: number[], downloadedAt: (id: number) => string | undefined, gone: (id: number) => boolean): number | undefined {
  let newest: { id: number; at: number } | undefined;
  for (const id of candidates) {
    const at = Date.parse(downloadedAt(id) || "");
    if (Number.isFinite(at) && !gone(id) && (!newest || at > newest.at)) newest = { id, at };
  }
  return newest?.id;
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

/** The catalogue in use for a provider with one Plex ID. */
export function singleIdUse(usingId: number, downloadedAt: string | undefined): CatalogueUse {
  return { preferredId: usingId, usingId, state: "preferred", ...(downloadedAt ? { preferredDownloadedAt: downloadedAt, usingDownloadedAt: downloadedAt } : {}) };
}

/** A single-ID provider whose series failed to load: its saved catalogue, at any age, stays in use (ADR-0003). */
export function failedSingleIdUse(preferredId: number, savedDownloadedAt: string | undefined, failedAt: string): CatalogueUse {
  return { preferredId, ...(savedDownloadedAt ? { usingId: preferredId, preferredDownloadedAt: savedDownloadedAt, usingDownloadedAt: savedDownloadedAt } : {}), state: savedDownloadedAt ? "saved-unavailable" : "unavailable", preferredFailedAt: failedAt };
}

/**
 * The offline counterpart of `chooseAvailableCatalogue` for a cached recheck, which loads nothing.
 * The preferred series is compared when its saved catalogue is within 60 days of `now`. Once a scan
 * has tried this preference (`tried`), the lowest remaining candidate with such a catalogue is the
 * fallback, and with none, the most recently saved catalogue that is not gone, at any age; a
 * preference no scan has tried yet is never replaced by a fallback.
 */
export function chooseSavedCatalogue(input: { preferredId: number; candidates: number[]; now: string; tried: boolean; downloadedAt: (id: number) => string | undefined; gone: (id: number) => boolean }): number | undefined {
  const usable = (id: number) => withinCatalogueAgeLimit(input.downloadedAt(id), input.now);
  if (usable(input.preferredId)) return input.preferredId;
  if (!input.tried) return undefined;
  const candidates = distinctSortedIds(input.candidates);
  return candidates.find(id => id !== input.preferredId && usable(id)) ?? newestSavedNotGone(candidates, input.downloadedAt, input.gone);
}

/**
 * The catalogue use an offline recheck publishes for a provider with several Plex IDs. It keeps the
 * failure provenance already recorded and renews no time: download times are the saved catalogues'.
 */
export function savedCatalogueUse(input: { preferredId: number; usingId: number; preferredDownloadedAt?: string; usingDownloadedAt: string; preferredFailedAt?: string; usingFailedAt?: string }): CatalogueUse {
  const preferred = input.usingId === input.preferredId;
  return {
    preferredId: input.preferredId, usingId: input.usingId,
    state: preferred ? (input.preferredFailedAt ? "saved-unavailable" : "preferred") : "fallback",
    ...(input.preferredDownloadedAt ? { preferredDownloadedAt: input.preferredDownloadedAt, preferredUsableUntil: catalogueUsableUntil(input.preferredDownloadedAt) } : {}),
    ...(input.preferredFailedAt ? { preferredFailedAt: input.preferredFailedAt } : {}),
    usingDownloadedAt: input.usingDownloadedAt,
    ...(!preferred && input.usingFailedAt ? { usingFailedAt: input.usingFailedAt } : {}),
  };
}
