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

/**
 * A catalogue a scan tries for a provider, and whether it is the preferred catalogue. It is named by
 * the series ID requested (`id`, when known) and by the ID the catalogue itself reports
 * (`reportedId`: its saved copy's before a load, its download's after), which a provider can answer
 * differently. A specific requirement names the reported ID of the catalogue compared, so either
 * name matches it.
 */
export type AttemptedCatalogue = { id?: number; reportedId?: number; preferred: boolean };

/** The IDs that name an attempted catalogue. */
const namesOf = (attempt: AttemptedCatalogue) => [attempt.id, attempt.reportedId].filter((id): id is number => id !== undefined);

/**
 * Every provider's refresh obligation as a saved comparison stores it. The per-provider flag is the
 * preferred requirement; obligations saved before requirements existed therefore read as
 * preferred-only. The other parts sit beside it, keyed by provider, and are absent when empty.
 *
 * `requestedIds` is evidence, not a requirement: for a specific requirement naming the ID a catalogue
 * reported, the Plex candidate requested for it (reported ID to requested ID), so removing that
 * candidate drops the requirement even after comparison moved away. It is kept only beside its
 * requirement; a requirement saved without it is matched by its own ID alone.
 */
export type SavedRefreshObligations = {
  tmdb?: boolean; tvdb?: boolean;
  specificIds?: Partial<Record<CatalogueProvider, number[]>>;
  everyAttempted?: Partial<Record<CatalogueProvider, true>>;
  requestedIds?: Partial<Record<CatalogueProvider, Record<string, number>>>;
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
const obligationOpen = (obligation: RefreshObligation) => Object.keys(normalized(obligation)).length > 0;

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
 * requirement forces every catalogue, the preferred requirement only the preferred catalogue, and a
 * specific requirement only the catalogue it names. A specific requirement for a catalogue not
 * attempted is on hold: it forces nothing. Otherwise the source's reuse policy decides.
 */
export function requiresDownload(obligation: RefreshObligation, attempt: AttemptedCatalogue): boolean {
  return !!obligation.everyAttempted || !!obligation.preferred && attempt.preferred || namesOf(attempt).some(id => !!obligation.specificIds?.includes(id));
}

/**
 * The requirements a complete successful download of a catalogue satisfies: the specific requirement
 * for the catalogue it names (requested or reported ID), and the preferred and every-attempted requirements when it is the preferred catalogue
 * (a fallback download satisfies neither). Reuse, title-only repair, failed and incomplete loads
 * satisfy nothing, so the caller asks only for a download.
 */
export function satisfiedByDownload(attempt: AttemptedCatalogue): RefreshObligationPatch {
  const ids = namesOf(attempt);
  const remove: RefreshObligation = { ...(attempt.preferred ? { preferred: true, everyAttempted: true } : {}), ...(ids.length ? { specificIds: [...new Set(ids)] } : {}) };
  return Object.keys(remove).length ? { remove } : {};
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
 * part and the other provider unchanged. Requested-candidate evidence goes with its specific requirement.
 */
export function patchSavedObligation(saved: SavedRefreshObligations, provider: CatalogueProvider, patch: RefreshObligationPatch): void {
  const next = applyObligationPatch(savedObligation(saved, provider), patch);
  if (next.preferred) saved[provider] = true; else delete saved[provider];
  const requested = Object.entries(saved.requestedIds?.[provider] ?? {}).filter(([reportedId]) => next.specificIds?.includes(Number(reportedId)));
  setProviderEntry(saved, provider, "specificIds", next.specificIds && [...next.specificIds]);
  setProviderEntry(saved, provider, "everyAttempted", next.everyAttempted);
  setProviderEntry(saved, provider, "requestedIds", requested.length ? Object.fromEntries(requested) : undefined);
}

/**
 * Copy one provider's stored obligation, its requested-candidate evidence included, from `from` into
 * `to`, in place, leaving the other provider's unchanged.
 */
export function copySavedObligation(to: SavedRefreshObligations, from: SavedRefreshObligations | undefined, provider: CatalogueProvider): void {
  if (from?.[provider]) to[provider] = true; else delete to[provider];
  const specificIds = from?.specificIds?.[provider], requestedIds = from?.requestedIds?.[provider];
  setProviderEntry(to, provider, "specificIds", specificIds && [...specificIds]);
  setProviderEntry(to, provider, "everyAttempted", from?.everyAttempted?.[provider]);
  setProviderEntry(to, provider, "requestedIds", requestedIds && { ...requestedIds });
}

/** Sets or removes one provider's entry under a per-provider key, removing the key once empty. */
function setProviderEntry<K extends "specificIds" | "everyAttempted" | "requestedIds">(saved: SavedRefreshObligations, provider: CatalogueProvider, key: K, value: NonNullable<SavedRefreshObligations[K]>[CatalogueProvider] | undefined) {
  const entries: Partial<Record<CatalogueProvider, unknown>> = { ...saved[key] };
  if (value === undefined) delete entries[provider]; else entries[provider] = value;
  if (Object.keys(entries).length) saved[key] = entries as SavedRefreshObligations[K]; else delete saved[key];
}

/**
 * Record, in place, that a held specific requirement names the ID reported for the Plex candidate
 * requested (`requestedId`). Nothing is recorded when the two IDs agree or the requirement is not held.
 */
export function recordRequestedCandidate(saved: SavedRefreshObligations, provider: CatalogueProvider, reportedId: number, requestedId: number): void {
  if (reportedId === requestedId || !savedObligation(saved, provider).specificIds?.includes(reportedId)) return;
  setProviderEntry(saved, provider, "requestedIds", { ...saved.requestedIds?.[provider], [reportedId]: requestedId });
}

/**
 * The specific requirement IDs a complete observation's removal of Plex candidates drops: each removed
 * candidate, and each ID reported for a removed candidate, unless that ID is still a candidate.
 */
export function droppedByRemoval(saved: SavedRefreshObligations | undefined, provider: CatalogueProvider, removed: readonly number[], candidates: readonly number[]): number[] {
  const reported = Object.entries(saved?.requestedIds?.[provider] ?? {})
    .filter(([reportedId, requestedId]) => removed.includes(requestedId) && !candidates.includes(Number(reportedId)))
    .map(([reportedId]) => Number(reportedId));
  return [...removed, ...reported];
}
