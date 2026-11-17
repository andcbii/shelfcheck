import { catalogueStatus, hasMultipleCandidates, seriesLabel } from "@/lib/catalogue-description";
import { PROVIDER_NAME, PROVIDERS, type CatalogueProvider } from "@/lib/catalogue-selection";
import type { ProviderCatalogueSelection, ShowCatalogueSelection } from "@/lib/catalogue-selection-store";

export type CatalogueNotice = { provider: CatalogueProvider; text: string };

function details(provider: CatalogueProvider, selection: ProviderCatalogueSelection): string[] {
  const status = catalogueStatus(selection);
  const preferred = status.preferredId === undefined ? [] : [`Preferred ${PROVIDER_NAME[provider]} ${status.preferredId}`];
  switch (status.kind) {
    case "not-compared": return [...preferred, "Not compared yet"];
    case "unavailable": return [...preferred, "No catalogue available"];
    case "fallback": return [...preferred, `Using fallback ${seriesLabel(selection, status.usingId)}`];
    case "pending": return [...preferred, `Using ${seriesLabel(selection, status.usingId)} until compared`];
  }
  const saved = status.kind === "saved-unavailable";
  if (selection.override === status.usingId) return [`Override: ${seriesLabel(selection, status.usingId)}`, ...(saved ? ["Using saved catalogue", "Series unavailable"] : [])];
  return saved ? [`Using saved catalogue ${seriesLabel(selection, status.usingId)}`, "Series unavailable"] : [`Using ${seriesLabel(selection, status.usingId)}`];
}

/**
 * Results notices for a show whose Plex items report several series IDs on a provider. Each describes the
 * persisted comparison catalogue selection; it never chooses a catalogue itself.
 */
export function catalogueNotices(selection: ShowCatalogueSelection | undefined): CatalogueNotice[] {
  if (!selection) return [];
  return PROVIDERS.filter((provider) => hasMultipleCandidates(selection[provider])).map((provider) => ({
    provider,
    text: [`Multiple ${PROVIDER_NAME[provider]} IDs`, ...details(provider, selection[provider])].join(" · "),
  }));
}
