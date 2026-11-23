import "server-only";
import type { LookupSourceStep } from "@/lib/coverage-issues";
import type { LookupComparisonContext, LookupDiagnostics } from "@/lib/lookup-diagnostics";
import type { LookupFailureRecord } from "@/lib/lookup-failure-record";
import type { TmdbFindEpisode } from "@/lib/plex-auto-match";
import type { EpisodeCrosswalk } from "@/lib/plex-comparison";
import { isProviderLoginFailure } from "@/lib/provider-client";
import { isProviderId, lookupKey, lookupProvider, providerLookup, type ProviderLookup, type TmdbEpisodeLookup } from "@/lib/provider-lookup";
import type { ProviderName } from "@/lib/provider-policy";
import { tmdbCrosswalkResults, type CrosswalkRelationships, type RecoveredCrosswalks, type TmdbCrosswalkScanRun } from "@/lib/tmdb-crosswalk-coordinator";
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
/** The series lookups: a missing saved answer to one is a missing show-level input. */
const SERIES_LOOKUPS = new Set<ProviderLookup["kind"]>(["tmdb-series-by-tvdb-series", "tmdb-series-summary", "tmdb-series-summary-with-external-ids", "tvdb-series-summary"]);
/** Whether a lookup is one of a comparison's series lookups rather than an episode lookup. */
export const isSeriesLookup = (lookup: ProviderLookup) => SERIES_LOOKUPS.has(lookup.kind);

/**
 * A cached recheck found no saved response for one lookup. No request was attempted. A missing
 * episode answer stays with that episode instead of discarding the show comparison; a missing
 * series answer is a missing show-level input.
 */
export class SavedRelationshipUnavailableError extends Error {
  // The episode message is stored as the episode failure's reason, so its wording stays as it was.
  constructor(readonly lookup: ProviderLookup) { super(`The saved ${lookupProvider(lookup)} response for this ${isSeriesLookup(lookup) ? "series" : "episode"} is not available to the offline recheck; no request was made.`); }
}

/** A TMDB series record usable as a series: one with a numeric ID. */
export const usableTmdbShow = (value: unknown): value is TmdbShow => isRecord(value) && typeof value.id === "number";

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
  recovered: RecoveredCrosswalks;
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
  tmdbEpisodeDetails(lookup: TmdbEpisodeLookup, provenance: TraktValidationProvenance): Promise<Record<string, unknown>>;
  /** The IMDb episode IDs of one TVDB episode's extended record: its IMDb crosswalk. */
  tvdbEpisodeExtended(tvdbEpisodeId: number): Promise<Set<string>>;
  /** This comparison could not use a TMDB crosswalk answer: its copy never grants coverage. */
  rejectTmdbEpisodeCrosswalk(tvdbEpisodeId: number): void;
  changes(): ComparisonEvidenceChanges;
};

/** A source's answer to one lookup, and whether it was reused from saved evidence. */
export type LookupAnswer = { value: unknown; cached: boolean };

/**
 * How one evidence source finds answers, before interpretation. Every source shares the reading of
 * each lookup kind's answer (`answeredEvidence`); only how the answers are found differs.
 */
export type EvidenceAnswers = {
  /** One lookup's answer. `validation`: a TMDB episode validation's Trakt provenance. */
  answer(lookup: ProviderLookup, validation?: TraktValidationProvenance): Promise<LookupAnswer>;
  /** One TVDB episode's TMDB external-ID crosswalk answer. */
  tmdbEpisodeCrosswalk(tvdbEpisodeId: number): Promise<unknown>;
};

/** The lookup methods of the comparison evidence interface. */
export type EvidenceLookups = Omit<ComparisonEvidence, "traktAvailable" | "rejectTmdbEpisodeCrosswalk" | "changes">;

/**
 * The lookup methods over a source's answers: each lookup kind's response is read one way. It owns
 * the comparison's IMDb episode IDs: it starts from `keptImdbIds` (copied), answers from them before
 * any extended record, sets each record it reads, and `tvdbEpisodeImdbIds()` is their snapshot.
 */
