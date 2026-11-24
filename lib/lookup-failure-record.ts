import "server-only";
import { getCoverageIssue } from "@/lib/coverage-issues";
import { recordedEpisodeCrosswalkFailures } from "@/lib/episode-check-issues";
import { lookupFailureIssueId } from "@/lib/coverage-issue-ids";
import type { ProviderLookup } from "@/lib/provider-lookup";
import type { EpisodeCrosswalk } from "@/lib/plex-comparison";

/**
 * A typed lookup's failed-request Coverage Issue is open. `failedAt` is absent on an issue recorded
 * before failure times were kept: it is still open, unlike no recorded failure at all.
 */
export type RecordedLookupFailure = { open: true; failedAt?: string };
/** One TVDB episode's crosswalk recorded as failed for a show, by an earlier comparison. */
export type RecordedEpisodeCrosswalkFailure = { crosswalk: EpisodeCrosswalk; tvdbEpisodeId: number };

/**
 * Read port for one show's recorded lookup failures. It reports facts only: it decides no
 * freshness or replay, persists no recovery and resolves no issue.
 */
export type LookupFailureRecord = {
  /** The show's open failed-request issue for this lookup, or none. */
  failure(lookup: ProviderLookup): RecordedLookupFailure | undefined;
  /** The show's recorded episode crosswalk failures: retried on the next live scan, carried when not checked again. */
  episodeCrosswalkFailures(): RecordedEpisodeCrosswalkFailure[];
};

/** The read port over one show's Coverage Issues. */
export function lookupFailureRecord(ratingKey: string): LookupFailureRecord {
  return {
    failure(lookup) {
      const issue = getCoverageIssue(lookupFailureIssueId(ratingKey, lookup));
      return issue ? { open: true, ...(issue.failedAt !== undefined ? { failedAt: issue.failedAt } : {}) } : undefined;
    },
    episodeCrosswalkFailures() {
      return recordedEpisodeCrosswalkFailures(ratingKey);
    },
  };
}
