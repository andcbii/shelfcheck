import { reuseProviderCatalogue } from "../lib/plex-catalogue-policy";
import type { CatalogueLoad, CatalogueLoadSettings, ComparisonCatalogueSource } from "../lib/comparison-catalogue-resolver";
import type { CatalogueProvider } from "../lib/catalogue-selection";

/** The catalogue payload this source hands back: which series, as downloaded when. */
export type FixtureCatalogue = { provider: CatalogueProvider; id: number; downloadedAt: string };
export type FixturePayloads = { tmdb: FixtureCatalogue; tvdb: FixtureCatalogue };
export type CatalogueRequest = { provider: CatalogueProvider; id: number } & CatalogueLoadSettings;
type Failure = Omit<Extract<CatalogueLoad<FixtureCatalogue>, { outcome: "failed" }>, "outcome">;

/**
 * An in-memory catalogue source for direct resolver tests. Reuse versus download is decided by the
 * production reuse policy from the settings the resolver requests; nothing else about freshness is
 * reimplemented here. A download that fails leaves the saved copy untouched, and reuse never renews
 * a saved copy's original download time. A successful download is saved at `downloadAt`.
 */
export function inMemoryCatalogueSource(options: {
  /** The resolution time, used by the production reuse policy. */
  now: string;
  /** When a successful download in this test happens; defaults to `now`. */
  downloadAt?: string;
  /** Saved catalogues: series ID to original download time. */
  saved?: Partial<Record<CatalogueProvider, Record<number, string>>>;
  /** Series whose download fails, with what the failure carries. */
  failing?: Partial<Record<CatalogueProvider, Record<number, Failure>>>;
}) {
  const saved: Record<CatalogueProvider, Map<number, string>> = {
    tmdb: new Map(Object.entries(options.saved?.tmdb || {}).map(([id, at]) => [Number(id), at])),
    tvdb: new Map(Object.entries(options.saved?.tvdb || {}).map(([id, at]) => [Number(id), at])),
  };
  const requests: CatalogueRequest[] = [];
  const catalogue = (provider: CatalogueProvider, id: number, downloadedAt: string): FixtureCatalogue => ({ provider, id, downloadedAt });
  const source: ComparisonCatalogueSource<FixturePayloads> = {
    async loadCatalogue(provider, id, settings) {
      requests.push({ provider, id, ...settings });
      const downloadedAt = saved[provider].get(id);
      const reuse = reuseProviderCatalogue({ provider, now: options.now, downloadedAt, usable: downloadedAt !== undefined, mandatory: settings.mandatory, targeted: false, changed: false, refreshAfter: settings.refreshAfter });
      if (reuse) return { outcome: "reused", id, catalogue: catalogue(provider, id, downloadedAt!), downloadedAt: downloadedAt! };
      const failure = options.failing?.[provider]?.[id];
      if (failure) return { outcome: "failed", ...failure };
      const at = options.downloadAt || options.now;
      saved[provider].set(id, at);
      return { outcome: "downloaded", id, catalogue: catalogue(provider, id, at), downloadedAt: at };
    },
    savedCatalogue(provider, id) {
      const downloadedAt = saved[provider].get(id);
      return downloadedAt === undefined ? undefined : { id, catalogue: catalogue(provider, id, downloadedAt), downloadedAt };
    },
  };
  return { source, requests, saved };
}
