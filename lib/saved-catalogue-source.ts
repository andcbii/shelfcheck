import { PROVIDER_NAME, type CatalogueProvider } from "@/lib/catalogue-selection";
import type { CatalogueLoad, ComparisonCatalogueSource, SavedCatalogue, SeriesAssociation } from "@/lib/comparison-catalogue-resolver";
import { tmdbFindRelationshipKey, usableProviderCatalogue, type PlexGeneratedInputs, type SavedPlexComparison } from "@/lib/plex-catalogues";

/** The saved catalogue records a cached recheck compares, per provider. */
export type SavedCataloguePayloads = { tmdb: PlexGeneratedInputs["tmdb"][string]; tvdb: PlexGeneratedInputs["tvdb"][string] };

/**
 * The cached recheck's comparison catalogue source: saved catalogues and TMDB's saved series
 * associations, read from the saved comparison inputs. It never downloads or requests, and renews no
 * download time. Saved associations stay in the existing URL-keyed relationship records; how they are
 * keyed is hidden behind `tmdbSeriesForTvdb`.
 */
export function savedCatalogueSource(
  catalogues: Pick<PlexGeneratedInputs, "tmdb" | "tvdb">,
  comparison: Pick<SavedPlexComparison, "relationships">,
): ComparisonCatalogueSource<SavedCataloguePayloads> {
  const record = <K extends CatalogueProvider>(provider: K, id: number) => catalogues[provider][String(id)] as SavedCataloguePayloads[K] | undefined;
  const savedCatalogue = <K extends CatalogueProvider>(provider: K, id: number): SavedCatalogue<SavedCataloguePayloads[K]> | undefined => {
    const catalogue = record(provider, id);
    if (!usableProviderCatalogue(catalogue)) return undefined;
    // A TMDB catalogue names its TVDB series, if any, in its external IDs.
    const tvdbId = provider === "tmdb" ? (catalogue as SavedCataloguePayloads["tmdb"]).show.external_ids?.tvdb_id : undefined;
    return { id, catalogue, downloadedAt: catalogue.downloadedAt, ...(tvdbId ? { associatedTvdbId: tvdbId } : {}) };
  };
  return {
    /** Never downloads: the saved copy, whatever the settings, else a failure. */
    async loadCatalogue(provider, id) {
      const saved = savedCatalogue(provider, id);
      if (saved) return { outcome: "reused", ...saved };
      return { outcome: "failed", error: new Error(`Saved ${PROVIDER_NAME[provider]} catalogue ${id} is missing or incomplete.`) } satisfies CatalogueLoad<never>;
    },
    savedCatalogue,
    savedRecordDownloadedAt: (provider, id) => record(provider, id)?.downloadedAt,
    /** From saved evidence only: a mandatory association cannot be requested, so it is missing. */
    async tmdbSeriesForTvdb(tvdbId, { mandatory }): Promise<SeriesAssociation> {
      const saved = mandatory ? undefined : comparison.relationships[tmdbFindRelationshipKey(tvdbId)];
      if (!saved) return { outcome: "missing" };
      // As the scan reads it: TMDB's first TV result, and a saved answer naming none is a valid empty one.
      const id = (saved.value as { tv_results?: { id?: unknown }[] } | null)?.tv_results?.[0]?.id;
      return typeof id === "number" && id > 0 ? { outcome: "found", id, cached: true } : { outcome: "known-empty" };
    },
  };
}
