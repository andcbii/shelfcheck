import { PROVIDER_NAME, type CatalogueProvider } from "@/lib/catalogue-selection";
import type { CatalogueUse, ProviderCatalogueSelection } from "@/lib/catalogue-selection-store";

/** The calendar day of an ISO time, as shown with catalogue download times and deadlines. */
export const formatDay = (value?: string) => value?.slice(0, 10) || "unknown";

/** Whether Plex reports more than one distinct series for the provider. */
export const hasMultipleCandidates = (selection: Pick<ProviderCatalogueSelection, "candidates">) => new Set(selection.candidates.map(candidate => candidate.id)).size > 1;

/** A candidate series by its saved name and ID, else `prefix` and its ID. */
export function seriesLabel(selection: Pick<ProviderCatalogueSelection, "candidates">, id: number, prefix = "") {
  const name = selection.candidates.find(candidate => candidate.id === id)?.name;
  return name ? `${name} (${id})` : `${prefix}${id}`;
}

/** How a provider's persisted selection stands, classified once for every description of it. */
export type CatalogueStatus =
  | { kind: "not-compared"; preferredId?: number }
  | { kind: "unavailable"; preferredId?: number }
  /** The preference changed after the last comparison, which still used `usingId`. */
  | { kind: "pending"; preferredId: number; usingId: number }
  | { kind: "fallback" | "saved-unavailable" | "derived" | "preferred"; preferredId?: number; usingId: number };

export function catalogueStatus(selection: ProviderCatalogueSelection): CatalogueStatus {
  const current = selection.current;
  if (!current) return { kind: "not-compared", preferredId: selection.preferredId };
  const usingId = current.usingId;
  // The saved selection is the preference; `current` only records what the last scan used or failed to load.
  if (current.state === "unavailable" || usingId === undefined) return { kind: "unavailable", preferredId: selection.preferredId ?? current.preferredId };
  if (selection.preferredId !== undefined && current.state !== "derived" && current.preferredId !== selection.preferredId)
    return { kind: "pending", preferredId: selection.preferredId, usingId };
  return { kind: current.state, preferredId: current.preferredId, usingId };
}

/**
 * Why a provider is comparing the catalogue it uses, when that needs explaining: an unavailable
 * preferred series, a fallback, or a derived series. Shared by the report and Coverage Issues.
 */
export function catalogueUseExplanation(provider: CatalogueProvider, use: CatalogueUse): string | undefined {
  const name = PROVIDER_NAME[provider];
  if (use.state === "unavailable" || use.usingId === undefined) return `No reported ${name} series could supply a usable catalogue; last-good results are kept.`;
  if (use.state === "fallback") {
    const expired = use.preferredDownloadedAt ? `saved catalogue expired ${formatDay(use.preferredUsableUntil)}` : "no saved catalogue";
    const fallbackSaved = use.usingFailedAt ? ` · ${use.usingId} could not be refreshed either; its saved catalogue, downloaded ${formatDay(use.usingDownloadedAt)}, is in use.` : ".";
    return `Preferred: ${use.preferredId} · Currently using: ${use.usingId} · ${use.preferredId} unavailable; ${expired}${fallbackSaved}`;
  }
  if (use.state === "saved-unavailable")
    return `${use.usingId} could not be loaded; its saved catalogue is in use. Last successful download ${formatDay(use.preferredDownloadedAt)}${use.preferredUsableUntil ? ` · usable until ${formatDay(use.preferredUsableUntil)}` : ""}.`;
  if (use.state === "derived") return `Derived from TMDB ${use.derivedFrom}.`;
  return undefined;
}
