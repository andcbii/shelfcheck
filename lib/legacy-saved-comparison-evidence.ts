import "server-only";
import { answeredEvidence, SavedRelationshipUnavailableError, type ComparisonEvidence } from "@/lib/comparison-evidence";
import { lookupFailureIssueId } from "@/lib/lookup-diagnostics";
import type { LookupFailureRecord } from "@/lib/lookup-failure-record";
import { lookupKey, providerLookup, type ProviderLookup } from "@/lib/provider-lookup";
import type { CrosswalkRelationships, SharedCrosswalkStore } from "@/lib/tmdb-crosswalk-coordinator";
import { replayedTmdbCrosswalkDecision } from "@/lib/tmdb-crosswalk-policy";

/** Episode lookups: a missing saved answer fails only its episode's crosswalk. */
const EPISODE_LOOKUPS = new Set<ProviderLookup["kind"]>(["tmdb-episode-by-tvdb-episode", "trakt-episode-search-by-tvdb-episode", "tmdb-episode-by-show-season-episode", "tvdb-episode-extended"]);

/**
 * TEMPORARY (SHELFCHECK-127, replaced by the saved evidence source in SHELFCHECK-128): a cached
 * recheck's evidence source, replaying the comparison's saved relationships. It has no transport or
 * credentials, raises and resolves no Coverage Issue, and is the only place that replays.
 * - Every lookup reuses its saved answer, even after a recorded failed request.
 * - A missing episode answer fails that episode (`SavedRelationshipUnavailableError`); a missing series
 *   answer fails the lookup and is listed by `missing()`, which makes the saved comparison incomplete.
 * - A TMDB external-ID crosswalk applies the ADR-0004 replay decision against shared crosswalk evidence;
 *   a recovered answer is reported in `changes().recovered`, for the caller to save before resolving.
 * - Trakt searches are available when the saved relationships hold any Trakt answer.
 */
export function legacySavedComparisonEvidence({ ratingKey, relationships: saved, tvdbEpisodeImdbIds, reuseImdbIds, shared, failures }: {
  ratingKey: string;
  /** The comparison's saved relationships, with the series summaries the recheck supplies. */
  relationships: CrosswalkRelationships;
  tvdbEpisodeImdbIds?: Record<string, string[]>;
  /** The show has a TVDB series, so its saved IMDb episode IDs can be reused. */
  reuseImdbIds: boolean;
  /** Shared crosswalk evidence, read only. */
  shared: SharedCrosswalkStore["read"];
  /** The show's recorded lookup failures. */
  failures: LookupFailureRecord;
}): ComparisonEvidence & { missing(): string[] } {
  const relationships: CrosswalkRelationships = { ...saved };
  const missing = new Set<string>();
  /** Recovered crosswalk relationship keys, with the failed-request issue each resolves once saved. */
  const recovered = new Map<string, string>();

  async function answer(lookup: ProviderLookup) {
    const key = lookupKey(lookup);
    if (Object.hasOwn(relationships, key)) return { value: relationships[key].value, cached: true };
    if (EPISODE_LOOKUPS.has(lookup.kind)) throw new SavedRelationshipUnavailableError(lookup);
    missing.add(key);
    throw new Error(`Saved provider identity relationship is missing: ${key}`);
  }

  const { lookups, tvdbEpisodeImdbIds: imdbIds } = answeredEvidence({
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
  }, reuseImdbIds ? { ...tvdbEpisodeImdbIds } : {});
  return {
    ...lookups,
    traktAvailable: Object.values(saved).some((relationship) => relationship.provider === "Trakt"),
    rejectTmdbEpisodeCrosswalk() {},
    changes: () => ({
      relationships: structuredClone(relationships),
      tvdbEpisodeImdbIds: imdbIds(),
      recovered: { relationships: structuredClone(Object.fromEntries([...recovered.keys()].map((key) => [key, relationships[key]]))), resolves: [...recovered.values()] },
      retained: (savedRelationships) => ({ ...savedRelationships }),
    }),
    missing: () => [...missing],
  };
}
