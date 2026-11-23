import "server-only";
import type { LookupSourceStep } from "@/lib/coverage-issues";
import { lookupDiagnostics, traktLoginDiagnostics, type LookupComparisonContext } from "@/lib/lookup-diagnostics";
import { lookupFailureRecord } from "@/lib/lookup-failure-record";
import type { TmdbFindEpisode } from "@/lib/plex-auto-match";
import type { EpisodeCrosswalk } from "@/lib/plex-comparison";
import { isProviderLoginFailure } from "@/lib/provider-client";
import { isProviderId, lookupKey, lookupProvider, providerLookup, type ProviderLookup } from "@/lib/provider-lookup";
import type { ProviderName } from "@/lib/provider-policy";
import { tmdbCrosswalkResults, type CrosswalkRelationships, type tmdbCrosswalkScanRun } from "@/lib/tmdb-crosswalk-coordinator";
import { isRecord, responseRecordList } from "@/lib/value-guards";

/**
 * The comparison evidence interface: one show comparison's source of provider relationships, live
 * or saved. Each lookup kind has its own method and response type. A source answers with provider
 * relationship evidence only; the comparison still decides coverage against current library inventory.
 * Failures are thrown: the typed errors below, or the provider's own request error. An empty answer is
 * a success.
 */
export type TmdbShow = { id: number; name?: string; first_air_date?: string | null; seasons?: { season_number: number }[]; external_ids?: { tvdb_id?: number | null } };
export type TvdbShow = { id: number; name?: string; slug?: string; year?: string };
export type TraktIds = { trakt?: number | null; tmdb?: number | null; tvdb?: number | null };
export type TraktEpisodeSearchResult = { type?: string; episode?: { season?: number; number?: number; ids?: TraktIds }; show?: { ids?: TraktIds } };

/**
 * A successful identity/crosswalk response that cannot be interpreted. Distinct from a
 * rejected request: the request policy succeeded, so it is never a provider outage.
 */
export class CrosswalkResponseError extends Error {
  constructor(readonly provider: ProviderName, detail: string) { super(`${provider} returned a successful response that could not be interpreted (${detail}).`); }
}
/** Thrown for a Trakt lookup skipped because the run's Trakt login cannot be recovered; it is not a failure of that lookup. */
export class TraktLoginUnavailableError extends Error {
  constructor(readonly reason: unknown) { super("Trakt lookups are unavailable for this scan: the Trakt login could not be recovered."); }
}
/**
 * An offline replay found no saved response for one episode's crosswalk. No request was
 * attempted; the failure stays with that episode instead of discarding the show comparison.
 */
export class SavedRelationshipUnavailableError extends Error {
  constructor(readonly relationship: string) { super(`The saved ${relationship.slice(0, relationship.indexOf(":"))} response for this episode is not available to the offline recheck; no request was made.`); }
}

/** The records of a successful response, or the reason it cannot be interpreted as an error. */
export function interpretedRecords<T>(provider: ProviderName, list: ReturnType<typeof responseRecordList>): T[] {
  if ("unreadable" in list) throw new CrosswalkResponseError(provider, list.unreadable);
  return list.records as T[];
}

/** The typed lookup of one TVDB episode's crosswalk. */
export function crosswalkLookup(crosswalk: EpisodeCrosswalk, tvdbEpisodeId: number) {
  return crosswalk === "IMDb" ? providerLookup.tvdbEpisodeExtended(tvdbEpisodeId) : crosswalk === "Trakt" ? providerLookup.traktEpisodeSearchByTvdbEpisode(tvdbEpisodeId) : providerLookup.tmdbEpisodeByTvdbEpisode(tvdbEpisodeId);
}

/** Trakt's episode search for one TVDB episode, and whether its answer was reused from saved evidence. */
export type TraktEpisodeSearch = { results: TraktEpisodeSearchResult[]; cached: boolean };
/**
 * Where a TMDB episode validation came from: the TVDB episode whose Trakt search named the TMDB
 * episode, that TMDB episode ID, and whether the Trakt answer was reused.
 */
