import "server-only";
import type { CatalogueProvider } from "@/lib/catalogue-selection";
import { answeredEvidence, isSeriesLookup, SavedRelationshipUnavailableError, type ComparisonEvidence, type LookupAnswer } from "@/lib/comparison-evidence";
import { lookupFailureIssueId, type CoverageIssueId } from "@/lib/coverage-issue-ids";
import type { LookupFailureRecord } from "@/lib/lookup-failure-record";
import { usableProviderCatalogue, type PlexGeneratedInputs, type SavedPlexComparison } from "@/lib/plex-catalogues";
import { showProviderIds } from "@/lib/plex-inventory";
import { lookupKey, providerLookup, type ProviderLookup } from "@/lib/provider-lookup";
import type { CrosswalkRelationships, SharedCrosswalkStore } from "@/lib/tmdb-crosswalk-coordinator";
import { replayedTmdbCrosswalkDecision } from "@/lib/tmdb-crosswalk-policy";

/** A cached recheck's evidence source, with the show-level inputs it found missing. */
export type SavedComparisonEvidence = ComparisonEvidence & {
  /** The relationship keys of series lookups that had no saved answer: the saved comparison is incomplete. */
  missing(): string[];
};

/**
 * The saved evidence source of one show comparison in a cached recheck. It is built from saved
 * evidence only and sends no request: it holds no credentials, and raises and resolves no Coverage
 * Issue. Bound at construction: the saved comparison, the saved TMDB catalogues, which providers the
 * recheck compares, shared crosswalk evidence (read only) and the show's recorded lookup failures.
 *
 * - Every lookup reuses its saved answer, even after a recorded failed request.
 * - Series summaries the saved comparison lacks are synthesized, in this order of precedence: the
 *   comparison's own saved answer; the saved catalogue's summary of a Plex-reported TMDB series
 *   (basic summary only, received when the catalogue was downloaded); for a provider the last scan could
 *   not load, a Plex-reported series finds no series (TMDB `null`, TVDB `{}`), as it did in that scan.
 *   Synthesized answers are never part of `changes()`, so they are never saved as newly received.
 * - A missing episode answer fails that episode; a missing series answer fails its lookup and is listed
 *   by `missing()`. Both throw `SavedRelationshipUnavailableError`.
 * - A TMDB external-ID crosswalk applies the ADR-0004 replay decision against shared crosswalk evidence.
 *   A replaced or dropped copy changes only this comparison's in-memory relationships; an answer
 *   recovered after the show's own failed request is reported in `changes().recovered`, for the caller
 *   to save before resolving that request's issue.
 * - Trakt searches are available when the saved comparison holds any Trakt relationship of its own.
 * - Saved IMDb episode IDs are reused when the show has a TVDB series.
 */
export function savedComparisonEvidence({ ratingKey, comparison, tmdbCatalogues, compares, shared, failures }: {
  ratingKey: string;
  comparison: Pick<SavedPlexComparison, "details" | "relationships" | "tvdbEpisodeImdbIds" | "tvdbId">;
  /** The saved TMDB catalogues, by TMDB series ID. */
  tmdbCatalogues: PlexGeneratedInputs["tmdb"];
  /** Which providers the recheck compares: one it does not had no catalogue in the last scan. */
  compares: Record<CatalogueProvider, boolean>;
  shared: SharedCrosswalkStore["read"];
  failures: LookupFailureRecord;
}): SavedComparisonEvidence {
  const relationships: CrosswalkRelationships = { ...comparison.relationships };
  const synthesized = synthesizedSeriesSummaries(comparison.details, tmdbCatalogues, compares);
  const missing = new Set<string>();
  /** Recovered crosswalk relationship keys, with the failed-request issue each resolves once saved. */
  const recovered = new Map<string, CoverageIssueId>();

  async function answer(lookup: ProviderLookup): Promise<LookupAnswer> {
    const key = lookupKey(lookup);
    const found = Object.hasOwn(relationships, key) ? relationships[key] : synthesized.get(key);
    if (found) return { value: found.value, cached: true };
    if (isSeriesLookup(lookup)) missing.add(key);
    throw new SavedRelationshipUnavailableError(lookup);
  }

  const { lookups, tvdbEpisodeImdbIds } = answeredEvidence({
    answer,
    async tmdbEpisodeCrosswalk(tvdbEpisodeId) {
      const lookup = providerLookup.tmdbEpisodeByTvdbEpisode(tvdbEpisodeId);
      const key = lookupKey(lookup);
      const decision = replayedTmdbCrosswalkDecision({ copy: Object.hasOwn(relationships, key) ? relationships[key] : undefined, shared: shared(tvdbEpisodeId), failure: failures.failure(lookup) });
      if (decision.action === "replay-shared" || decision.action === "recover") relationships[key] = { provider: "TMDB", ...decision.copy };
      if (decision.action === "recover") recovered.set(key, lookupFailureIssueId(ratingKey, lookup));
      if (decision.action === "drop") delete relationships[key];
      return (await answer(lookup)).value;
    },
  }, comparison.tvdbId ? { ...comparison.tvdbEpisodeImdbIds } : {});

  return {
    ...lookups,
    traktAvailable: Object.values(comparison.relationships).some((relationship) => relationship.provider === "Trakt"),
    rejectTmdbEpisodeCrosswalk() {},
    changes: () => ({
      relationships: structuredClone(relationships),
      tvdbEpisodeImdbIds: tvdbEpisodeImdbIds(),
      recovered: { relationships: structuredClone(Object.fromEntries([...recovered.keys()].map((key) => [key, relationships[key]]))), resolves: [...recovered.values()] },
      retained: (savedRelationships) => ({ ...savedRelationships }),
    }),
    missing: () => [...missing],
  };
}

/** The series summaries a cached recheck supplies for answers the saved comparison lacks, by relationship key. */
function synthesizedSeriesSummaries(details: SavedPlexComparison["details"], tmdbCatalogues: PlexGeneratedInputs["tmdb"], compares: Record<CatalogueProvider, boolean>) {
  const plexIds = showProviderIds(details.flatMap((detail) => detail.Guid || []));
  const summaries = new Map<string, CrosswalkRelationships[string]>();
  // A provider the last scan could not load is a Total Provider Lookup Failure: its series requests failed
  // in that scan too, so a series with no other answer finds no series, as it did in the scan.
  if (!compares.tmdb) for (const id of plexIds.tmdb) summaries.set(lookupKey(providerLookup.tmdbSeriesSummary(id)), { provider: "TMDB", value: null });
  if (!compares.tvdb) for (const id of plexIds.tvdb) summaries.set(lookupKey(providerLookup.tvdbSeriesSummary(id)), { provider: "TVDB", value: {} });
  // Each scan saves the catalogue of every Plex-reported TMDB series it downloads: its summary takes precedence.
  for (const id of plexIds.tmdb) {
    const saved = tmdbCatalogues[String(id)];
    if (usableProviderCatalogue(saved)) summaries.set(lookupKey(providerLookup.tmdbSeriesSummary(id)), { provider: "TMDB", value: saved.show, receivedAt: saved.downloadedAt });
  }
  return summaries;
}
