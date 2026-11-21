import { reuseProviderCatalogue } from "../lib/plex-catalogue-policy";
import type { CatalogueLoad, CatalogueLoadSettings, ComparisonCatalogueSource, SeriesAssociation } from "../lib/comparison-catalogue-resolver";
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
  /** Series the provider answers with no series for when downloaded. */
  noSeries?: Partial<Record<CatalogueProvider, number[]>>;
  /** The TVDB series each TMDB catalogue names; a TMDB catalogue not listed names none. */
  tvdbOfTmdb?: Record<number, number>;
  /** TMDB's series association for each TVDB ID; an unlisted TVDB ID's association is missing. */
  associations?: Record<number, SeriesAssociation>;
  /** Saved association evidence, TVDB ID to TMDB series, answered without a request unless the request is mandatory. */
  savedAssociations?: Record<number, number>;
  /** Series flagged changed by the provider's change detection, which the production reuse policy downloads again (TMDB reuses a same-UTC-day download). */
  changed?: Partial<Record<CatalogueProvider, number[]>>;
  /** A targeted single-show scan, which downloads every catalogue it loads. */
  targeted?: boolean;
  /** Saved records too incomplete to compare: series ID to original download time. */
  unusable?: Partial<Record<CatalogueProvider, Record<number, string>>>;
  /** Each series' counted 404 days; an unlisted series has none. */
  seriesNotFoundDays?: Partial<Record<CatalogueProvider, Record<number, number>>>;
  /** Requested series the provider answers as another series: requested ID to the ID its saved copy and downloads report. */
  reports?: Partial<Record<CatalogueProvider, Record<number, number>>>;
}) {
  const saved: Record<CatalogueProvider, Map<number, string>> = {
    tmdb: new Map(Object.entries(options.saved?.tmdb || {}).map(([id, at]) => [Number(id), at])),
    tvdb: new Map(Object.entries(options.saved?.tvdb || {}).map(([id, at]) => [Number(id), at])),
  };
  const requests: CatalogueRequest[] = [];
  /** Each TVDB ID whose TMDB series association was asked for, with whether the request was mandatory, in order. */
  const associationRequests: { tvdbId: number; mandatory: boolean }[] = [];
  const catalogue = (provider: CatalogueProvider, id: number, downloadedAt: string): FixtureCatalogue => ({ provider, id, downloadedAt });
  const reported = (provider: CatalogueProvider, id: number) => options.reports?.[provider]?.[id] ?? id;
  const association = (provider: CatalogueProvider, id: number) => {
    const tvdbId = provider === "tmdb" ? options.tvdbOfTmdb?.[id] : undefined;
    return tvdbId === undefined ? {} : { associatedTvdbId: tvdbId };
  };
  const source: ComparisonCatalogueSource<FixturePayloads> = {
    async loadCatalogue(provider, id, settings) {
      requests.push({ provider, id, ...settings });
      const downloadedAt = saved[provider].get(id);
      const reuse = reuseProviderCatalogue({ provider, now: options.now, downloadedAt, usable: downloadedAt !== undefined, mandatory: settings.mandatory, targeted: !!options.targeted, changed: !!options.changed?.[provider]?.includes(id), refreshAfter: settings.refreshAfter });
      if (reuse) return { outcome: "reused", id: reported(provider, id), catalogue: catalogue(provider, id, downloadedAt!), downloadedAt: downloadedAt!, ...association(provider, id) };
      const failure = options.failing?.[provider]?.[id];
      if (failure) return { outcome: "failed", ...failure };
      if (options.noSeries?.[provider]?.includes(id)) return { outcome: "empty-show" };
      const at = options.downloadAt || options.now;
      saved[provider].set(id, at);
      return { outcome: "downloaded", id: reported(provider, id), catalogue: catalogue(provider, id, at), downloadedAt: at, ...association(provider, id) };
    },
    savedCatalogue(provider, id) {
      const downloadedAt = saved[provider].get(id);
      return downloadedAt === undefined ? undefined : { id: reported(provider, id), catalogue: catalogue(provider, id, downloadedAt), downloadedAt, ...association(provider, id) };
    },
    savedRecordDownloadedAt(provider, id) {
      return saved[provider].get(id) ?? options.unusable?.[provider]?.[id];
    },
    seriesNotFoundDays(provider, id) {
      return options.seriesNotFoundDays?.[provider]?.[id] ?? 0;
    },
    async tmdbSeriesForTvdb(tvdbId, settings) {
      associationRequests.push({ tvdbId, mandatory: settings.mandatory });
      const evidence = options.savedAssociations?.[tvdbId];
      if (evidence !== undefined && !settings.mandatory) return { outcome: "found", id: evidence, cached: true };
      return options.associations?.[tvdbId] || { outcome: "missing" };
    },
  };
  return { source, requests, associationRequests, saved };
}