export type TraktValidationProvenance = { tvdbEpisodeId: number; tmdbEpisodeId: number; cached: boolean };
/** One TMDB episode by its show, season and episode number. */
export type TmdbEpisodeCoordinate = { tmdbShowId: number; season: number; episode: number };

/** The series lookups of a comparison evidence source. */
export type SeriesEvidence = {
  /** TMDB's external-ID search for one TVDB series: its usable TMDB series. */
  tmdbSeriesByTvdb(tvdbSeriesId: number): Promise<TmdbShow[]>;
  /** One TMDB series summary without external IDs, or none when the answer names no series. */
  tmdbSeriesSummary(tmdbShowId: number): Promise<TmdbShow | undefined>;
  /** One TMDB series summary with its external IDs, or none when the answer names no series. */
  tmdbSeriesSummaryWithExternalIds(tmdbShowId: number): Promise<TmdbShow | undefined>;
  /** One TVDB series summary, or null when TVDB has none. */
  tvdbSeriesSummary(tvdbSeriesId: number): Promise<TvdbShow | null>;
};

/**
 * What a comparison leaves to save. The caller saves `relationships` and `tvdbEpisodeImdbIds` with a
 * completed comparison, saves `recovered.relationships` before resolving `recovered.resolves`, and
 * keeps `retained(saved)` when the comparison fails and its last-good comparison stays.
 */
export type ComparisonEvidenceChanges = {
  /** The comparison's provider relationships, by relationship key. */
  relationships: CrosswalkRelationships;
  /** IMDb episode IDs by TVDB episode ID, as received or reused. */
  tvdbEpisodeImdbIds: Record<string, string[]>;
  /** Evidence recovered after this show's failed requests, and the failed-request issues it resolves once saved. */
  recovered: { relationships: CrosswalkRelationships; resolves: string[] };
  /** A last-good comparison's relationships with this comparison's checked TMDB crosswalk outcomes. */
  retained(saved: CrosswalkRelationships): CrosswalkRelationships;
};

/** One show comparison's evidence source. */
export type ComparisonEvidence = SeriesEvidence & {
  /** Whether Trakt episode searches can be answered: the run's Trakt login, or saved Trakt evidence. */
  readonly traktAvailable: boolean;
  /** TMDB's external-ID crosswalk of one TVDB episode: the TMDB episodes it names. */
  tmdbEpisodeByTvdb(tvdbEpisodeId: number): Promise<TmdbFindEpisode[]>;
  /** Trakt's episode search for one TVDB episode. */
  traktEpisodeSearch(tvdbEpisodeId: number): Promise<TraktEpisodeSearch>;
  /** One TMDB episode record, validating a Trakt answer. */
  tmdbEpisodeDetails(episode: TmdbEpisodeCoordinate, provenance: TraktValidationProvenance): Promise<Record<string, unknown>>;
  /** The IMDb episode IDs of one TVDB episode's extended record: its IMDb crosswalk. */
  tvdbEpisodeExtended(tvdbEpisodeId: number): Promise<Set<string>>;
  /** This comparison could not use a TMDB crosswalk answer: its copy never grants coverage. */
  rejectTmdbEpisodeCrosswalk(tvdbEpisodeId: number): void;
  changes(): ComparisonEvidenceChanges;
};

/** Sends one typed lookup with the scan run's real credentials. */
export type LookupTransport = (lookup: ProviderLookup) => Promise<unknown>;

/** What one live scan run shares with every comparison's live source. */
export type LiveEvidenceScan = {
  transport: LookupTransport;
  /** The scan run's one TMDB crosswalk coordinator. */
  crosswalks: ReturnType<typeof tmdbCrosswalkScanRun>;
  /** Whether the run has a Trakt login. */
  traktLogin: boolean;
  now?: () => string;
};

