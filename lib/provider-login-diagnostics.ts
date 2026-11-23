import "server-only";
import { providerLookupContext, resolveCoverageIssue, setCoverageIssue } from "@/lib/coverage-issues";

/** The scan run's TVDB login issue: the cause linked from TVDB requests that failed because of it. */
export const TVDB_AUTHENTICATION_ISSUE = "provider-authentication:TVDB";
const TRAKT_AUTHENTICATION_ISSUE = "provider-authentication:Trakt";

/** One provider's scan-run login issue: library-scoped, raised once however many requests it stops. */
function providerLoginDiagnostics(provider: "TVDB" | "Trakt", id: string, impact: string) {
  return {
    raiseFailure(error: unknown) {
      setCoverageIssue({id, operation: "provider-authentication", provider, scope: "library", ...providerLookupContext(error, {source: [], requested: {provider, kind: "authentication"}, impact})});
    },
    resolve() { resolveCoverageIssue(id); },
  };
}

/** The scan run's TVDB login: resolved when TVDB login succeeds. */
export const tvdbLoginDiagnostics = providerLoginDiagnostics("TVDB", TVDB_AUTHENTICATION_ISSUE, "TVDB catalogue downloads and freshness could not be verified. Available last-good data was retained.");

/**
 * The scan run's Trakt login: one issue for a login that cannot be recovered, not one per Trakt
 * lookup it stops; resolved only when Trakt answers again or is not configured.
 */
export const traktLoginDiagnostics = providerLoginDiagnostics("Trakt", TRAKT_AUTHENTICATION_ISSUE, "Trakt episode identity checks could not be verified. TMDB fallback checks remain available.");