export function answeredEvidence(answers: EvidenceAnswers, keptImdbIds: Record<string, string[]>): { lookups: EvidenceLookups; tvdbEpisodeImdbIds(): Record<string, string[]> } {
  const { answer } = answers;
  const imdbIds: Record<string, string[]> = { ...keptImdbIds };
  const lookups: EvidenceLookups = {
    async tmdbEpisodeByTvdb(tvdbEpisodeId) {
      return interpretedRecords<TmdbFindEpisode>("TMDB", tmdbCrosswalkResults(await answers.tmdbEpisodeCrosswalk(tvdbEpisodeId)));
    },
    async traktEpisodeSearch(tvdbEpisodeId) {
      const { value, cached } = await answer(providerLookup.traktEpisodeSearchByTvdbEpisode(tvdbEpisodeId));
      if (!Array.isArray(value)) throw new CrosswalkResponseError("Trakt", "the episode search result is not a list");
      return { results: value.filter(isRecord) as TraktEpisodeSearchResult[], cached };
    },
    async tmdbEpisodeDetails(lookup, provenance) {
      const { value } = await answer(lookup, provenance);
      if (!isRecord(value)) throw new CrosswalkResponseError("TMDB", "the validating episode record is not an object");
      return value;
    },
    async tvdbEpisodeExtended(tvdbEpisodeId) {
      const lookup = providerLookup.tvdbEpisodeExtended(tvdbEpisodeId);
      const kept = imdbIds[String(tvdbEpisodeId)];
      if (kept) return new Set(kept);
      const { value: body } = await answer(lookup);
      if (!isRecord(body) || !isRecord(body.data)) throw new CrosswalkResponseError("TVDB", "the episode record is missing");
      const remoteIds = body.data.remoteIds;
      if (remoteIds !== undefined && remoteIds !== null && !Array.isArray(remoteIds)) throw new CrosswalkResponseError("TVDB", "remoteIds is not a list");
      // Remote IDs of other sources may use other shapes; only IMDb episode IDs are read.
      const ids = new Set(((remoteIds || []) as unknown[]).flatMap((remote) => isRecord(remote) && typeof remote.id === "string" && /^tt\d+$/i.test(remote.id) ? [remote.id.toLowerCase()] : []));
      imdbIds[String(tvdbEpisodeId)] = [...ids];
      return ids;
    },
    async tmdbSeriesByTvdb(tvdbSeriesId) {
      const { value } = await answer(providerLookup.tmdbSeriesByTvdbSeries(tvdbSeriesId));
      return interpretedRecords<TmdbShow>("TMDB", responseRecordList(value, "tv_results")).filter(usableTmdbShow);
    },
    // The basic and external-ID summaries are separate lookups: neither ever answers the other.
    async tmdbSeriesSummary(tmdbShowId) {
      const { value } = await answer(providerLookup.tmdbSeriesSummary(tmdbShowId));
      return usableTmdbShow(value) ? value : undefined;
    },
    async tmdbSeriesSummaryWithExternalIds(tmdbShowId) {
      const { value } = await answer(providerLookup.tmdbSeriesSummaryWithExternalIds(tmdbShowId));
      return usableTmdbShow(value) ? value : undefined;
    },
    async tvdbSeriesSummary(tvdbSeriesId) {
      const { value } = await answer(providerLookup.tvdbSeriesSummary(tvdbSeriesId));
      const data = isRecord(value) ? value.data as { id?: number; name?: string; slug?: string; year?: string } | undefined : undefined;
      return data ? { id: data.id || tvdbSeriesId, name: data.name, slug: data.slug, year: data.year } : null;
    },
  };
  return { lookups, tvdbEpisodeImdbIds: () => structuredClone(imdbIds) };
}

/** Sends one typed lookup with the scan run's real credentials. */
export type LookupTransport = (lookup: ProviderLookup) => Promise<unknown>;

/** The scan run's Trakt login issue: one library issue for a login that cannot be recovered. */
export type TraktLoginDiagnostics = { raiseFailure(error: unknown): void; resolve(): void };

/** What one live scan run shares with every comparison's live source. */
export type LiveEvidenceScan = {
  transport: LookupTransport;
  /** The scan run's one TMDB crosswalk coordinator. */
  crosswalks: TmdbCrosswalkScanRun;
  /** Whether the run has a Trakt login. */
  traktLogin: boolean;
  traktLoginDiagnostics: TraktLoginDiagnostics;
  now?: () => string;
};

/**
 * The live evidence source of one show comparison in a live scan. Bound at construction: the show
 * (its identity and lookup provenance), its saved evidence, whether its TMDB crosswalks are forced,
 * the show's Coverage Issue read port and its lookup diagnostics adapter. It reuses saved
 * relationships while no failed request is recorded for them, requests the rest through the scan's
 * transport, and answers TMDB external-ID crosswalks through the scan run's coordinator. Catalogue
 * downloads (the TVDB slug read included) are not lookups of this source and are never answered from
 * its saved evidence.
 */