/**
 * The live evidence source of one show comparison in a live scan. Bound at construction: the show
 * (its identity and lookup provenance, which also bind its read port and diagnostics), its saved
 * evidence and whether its TMDB crosswalks are forced. It reuses saved relationships while no failed
 * request is recorded for them, requests the rest through the scan's transport, and answers TMDB
 * external-ID crosswalks through the scan run's coordinator. Series lookups use `series` until the
 * live source answers them itself.
 */
export function liveComparisonEvidence({ scan, show, saved, forced, series }: {
  scan: LiveEvidenceScan;
  show: LookupComparisonContext;
  /** `reuseImdbIds`: the show's TVDB catalogue is unchanged, so its saved IMDb episode IDs can be reused. */
  saved: { relationships: CrosswalkRelationships; tvdbEpisodeImdbIds?: Record<string, string[]>; reuseImdbIds: boolean };
  /** The show's TMDB relationships cannot be reused: every TMDB crosswalk is requested in this scan. */
  forced: boolean;
  series: SeriesEvidence;
}): ComparisonEvidence {
  const now = scan.now || (() => new Date().toISOString());
  const failures = lookupFailureRecord(show.ratingKey);
  const diagnostics = lookupDiagnostics(show);
  const relationships: CrosswalkRelationships = { ...saved.relationships };
  const imdbIds: Record<string, string[]> = saved.reuseImdbIds ? { ...saved.tvdbEpisodeImdbIds } : {};
  // A recorded crosswalk failure is retried: its saved answers are requested again.
  const retried = new Set<string>();
  for (const { crosswalk, tvdbEpisodeId } of failures.episodeCrosswalkFailures()) {
    if (!isProviderId(tvdbEpisodeId)) continue;
    retried.add(`${crosswalk}:${tvdbEpisodeId}`);
    delete relationships[lookupKey(crosswalkLookup(crosswalk, tvdbEpisodeId))];
    if (crosswalk === "IMDb") delete imdbIds[String(tvdbEpisodeId)];
  }
  const crosswalks = scan.crosswalks.comparison({ relationships, forced });

  /** Sends one lookup, raising or resolving its failed-request issue. */
  async function request(lookup: ProviderLookup, send: () => Promise<unknown>, lookupSource?: LookupSourceStep[]) {
    const provider = lookupProvider(lookup);
    const described = lookupSource ? lookupDiagnostics({ ...show, lookupSource }) : diagnostics;
    let value: unknown;
    try {
      if (provider === "TVDB" && show.tvdbAuthenticationError) throw show.tvdbAuthenticationError;
      value = await send();
    } catch (error) {
      // A login that cannot be recovered is one library issue, not a failure of each lookup it stops.
      if (provider === "Trakt" && isProviderLoginFailure("Trakt", error)) { traktLoginDiagnostics.raiseFailure(error); throw new TraktLoginUnavailableError(error); }
      described.raiseFailure(lookup, error);
      throw error;
    }
    described.resolve(lookup);
    // Only a successful Trakt lookup shows the login works again.
    if (provider === "Trakt") traktLoginDiagnostics.resolve();
    return value;
  }
  /** A saved answer while no failed request is recorded for it, else a new one, saved as the comparison's relationship. */
  async function relationship(lookup: ProviderLookup, lookupSource?: LookupSourceStep[]) {
    const key = lookupKey(lookup);
    if (Object.hasOwn(relationships, key) && !failures.failure(lookup)) return { value: relationships[key].value, cached: true };
    const value = await request(lookup, () => scan.transport(lookup), lookupSource);
    relationships[key] = { provider: lookupProvider(lookup), value, receivedAt: now() };
    return { value, cached: false };
  }

  return {
    traktAvailable: scan.traktLogin,
    async tmdbEpisodeByTvdb(tvdbEpisodeId) {
      const lookup = providerLookup.tmdbEpisodeByTvdbEpisode(tvdbEpisodeId);
      const found = await request(lookup, () => crosswalks.lookup(tvdbEpisodeId, () => scan.transport(lookup), { forced: retried.has(`TMDB:${tvdbEpisodeId}`) }));
      return interpretedRecords<TmdbFindEpisode>("TMDB", tmdbCrosswalkResults(found));
    },
    async traktEpisodeSearch(tvdbEpisodeId) {
      const lookup = providerLookup.traktEpisodeSearchByTvdbEpisode(tvdbEpisodeId);
      if (!scan.traktLogin) throw new TraktLoginUnavailableError(undefined);
      const { value, cached } = await relationship(lookup);
      if (!Array.isArray(value)) throw new CrosswalkResponseError("Trakt", "the episode search result is not a list");
      return { results: value.filter(isRecord) as TraktEpisodeSearchResult[], cached };
    },
    async tmdbEpisodeDetails({ tmdbShowId, season, episode }, { tvdbEpisodeId, tmdbEpisodeId, cached }) {
      const lookup = providerLookup.tmdbEpisodeByShowSeasonEpisode(tmdbShowId, season, episode);
      // Retrying a failed Trakt crosswalk requests its validations again.
      if (retried.has(`Trakt:${tvdbEpisodeId}`)) delete relationships[lookupKey(lookup)];
      const { value } = await relationship(lookup, [
        ...(show.tvdbSource || []), { provider: "TVDB", kind: "catalogue episode", id: tvdbEpisodeId, cached: show.tvdbCached },
        { provider: "Trakt", kind: "external TMDB show ID", id: tmdbShowId, cached },
        { provider: "Trakt", kind: "external TMDB episode ID", id: tmdbEpisodeId, cached },
      ]);
      if (!isRecord(value)) throw new CrosswalkResponseError("TMDB", "the validating episode record is not an object");
      return value;
    },
    async tvdbEpisodeExtended(tvdbEpisodeId) {
      const lookup = providerLookup.tvdbEpisodeExtended(tvdbEpisodeId);
      const kept = imdbIds[String(tvdbEpisodeId)];
      if (kept) return new Set(kept);
      const { value: body } = await relationship(lookup);
      if (!isRecord(body) || !isRecord(body.data)) throw new CrosswalkResponseError("TVDB", "the episode record is missing");
      const remoteIds = body.data.remoteIds;
      if (remoteIds !== undefined && remoteIds !== null && !Array.isArray(remoteIds)) throw new CrosswalkResponseError("TVDB", "remoteIds is not a list");
      // Remote IDs of other sources may use other shapes; only IMDb episode IDs are read.
      const ids = new Set(((remoteIds || []) as unknown[]).flatMap((remote) => isRecord(remote) && typeof remote.id === "string" && /^tt\d+$/i.test(remote.id) ? [remote.id.toLowerCase()] : []));
      imdbIds[String(tvdbEpisodeId)] = [...ids];
      return ids;
    },
    tmdbSeriesByTvdb: (tvdbSeriesId) => series.tmdbSeriesByTvdb(tvdbSeriesId),
    tmdbSeriesSummary: (tmdbShowId) => series.tmdbSeriesSummary(tmdbShowId),
    tmdbSeriesSummaryWithExternalIds: (tmdbShowId) => series.tmdbSeriesSummaryWithExternalIds(tmdbShowId),
    tvdbSeriesSummary: (tvdbSeriesId) => series.tvdbSeriesSummary(tvdbSeriesId),
    rejectTmdbEpisodeCrosswalk: (tvdbEpisodeId) => crosswalks.rejectCopy(tvdbEpisodeId),
    changes: () => ({
      relationships: structuredClone(relationships),
      tvdbEpisodeImdbIds: structuredClone(imdbIds),
      recovered: { relationships: {}, resolves: [] },
      retained: (savedRelationships) => crosswalks.retained(savedRelationships),
    }),
  };
}
