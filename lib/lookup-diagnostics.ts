import "server-only";
import { providerLookupContext, resolveCoverageIssue, setCoverageIssue, type CoverageIssue, type LookupSourceStep } from "@/lib/coverage-issues";
import { lookupKey, lookupProvider, type ProviderLookup } from "@/lib/provider-lookup";
import type { ProviderEpisode } from "@/lib/plex-comparison";

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

const TVDB_AUTHENTICATION_ISSUE = "provider-authentication:TVDB";
const TRAKT_AUTHENTICATION_ISSUE = "provider-authentication:Trakt";
const IMPACT = "Episode identity and coverage could not be fully verified. Available last-good results were retained.";

/** The `episode-identity:` Coverage Issue ID of one show's failed request for a typed lookup. */
export function lookupFailureIssueId(ratingKey: string, lookup: ProviderLookup) {
  return `episode-identity:${ratingKey}:${lookupKey(lookup)}`;
}

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

/**
 * Lookup Coverage Issues for one show comparison: the one place that raises and resolves a typed
 * lookup's failed-request issue. Plain transport has no typed lookup and never reaches it.
 */
export function lookupDiagnostics(context: LookupComparisonContext) {
  return {
    /** Records a failed request for a lookup. The error is only described, never replaced. */
    raiseFailure(lookup: ProviderLookup, error: unknown) {
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
    /** A successful response resolves the lookup's failed request, whatever its answer then means. */
    resolve(lookup: ProviderLookup) {
      if (failureDescription(lookup, context)) resolveCoverageIssue(lookupFailureIssueId(context.ratingKey, lookup));
    },
  };
}

/**
 * The scan run's Trakt login: one library-scoped issue for a login that cannot be recovered, not
 * one per Trakt lookup it stops; resolved only when Trakt answers again or is not configured.
 */
export const traktLoginDiagnostics = {
  raiseFailure(error: unknown) {
    setCoverageIssue({id: TRAKT_AUTHENTICATION_ISSUE, operation: "provider-authentication", provider: "Trakt", scope: "library", ...providerLookupContext(error, {source: [], requested: {provider: "Trakt", kind: "authentication"}, impact: "Trakt episode identity checks could not be verified. TMDB fallback checks remain available."})});
  },
  resolve() { resolveCoverageIssue(TRAKT_AUTHENTICATION_ISSUE); },
};
