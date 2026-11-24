import "server-only";
import { titleDependentTvdbEpisodeIds, type LocalCompoundEpisode } from "@/lib/compound-episodes";
import type { CatalogueLoad, CatalogueLoadSettings, ComparedCatalogue, ComparisonCatalogueSource, SavedCatalogue, SeriesAssociation } from "@/lib/comparison-catalogue-resolver";
import type { CatalogueProvider } from "@/lib/catalogue-selection";
import { TVDB_AUTHENTICATION_ISSUE } from "@/lib/coverage-issue-ids";
import type { MalformedCatalogueRecord, NormalisedCatalogue } from "@/lib/catalogue-records";
import type { ProviderEpisode } from "@/lib/plex-comparison";
import { reuseProviderCatalogue } from "@/lib/plex-catalogue-policy";
import { saveDeferredTmdbChanges, savePendingTvdbChanges, savePlexCatalogue, usableProviderCatalogue, type PlexGeneratedInputs, type TmdbCatalogueShow } from "@/lib/plex-catalogues";
import { ProviderHttpError } from "@/lib/provider-client";
import type { ScanLogger } from "@/lib/scan-log";
import type { SeriesNotFoundHistory } from "@/lib/series-not-found-history";
import { recoverTvdbTitles, type TitleRecoveryState } from "@/lib/tvdb-title-recovery";

/** A TMDB catalogue as compared: the show record, its usable episodes and the records that could not be used. */
export type TmdbCatalogue = { show: TmdbCatalogueShow; episodes: ProviderEpisode[]; malformed: MalformedCatalogueRecord[] };

/**
 * A TVDB catalogue as compared. `titleRecovery` is its English-title fallback outcome; `carried` when
 * recovery was not attempted for it in this scan (a saved copy compared because its load failed).
 */
export type TvdbCatalogue = { episodes: ProviderEpisode[]; malformed: MalformedCatalogueRecord[]; slug?: string; titleRecovery: { state: TitleRecoveryState; carried: boolean } };

export type DownloadCataloguePayloads = { tmdb: TmdbCatalogue; tvdb: TvdbCatalogue };

/** The provider requests the source makes; each rejects with the request's failure. */
export type CatalogueRequests = {
  /** TMDB's show record; null when TMDB answers with no show. */
  tmdbShow(id: number): Promise<TmdbCatalogueShow | null>;
  /** TMDB's find answer for a TVDB series: its first TV result, if any. */
  tmdbShowForTvdb(tvdbId: number): Promise<TmdbCatalogueShow | undefined>;
  tmdbEpisodes(show: TmdbCatalogueShow): Promise<NormalisedCatalogue>;
  tvdbSeries(id: number, showTitle: string): Promise<NormalisedCatalogue & { slug?: string; name?: string }>;
  tvdbEnglishTitle(tvdbEpisodeId: number): Promise<unknown>;
};

export type DownloadCatalogueSourceOptions = {
  /** The scan's saved inputs; successful downloads and title repairs are written to them and saved. */
  inputs: PlexGeneratedInputs;
  requests: CatalogueRequests;
  /** The scan's start, which every freshness decision uses. */
  now: string;
  /** A single-show scan downloads every catalogue it compares. */
  targeted: boolean;
  /** Verified TMDB changes, retained deferrals and verification recovery. */
  tmdbChanges: ReadonlySet<number>;
  /** Verified and retained pending TVDB changes. */
  tvdbChanges: ReadonlySet<number>;
  /** The scan's TVDB authentication failure: TVDB downloads are not attempted and fail with it. */
  tvdbAuthenticationError?: unknown;
  show: { ratingKey: string; title?: string };
  /** The show's last saved comparison: a derived TMDB series reuses the one it compared for the same TVDB series. */
  previousComparison?: { tmdbId?: number; tvdbId?: number };
  /** Title context for TVDB English-title recovery: whether combined/split checks run, and the library's episodes of this show. */
  titles: { autoCompoundEpisodes: boolean; localEpisodes: LocalCompoundEpisode[] };
  logger: ScanLogger;
  /** The shared 404 history of series requests: this source counts series-request 404s and resets it on complete downloads. */
  seriesNotFound: SeriesNotFoundHistory;
};

/** The Coverage Issue causes of a catalogue load the scan's TVDB authentication failure prevented. */
const TVDB_AUTHENTICATION_CAUSE = [TVDB_AUTHENTICATION_ISSUE];

/** What each provider's series request (TMDB `/tv/{id}`, TVDB `/series/{id}`) is called in a request identity. */
const SERIES_REQUEST_KIND: Record<CatalogueProvider, string> = { tmdb: "show", tvdb: "series" };

