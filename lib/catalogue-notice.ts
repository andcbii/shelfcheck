import type { CatalogueProvider } from "@/lib/catalogue-selection";
import type { ProviderCatalogueSelection, ShowCatalogueSelection } from "@/lib/catalogue-selection-store";

export type CatalogueNotice = { provider: CatalogueProvider; text: string };

const PROVIDERS: CatalogueProvider[] = ["tmdb", "tvdb"];
const PROVIDER_NAME: Record<CatalogueProvider, string> = { tmdb: "TMDB", tvdb: "TVDB" };

function series(selection: ProviderCatalogueSelection, id: number) {
  const name = selection.candidates.find((candidate) => candidate.id === id)?.name;
  return name ? `${name} (${id})` : String(id);
}

function details(provider: CatalogueProvider, selection: ProviderCatalogueSelection): string[] {
  const current = selection.current;
  const preferredId = current?.preferredId ?? selection.preferredId;
  const preferred = preferredId === undefined ? [] : [`Preferred ${PROVIDER_NAME[provider]} ${preferredId}`];
  if (!current) return [...preferred, "Not compared yet"];
  const usingId = current.usingId;
  if (usingId === undefined) return [...preferred, "No catalogue available"];
  if (current.state === "fallback") return [...preferred, `Using fallback ${series(selection, usingId)}`];
  const saved = current.state === "saved-unavailable";
  if (selection.override === usingId) return [`Override: ${series(selection, usingId)}`, ...(saved ? ["Using saved catalogue", "Series unavailable"] : [])];
  return saved ? [`Using saved catalogue ${series(selection, usingId)}`, "Series unavailable"] : [`Using ${series(selection, usingId)}`];
}

/**
 * Results notices for a show whose Plex items report several series IDs on a provider. Each describes the
 * persisted comparison catalogue selection; it never chooses a catalogue itself.
 */
export function catalogueNotices(selection: ShowCatalogueSelection | undefined): CatalogueNotice[] {
  if (!selection) return [];
  return PROVIDERS.filter((provider) => new Set(selection[provider].candidates.map((candidate) => candidate.id)).size > 1).map((provider) => ({
    provider,
    text: [`Multiple ${PROVIDER_NAME[provider]} IDs`, ...details(provider, selection[provider])].join(" · "),
  }));
}
