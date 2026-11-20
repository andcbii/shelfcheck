import type { CatalogueProvider } from "@/lib/catalogue-selection";

/**
 * A show's refresh obligation for one provider (GLOSSARY: Refresh obligation): the catalogue
 * downloads it requires, as requirements that coexist and merge by union. Each part is neutral when
 * absent, so an empty object requires nothing.
 *
 * - `preferred`: the preferred catalogue must be downloaded. Raised by a failed preferred catalogue,
 *   a Manual Match change and a catalogue override change.
 * - `specificIds`: these catalogues must be downloaded when compared. Raised by the fifth-scan safeguard.
 * - `everyAttempted`: every catalogue the next scan tries must be downloaded. Raised by a single-show Clear cache.
 */
export type RefreshObligation = { preferred?: true; specificIds?: readonly number[]; everyAttempted?: true };

/** A provider-scoped change to a refresh obligation: parts to add, then parts to remove. Empty changes nothing. */
export type RefreshObligationPatch = { add?: RefreshObligation; remove?: RefreshObligation };

/** Adds the preferred requirement: what a failed preferred catalogue, a Manual Match change and a catalogue override change write. */
export const PREFERRED_REQUIRED: RefreshObligationPatch = { add: { preferred: true } };

/** Adds the every-attempted requirement: what a single-show Clear cache writes. */
export const EVERY_ATTEMPTED_REQUIRED: RefreshObligationPatch = { add: { everyAttempted: true } };

/** A catalogue a scan tries for a provider: its series ID, if known, and whether it is the preferred catalogue. */
export type AttemptedCatalogue = { id?: number; preferred: boolean };

/**
 * Every provider's refresh obligation as a saved comparison stores it. The per-provider flag is the
 * preferred requirement; obligations saved before requirements existed therefore read as
 * preferred-only. The other parts sit beside it, keyed by provider, and are absent when empty.
 */
export type SavedRefreshObligations = {
  tmdb?: boolean; tvdb?: boolean;
  specificIds?: Partial<Record<CatalogueProvider, number[]>>;
  everyAttempted?: Partial<Record<CatalogueProvider, true>>;
};

/** Positive integer IDs, de-duplicated and sorted. */
function validIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

/** The obligation with empty parts left out. */
function normalized(obligation: RefreshObligation): RefreshObligation {
  const specificIds = validIds(obligation.specificIds);
  return {
    ...(obligation.preferred ? { preferred: true } : {}),
    ...(specificIds.length ? { specificIds } : {}),
    ...(obligation.everyAttempted ? { everyAttempted: true } : {}),
  };
}

/** Whether the obligation requires anything. */
export const obligationOpen = (obligation: RefreshObligation) => Object.keys(normalized(obligation)).length > 0;

/** Every requirement of both obligations. */
export function unionObligations(a: RefreshObligation, b: RefreshObligation): RefreshObligation {
  return normalized({
    preferred: a.preferred || b.preferred || undefined,
    specificIds: [...(a.specificIds ?? []), ...(b.specificIds ?? [])],
    everyAttempted: a.everyAttempted || b.everyAttempted || undefined,
  });
}

/** The obligation after a patch: its added parts merged in, then its removed parts taken out. Other parts are kept. */
export function applyObligationPatch(obligation: RefreshObligation, patch: RefreshObligationPatch): RefreshObligation {
  const merged = unionObligations(obligation, patch.add ?? {});
  const remove = patch.remove ?? {};
  const removedIds = new Set(remove.specificIds ?? []);
  return normalized({
    preferred: remove.preferred ? undefined : merged.preferred,
    specificIds: merged.specificIds?.filter(id => !removedIds.has(id)),
    everyAttempted: remove.everyAttempted ? undefined : merged.everyAttempted,
  });
}

/** The part of a patch that changes this obligation: parts it lacks to add, parts it holds to remove. */
export function effectivePatch(obligation: RefreshObligation, patch: RefreshObligationPatch): RefreshObligationPatch {
  const current = normalized(obligation);
  const held = new Set(current.specificIds ?? []);
  const add = normalized({
    preferred: patch.add?.preferred && !current.preferred || undefined,
    specificIds: patch.add?.specificIds?.filter(id => !held.has(id)),
    everyAttempted: patch.add?.everyAttempted && !current.everyAttempted || undefined,
  });
  const remove = normalized({
    preferred: patch.remove?.preferred && current.preferred,
    specificIds: patch.remove?.specificIds?.filter(id => held.has(id)),
    everyAttempted: patch.remove?.everyAttempted && current.everyAttempted,
  });
  return { ...(obligationOpen(add) ? { add } : {}), ...(obligationOpen(remove) ? { remove } : {}) };
}

/** One patch doing both: their added parts, then their removed parts. */
export function combinePatches(a: RefreshObligationPatch, b: RefreshObligationPatch): RefreshObligationPatch {
  return { add: unionObligations(a.add ?? {}, b.add ?? {}), remove: unionObligations(a.remove ?? {}, b.remove ?? {}) };
}

/**
 * Whether an attempted catalogue must be downloaded rather than reused: the every-attempted
 * requirement forces every catalogue, the preferred requirement only the preferred catalogue.
 * Otherwise the source's reuse policy decides.
 */
export function requiresDownload(obligation: RefreshObligation, attempt: AttemptedCatalogue): boolean {
  return !!obligation.everyAttempted || !!obligation.preferred && attempt.preferred;
}

/**
 * The requirements a complete successful download of a catalogue satisfies: the preferred and
 * every-attempted requirements, by the preferred catalogue (a fallback download satisfies neither).
 * Reuse, failed and incomplete loads satisfy nothing, so the caller asks only for a download.
 */
export function satisfiedByDownload(attempt: AttemptedCatalogue): RefreshObligationPatch {
  return attempt.preferred ? { remove: { preferred: true, everyAttempted: true } } : {};
}

/** A provider's refresh obligation from a saved comparison's stored value. */
export function savedObligation(saved: SavedRefreshObligations | undefined, provider: CatalogueProvider): RefreshObligation {
  return normalized({
    preferred: saved?.[provider] ? true : undefined,
    specificIds: saved?.specificIds?.[provider],
    everyAttempted: saved?.everyAttempted?.[provider],
  });
}

/**
 * Patch one provider's obligation in a saved comparison's stored value, in place, leaving every other
 * part and the other provider unchanged. Returns the same object.
 */
export function patchSavedObligation(saved: SavedRefreshObligations, provider: CatalogueProvider, patch: RefreshObligationPatch): SavedRefreshObligations {
  const next = applyObligationPatch(savedObligation(saved, provider), patch);
  if (next.preferred) saved[provider] = true; else delete saved[provider];
  const part = <K extends "specificIds" | "everyAttempted">(key: K, value: NonNullable<SavedRefreshObligations[K]>[CatalogueProvider] | undefined) => {
    const parts: Partial<Record<CatalogueProvider, unknown>> = { ...saved[key] };
    if (value === undefined) delete parts[provider]; else parts[provider] = value;
    if (Object.keys(parts).length) saved[key] = parts as SavedRefreshObligations[K]; else delete saved[key];
  };
  part("specificIds", next.specificIds && [...next.specificIds]);
  part("everyAttempted", next.everyAttempted);
  return saved;
}