/** A load whose series request answered 404, after that 404 was counted. */
class SeriesNotFound {
  constructor(readonly error: unknown, readonly countedDays: number) {}
}

type TmdbRecord = PlexGeneratedInputs["tmdb"][string];
type TvdbRecord = PlexGeneratedInputs["tvdb"][string];
const associated = (show: TmdbCatalogueShow) => show.external_ids?.tvdb_id ? { associatedTvdbId: show.external_ids.tvdb_id } : {};
/** A saved TMDB record as compared, with the TVDB series it names. */
const savedTmdbCatalogue = (record: TmdbRecord): SavedCatalogue<TmdbCatalogue> =>
  ({ id: record.show.id, catalogue: { show: record.show, episodes: record.episodes, malformed: record.malformed || [] }, downloadedAt: record.downloadedAt, ...associated(record.show) });

export type DownloadCatalogueSource = ComparisonCatalogueSource<DownloadCataloguePayloads> & {
  /**
   * Set the episodes the comparison already runs against, which every later TVDB load uses: a reused
   * TVDB catalogue asks again for an English title TVDB had none of only when these make it
   * title-dependent. The caller sets them before a TVDB load: the catalogues compared so far, or the
   * TMDB catalogue chosen, which the resolver's progress sink receives before TVDB's work starts.
   */
  compareTitlesWith(comparisonEpisodes: readonly ProviderEpisode[]): void;
  /**
   * The preparation step after both catalogues are chosen. A reused TVDB catalogue whose titles were
   * recovered before TMDB loaded could not know which titles a combined/split check needs. Ask again
   * for each English title TVDB had none of that the comparison now makes title-dependent, and save
   * the repaired catalogue without renewing its download time or changing any obligation.
   */
  prepareTitlesNeeded(tvdb: ComparedCatalogue<TvdbCatalogue>, comparisonEpisodes: readonly ProviderEpisode[]): Promise<ComparedCatalogue<TvdbCatalogue>>;
};

/**
 * The live Plex scan's catalogue source: it downloads or reuses each provider catalogue under the
 * scan's freshness policy and saves every successful download at once, so an interrupted scan does
 * not download it again. It keeps the scan's change bookkeeping (deferred TMDB changes, pending TVDB
 * changes), recovers unusable TVDB titles from English, and reports a TVDB authentication failure as
 * the cause of the loads it prevents. One source serves one show of one scan.
 */
