import type { CoverageIssue } from "@/lib/coverage-issues";
import type { PlexShowResult } from "@/lib/plex-scan";

const PROVIDER_NAMES = ["TMDB", "TVDB"] as const;

/** An Unmatched show's own show-scoped Coverage Issue IDs: each provider's catalogue refresh and its comparison inputs. */
function ownEntryIds(ratingKey: string) {
  return [
    ...PROVIDER_NAMES.flatMap(name => [`catalogue-refresh:${name}:${ratingKey}`, `catalogue-fallback-refresh:${name}:${ratingKey}`]),
    `comparison-inputs:${ratingKey}`,
  ];
}

/**
 * The Scan Issues entries shown for the current Coverage Issues (ADR-0006). A show judged an Unmatched
 * show has its own show-scoped catalogue-refresh, catalogue-fallback-refresh and comparison-inputs
 * entries hidden, since its Unmatched Shows row gives each provider's cause. This is a projection only:
 * no issue is deleted or resolved, and library-wide or shared root causes stay visible with every
 * impact folded into them. The Scan Issues count is the length of what this returns.
 */
export function shownScanIssues<I extends Pick<CoverageIssue, "id" | "scope">>(issues: I[], shows: Pick<PlexShowResult, "ratingKey" | "providerResolution">[]): I[] {
  const hidden = new Set(shows.filter(show => show.providerResolution?.status === "unmatched").flatMap(show => ownEntryIds(show.ratingKey)));
  return hidden.size ? issues.filter(issue => issue.scope !== "show" || !hidden.has(issue.id)) : issues;
}
