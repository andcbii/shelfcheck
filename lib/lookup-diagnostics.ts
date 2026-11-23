import "server-only";
import { lookupFailureIssueId } from "@/lib/coverage-issue-ids";
import { providerLookupContext, resolveCoverageIssue, setCoverageIssue, type CoverageIssue, type LookupSourceStep } from "@/lib/coverage-issues";
import { lookupProvider, type ProviderLookup } from "@/lib/provider-lookup";
import type { ProviderEpisode } from "@/lib/plex-comparison";
import { TVDB_AUTHENTICATION_ISSUE } from "@/lib/provider-login-diagnostics";

/**
 * The comparison a lookup belongs to, as its failure diagnostics describe it: the show's identity,
 * its TVDB catalogue provenance and provider episodes, the lookup source chain that led to this
 * lookup (when one did) and the scan run's TVDB authentication error, if TVDB login failed.
 */
export type LookupComparisonContext = {
  ratingKey: string; title?: string; tmdbId?: number; tvdbId?: number;
  tvdbSource?: LookupSourceStep[]; tvdbCached?: boolean; providerEpisodes?: ProviderEpisode[];
  lookupSource?: LookupSourceStep[]; tvdbAuthenticationError?: unknown;
};

const IMPACT = "Episode identity and coverage could not be fully verified. Available last-good results were retained.";

/**
 * How one lookup kind's failure is described, or none: a series summary's failure raises no
 * lookup issue (its enclosing catalogue or comparison handling reports it).
 */
function failureDescription(lookup: ProviderLookup, context: LookupComparisonContext) {
  const provider = lookupProvider(lookup);
  const tvdbEpisode = (id: number) => {
    const known = context.providerEpisodes?.find(e => e.source === "TVDB" && e.providerEpisodeId === id);
    return {
      scope: "episode" as const,
      episode: {provider: "TVDB" as const, id, showId: context.tvdbId, ...(known ? {season: known.season, episode: known.episode, title: known.title} : {})},
      source: [...(context.tvdbSource || []), {provider: "TVDB" as const, kind: "catalogue episode", id, cached: context.tvdbCached}],
    };
  };
  switch (lookup.kind) {
    case "tmdb-episode-by-tvdb-episode":
      return {operation: "episode-identity", ...tvdbEpisode(lookup.tvdbEpisodeId), requested: {provider, kind: "external ID search", id: lookup.tvdbEpisodeId}};
    case "tvdb-episode-extended":
    case "trakt-episode-search-by-tvdb-episode":
      return {operation: "episode-identity", ...tvdbEpisode(lookup.tvdbEpisodeId), requested: {provider, kind: "episode", id: lookup.tvdbEpisodeId}};
    case "tmdb-series-by-tvdb-series":
      return {operation: "provider-association", scope: "show" as const, source: context.tvdbSource || [], requested: {provider, kind: "external ID search", id: lookup.tvdbSeriesId}};
    case "tmdb-episode-by-show-season-episode": {
      // A Trakt-validated episode names the TMDB episode ID it expects as the last source step.
      const expected = context.lookupSource?.at(-1);
      return {
        operation: "episode-identity", scope: "episode" as const,
        episode: {provider: "TMDB" as const, ...(expected?.kind === "external TMDB episode ID" ? {id: expected.id} : {}), showId: lookup.tmdbShowId, season: lookup.season, episode: lookup.episode},
        source: [] as LookupSourceStep[],
        requested: {provider, kind: `show ${lookup.tmdbShowId} season ${lookup.season} episode`, id: lookup.episode},
      };
    }
    case "tmdb-series-summary":
    case "tmdb-series-summary-with-external-ids":
    case "tvdb-series-summary":
      return undefined;
  }
}

/** Whether a lookup kind's failure raises a failed-request issue: a series summary's never does. */
function raisesLookupIssue(lookup: ProviderLookup) {
  return lookup.kind !== "tmdb-series-summary" && lookup.kind !== "tmdb-series-summary-with-external-ids" && lookup.kind !== "tvdb-series-summary";
}

/** One show comparison's lookup Coverage Issues, as an evidence source raises and resolves them. */
export type LookupDiagnostics = {
  /**
   * Records a failed request for a lookup. The error is only described, never replaced.
   * `lookupSource`: the source chain that led to this lookup, when it is not the comparison's own.
   */
  raiseFailure(lookup: ProviderLookup, error: unknown, lookupSource?: LookupSourceStep[]): void;
  /** A successful response resolves the lookup's failed request, whatever its answer then means. */
  resolve(lookup: ProviderLookup): void;
};

/**
 * Lookup Coverage Issues for one show comparison: the one place that raises and resolves a typed
 * lookup's failed-request issue. Plain transport has no typed lookup and never reaches it.
 */
export function lookupDiagnostics(comparison: LookupComparisonContext): LookupDiagnostics {
  return {
    raiseFailure(lookup, error, lookupSource = comparison.lookupSource) {
      const context = {...comparison, lookupSource};
      const described = failureDescription(lookup, context);
      if (!described) return;
      const provider = lookupProvider(lookup);
      const {operation, scope, source, requested} = described;
      const issue: CoverageIssue = {
        id: lookupFailureIssueId(context.ratingKey, lookup), failedAt: new Date().toISOString(),
        ...(provider === "TVDB" && error === context.tvdbAuthenticationError ? {causedBy: [TVDB_AUTHENTICATION_ISSUE]} : {}),
        operation, provider, scope,
        show: {ratingKey: context.ratingKey, title: context.title, tmdbId: context.tmdbId, tvdbId: context.tvdbId},
        ...("episode" in described ? {episode: described.episode} : {}),
        ...providerLookupContext(error, {source: context.lookupSource || source, requested, impact: IMPACT}),
      };
      setCoverageIssue(issue);
    },
    resolve(lookup) {
      if (raisesLookupIssue(lookup)) resolveCoverageIssue(lookupFailureIssueId(comparison.ratingKey, lookup));
    },
  };
}