export function downloadCatalogueSource(options: DownloadCatalogueSourceOptions): DownloadCatalogueSource {
  const { inputs, requests, now, targeted, tmdbChanges, tvdbChanges, tvdbAuthenticationError, show, titles, logger, seriesNotFound } = options;
  let comparedEpisodes: readonly ProviderEpisode[] = [];
  /** TMDB series this source found by a find request: the scan downloads the series it finds. */
  const foundByRequest = new Set<number>();
  const authentication = (error: unknown) => tvdbAuthenticationError !== undefined && error === tvdbAuthenticationError ? { causedBy: TVDB_AUTHENTICATION_CAUSE } : {};
  /** Whether a provider's verified changes include a series' saved catalogue. */
  const changed: Record<CatalogueProvider, (id: number) => boolean> = {
    tmdb: id => { const saved = inputs.tmdb[String(id)]; return !!saved && tmdbChanges.has(saved.show.id); },
    tvdb: id => tvdbChanges.has(id),
  };
  const reuse = (provider: CatalogueProvider, id: number, settings: CatalogueLoadSettings) => {
    const saved = inputs[provider][String(id)];
    return reuseProviderCatalogue({ provider, now, downloadedAt: saved?.downloadedAt, usable: usableProviderCatalogue(saved), mandatory: settings.mandatory, targeted, changed: changed[provider](id), refreshAfter: settings.refreshAfter });
  };
  const logRecovery = (tvdbShowId: number, recovery: { recovered: number[]; unresolved: TitleRecoveryState }) => {
    for (const tvdbEpisodeId of recovery.recovered) logger.info("plex.show.episode-title-recovered", { ratingKey: show.ratingKey, tvdbShowId, tvdbEpisodeId, language: "eng" });
    for (const [tvdbEpisodeId, entry] of Object.entries(recovery.unresolved)) logger.warn("plex.show.episode-title-unrecovered", { ratingKey: show.ratingKey, tvdbShowId, tvdbEpisodeId: Number(tvdbEpisodeId), ...entry });
  };
  /**
   * Run a load's provider requests. Only a 404 on the series request itself counts toward the
   * series' 404 days (once per UTC day of the request); seasons, episode pages and every other
   * failure neither count nor reset.
   */
  const requestingSeries = async <T>(provider: CatalogueProvider, id: number, request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      const requested = error instanceof ProviderHttpError && error.status === 404 ? error.requested : undefined;
      if (requested?.kind !== SERIES_REQUEST_KIND[provider] || requested.id !== id) throw error;
      throw new SeriesNotFound(error, seriesNotFound.recordNotFound(provider, id, new Date().toISOString()));
    }
  };
  const requestEnglishTitle = (tvdbEpisodeId: number) => tvdbAuthenticationError !== undefined ? Promise.reject(tvdbAuthenticationError) : requests.tvdbEnglishTitle(tvdbEpisodeId);
  /** Recovered titles join a saved TVDB catalogue without changing its download time. */
  const saveRecoveredTitles = (id: number, record: TvdbRecord, episodes: ProviderEpisode[], state: TitleRecoveryState) => {
    inputs.tvdb[String(id)] = { ...record, episodes, titleRecovery: state };
    if (!Object.keys(state).length) delete inputs.tvdb[String(id)].titleRecovery;
    savePlexCatalogue("tvdb", id, inputs.tvdb[String(id)]);
  };

  async function loadTmdb(id: number, settings: CatalogueLoadSettings): Promise<CatalogueLoad<TmdbCatalogue>> {
    const saved = inputs.tmdb[String(id)];
    const reused = !foundByRequest.has(id) && reuse("tmdb", id, settings);
    if (reused) {
      if (tmdbChanges.has(saved.show.id)) {
        inputs.deferredTmdbChanges[String(saved.show.id)] = true;
        saveDeferredTmdbChanges(inputs.deferredTmdbChanges);
      }
      return { outcome: "reused", ...savedTmdbCatalogue(saved) };
    }
    const downloaded = await requestingSeries("tmdb", id, () => requests.tmdbShow(id));
    if (!downloaded) return { outcome: "empty-show" };
    const { episodes, malformed = [] } = await requests.tmdbEpisodes(downloaded);
    const record = { version: 1 as const, downloadedAt: new Date().toISOString(), show: downloaded, episodes, ...(malformed.length ? { malformed } : {}) };
    inputs.tmdb[String(downloaded.id)] = record;
    savePlexCatalogue("tmdb", downloaded.id, record);
    seriesNotFound.resetAfterCompleteDownload("tmdb", id);
    delete inputs.deferredTmdbChanges[String(downloaded.id)];
    saveDeferredTmdbChanges(inputs.deferredTmdbChanges);
    return { outcome: "downloaded", id: downloaded.id, catalogue: { show: downloaded, episodes, malformed }, downloadedAt: record.downloadedAt, ...associated(downloaded) };
  }

  async function loadTvdb(id: number, settings: CatalogueLoadSettings): Promise<CatalogueLoad<TvdbCatalogue>> {
    const saved = inputs.tvdb[String(id)];
    const reused = reuse("tvdb", id, settings);
    if (!reused && tvdbAuthenticationError !== undefined) throw tvdbAuthenticationError;
    const tvdb = reused ? { episodes: saved.episodes, malformed: saved.malformed || [], slug: saved.show.slug, name: saved.show.name } : await requestingSeries("tvdb", id, () => requests.tvdbSeries(id, show.title || "Unknown show"));
    // Default catalogue first; only unusable titles are recovered, per TVDB episode, from English.
    const titleDependent = titles.autoCompoundEpisodes ? titleDependentTvdbEpisodeIds([...comparedEpisodes, ...tvdb.episodes], titles.localEpisodes) : new Set<number>();
    const recovery = await recoverTvdbTitles({
      episodes: tvdb.episodes,
      previous: reused ? undefined : saved?.episodes,
      requestEnglish: requestEnglishTitle,
      authenticationError: tvdbAuthenticationError,
      ...(reused ? { reused: { outcomes: saved.titleRecovery || {}, titleNeeded: (episodeId: number) => titleDependent.has(episodeId) } } : {}),
    });
    logRecovery(id, recovery);
    const unresolved = Object.keys(recovery.unresolved).length ? { titleRecovery: recovery.unresolved } : {};
    if (reused && recovery.attempted) saveRecoveredTitles(id, saved, recovery.episodes, recovery.unresolved);
    if (!reused) {
      inputs.tvdb[String(id)] = { version: 1, downloadedAt: new Date().toISOString(), show: { id, name: tvdb.name, slug: tvdb.slug }, episodes: recovery.episodes, ...(tvdb.malformed.length ? { malformed: tvdb.malformed } : {}), ...unresolved };
      if (inputs.pendingTvdbChanges[String(id)]) {
        delete inputs.pendingTvdbChanges[String(id)];
        savePendingTvdbChanges(inputs.pendingTvdbChanges);
      }
      savePlexCatalogue("tvdb", id, inputs.tvdb[String(id)]);
      seriesNotFound.resetAfterCompleteDownload("tvdb", id);
    }
    return { outcome: reused ? "reused" : "downloaded", id, catalogue: { episodes: recovery.episodes, malformed: tvdb.malformed, slug: tvdb.slug, titleRecovery: { state: recovery.unresolved, carried: false } }, downloadedAt: inputs.tvdb[String(id)].downloadedAt };
  }

  const loaders: { [K in CatalogueProvider]: (id: number, settings: CatalogueLoadSettings) => Promise<CatalogueLoad<DownloadCataloguePayloads[K]>> } = { tmdb: loadTmdb, tvdb: loadTvdb };
  const savedCatalogues: { [K in CatalogueProvider]: (id: number) => SavedCatalogue<DownloadCataloguePayloads[K]> | undefined } = {
    tmdb: id => { const saved = inputs.tmdb[String(id)]; return usableProviderCatalogue(saved) ? savedTmdbCatalogue(saved) : undefined; },
    tvdb: id => {
      const saved = inputs.tvdb[String(id)];
      if (!usableProviderCatalogue(saved)) return undefined;
      return { id, catalogue: { episodes: saved.episodes, malformed: saved.malformed || [], slug: saved.show.slug, titleRecovery: { state: saved.titleRecovery || {}, carried: true } }, downloadedAt: saved.downloadedAt };
    },
  };

  return {
    async loadCatalogue(provider, id, settings) {
      try {
        return await loaders[provider](id, settings);
      } catch (error) {
        if (error instanceof SeriesNotFound) return { outcome: "failed", error: error.error, kind: "series-not-found", seriesNotFoundDays: error.countedDays };
        return { outcome: "failed", error, ...authentication(error) };
      }
    },
    savedCatalogue(provider, id) {
      return savedCatalogues[provider](id);
    },
    savedRecordDownloadedAt(provider, id) {
      return inputs[provider][String(id)]?.downloadedAt;
    },
    seriesNotFoundDays(provider, id) {
      return seriesNotFound.countedDays(provider, id);
    },
    async tmdbSeriesForTvdb(tvdbId, settings): Promise<SeriesAssociation> {
      // The TMDB series last compared for this TVDB series answers without a request while the scan would reuse it.
      const previous = options.previousComparison;
      const retained = previous?.tvdbId === tvdbId ? previous.tmdbId : undefined;
      if (!settings.mandatory && retained !== undefined && reuse("tmdb", retained, settings)) return { outcome: "found", id: inputs.tmdb[String(retained)].show.id, cached: true };
      try {
        const found = await requests.tmdbShowForTvdb(tvdbId);
        if (!found) return { outcome: "known-empty" };
        foundByRequest.add(found.id);
        return { outcome: "found", id: found.id, cached: false };
      } catch (error) {
        return { outcome: "failed", error };
      }
    },
    compareTitlesWith(comparisonEpisodes) {
      comparedEpisodes = [...comparisonEpisodes];
    },
    async prepareTitlesNeeded(tvdb, comparisonEpisodes) {
      if (tvdb.origin !== "reused" || tvdb.catalogue.titleRecovery.carried || !titles.autoCompoundEpisodes) return tvdb;
      const needed = titleDependentTvdbEpisodeIds([...comparisonEpisodes], titles.localEpisodes);
      const { state: recorded } = tvdb.catalogue.titleRecovery;
      const retry = new Set(Object.entries(recorded).flatMap(([episodeId, entry]) => entry.outcome === "no-english-title" && needed.has(Number(episodeId)) ? [Number(episodeId)] : []));
      if (!retry.size) return tvdb;
      const id = tvdb.id, saved = inputs.tvdb[String(id)];
      const recovery = await recoverTvdbTitles({
        episodes: saved.episodes.filter(episode => episode.source === "TVDB" && retry.has(episode.providerEpisodeId!)),
        requestEnglish: requestEnglishTitle,
        authenticationError: tvdbAuthenticationError,
      });
      logRecovery(id, recovery);
      const repaired = new Map(recovery.episodes.map(episode => [episode.providerEpisodeId, episode]));
      const repair = (episode: ProviderEpisode) => episode.source === "TVDB" && repaired.has(episode.providerEpisodeId) ? repaired.get(episode.providerEpisodeId)! : episode;
      const state = { ...Object.fromEntries(Object.entries(recorded).filter(([episodeId]) => !retry.has(Number(episodeId)))), ...recovery.unresolved };
      saveRecoveredTitles(id, saved, saved.episodes.map(repair), state);
      return { ...tvdb, catalogue: { ...tvdb.catalogue, episodes: tvdb.catalogue.episodes.map(repair), titleRecovery: { state, carried: false } } };
    },
  };
}