export function liveComparisonEvidence({ scan, show, saved, forced, failures, diagnostics }: {
  scan: LiveEvidenceScan;
  show: LookupComparisonContext;
  /**
   * `relationships`: the reusable saved relationships, including other TVDB candidates' TMDB series
   * associations, which this comparison never reads but keeps for a recheck that switches to one.
   * `reuseImdbIds`: the show's TVDB catalogue is unchanged, so its saved IMDb episode IDs can be reused.
   */
  saved: { relationships: CrosswalkRelationships; tvdbEpisodeImdbIds?: Record<string, string[]>; reuseImdbIds: boolean };
  /** The show's TMDB relationships cannot be reused: every TMDB crosswalk is requested in this scan. */
  forced: boolean;
  /** The show's recorded lookup failures. */
  failures: LookupFailureRecord;
  /** Raises and resolves the show's failed-request Coverage Issues. */
  diagnostics: LookupDiagnostics;
}): ComparisonEvidence {
  const now = scan.now || (() => new Date().toISOString());
  const relationships: CrosswalkRelationships = { ...saved.relationships };
  const keptImdbIds: Record<string, string[]> = saved.reuseImdbIds ? { ...saved.tvdbEpisodeImdbIds } : {};
  // A recorded crosswalk failure is retried: its saved answers are requested again.
  const retried = new Set<string>();
  for (const { crosswalk, tvdbEpisodeId } of failures.episodeCrosswalkFailures()) {
    if (!isProviderId(tvdbEpisodeId)) continue;
    retried.add(`${crosswalk}:${tvdbEpisodeId}`);
    delete relationships[lookupKey(crosswalkLookup(crosswalk, tvdbEpisodeId))];
    if (crosswalk === "IMDb") delete keptImdbIds[String(tvdbEpisodeId)];
  }
  const crosswalks = scan.crosswalks.comparison({ relationships, forced });

  /** Sends one lookup, raising or resolving its failed-request issue. */
  async function request(lookup: ProviderLookup, send: () => Promise<unknown>, lookupSource?: LookupSourceStep[]) {
    const provider = lookupProvider(lookup);
    let value: unknown;
    try {
      if (provider === "TVDB" && show.tvdbAuthenticationError) throw show.tvdbAuthenticationError;
      value = await send();
    } catch (error) {
      // A login that cannot be recovered is one library issue, not a failure of each lookup it stops.
      if (provider === "Trakt" && isProviderLoginFailure("Trakt", error)) { scan.traktLoginDiagnostics.raiseFailure(error); throw new TraktLoginUnavailableError(error); }
      diagnostics.raiseFailure(lookup, error, lookupSource);
      throw error;
    }
    diagnostics.resolve(lookup);
    // Only a successful Trakt lookup shows the login works again.
    if (provider === "Trakt") scan.traktLoginDiagnostics.resolve();
    return value;
  }

  const { lookups, tvdbEpisodeImdbIds } = answeredEvidence({
    /** A saved answer while no failed request is recorded for it, else a new one, saved as the comparison's relationship. */
    async answer(lookup, validation) {
      if (lookupProvider(lookup) === "Trakt" && !scan.traktLogin) throw new TraktLoginUnavailableError(undefined);
      const key = lookupKey(lookup);
      // Retrying a failed Trakt crosswalk requests its validations again.
      if (validation && retried.has(`Trakt:${validation.tvdbEpisodeId}`)) delete relationships[key];
      if (Object.hasOwn(relationships, key) && !failures.failure(lookup)) return { value: relationships[key].value, cached: true };
      const lookupSource: LookupSourceStep[] | undefined = validation && lookup.kind === "tmdb-episode-by-show-season-episode" ? [
        ...(show.tvdbSource || []), { provider: "TVDB", kind: "catalogue episode", id: validation.tvdbEpisodeId, cached: show.tvdbCached },
        { provider: "Trakt", kind: "external TMDB show ID", id: lookup.tmdbShowId, cached: validation.cached },
        { provider: "Trakt", kind: "external TMDB episode ID", id: validation.tmdbEpisodeId, cached: validation.cached },
      ] : undefined;
      const value = await request(lookup, () => scan.transport(lookup), lookupSource);
      relationships[key] = { provider: lookupProvider(lookup), value, receivedAt: now() };
      return { value, cached: false };
    },
    tmdbEpisodeCrosswalk(tvdbEpisodeId) {
      const lookup = providerLookup.tmdbEpisodeByTvdbEpisode(tvdbEpisodeId);
      return request(lookup, () => crosswalks.lookup(tvdbEpisodeId, () => scan.transport(lookup), { forced: retried.has(`TMDB:${tvdbEpisodeId}`) }));
    },
  }, keptImdbIds);

  return {
    ...lookups,
    traktAvailable: scan.traktLogin,
    rejectTmdbEpisodeCrosswalk: (tvdbEpisodeId) => crosswalks.rejectCopy(tvdbEpisodeId),
    changes: () => ({
      relationships: structuredClone(relationships),
      tvdbEpisodeImdbIds: tvdbEpisodeImdbIds(),
      recovered: { relationships: {}, resolves: [] },
      retained: (savedRelationships) => crosswalks.retained(savedRelationships),
    }),
  };
}
