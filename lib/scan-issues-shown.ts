import { catalogueIssueIds, PROVIDERS } from "@/lib/catalogue-selection";
import type { CoverageIssue } from "@/lib/coverage-issues";
import { isUnmatchedShow } from "@/lib/plex-reporting";
import type { PlexShowResult } from "@/lib/plex-scan";

/** An Unmatched show's own show-scoped Coverage Issue IDs: each provider's catalogue refresh and its comparison inputs. */
function ownEntryIds(ratingKey: string) {
  return [
    ...PROVIDERS.flatMap(provider => Object.values(catalogueIssueIds(provider, ratingKey))),
    `comparison-inputs:${ratingKey}`,
  ];
}

/**
 * The Scan Issues entries shown for the current Coverage Issues (ADR-0006). A show listed in Unmatched
 * Shows has its own show-scoped catalogue-refresh, catalogue-fallback-refresh and comparison-inputs
 * entries hidden, since its Unmatched Shows row gives each provider's cause. This is a projection only:
 * no issue is deleted or resolved, and library-wide or shared root causes stay visible with every
 * impact folded into them. Every Scan Issues count is the length of what this returns.
 */
export function shownScanIssues<I extends Pick<CoverageIssue, "id" | "scope">>(issues: I[], shows: Pick<PlexShowResult, "ratingKey" | "providerResolution">[]): I[] {
  const hidden = new Set(shows.filter(isUnmatchedShow).flatMap(show => ownEntryIds(show.ratingKey)));
  return hidden.size ? issues.filter(issue => issue.scope !== "show" || !hidden.has(issue.id)) : issues;
}
