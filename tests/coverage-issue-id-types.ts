/**
 * Compile-only checks of the Coverage Issue ID contract (SHELFCHECK-160). `next build` and `tsc`
 * type-check this file; it is outside the runtime test glob (`tests/**\/*.test.ts`), the app never
 * imports it, and nothing in it runs. Each `@ts-expect-error` must stay an error: if the ID or prefix
 * type is weakened to a plain string, the directive goes unused and the build fails.
 */
import {
  TVDB_AUTHENTICATION_ISSUE, episodeCheckShowPrefix, lookupFailureIssueId, titleRecoveryIssueId,
  type CoverageIssueId, type CoverageIssuePrefix,
} from "@/lib/coverage-issue-ids";
import { coverageIssueIdsWithPrefix, getCoverageIssue, resolveCoverageIssue, type CoverageIssue } from "@/lib/coverage-issues";
import { lookupKey, type ProviderLookup } from "@/lib/provider-lookup";

/** Never called: its body only states what the compiler accepts and rejects. */
export function coverageIssueIdContract(rawId: string, lookup: ProviderLookup, prefix: CoverageIssuePrefix, id: CoverageIssueId) {
  const issue = { operation: "comparison", scope: "show", cause: "", action: "" } as const;

  // Valid uses: IDs and prefixes come from the vocabulary's constructors.
  const valid: CoverageIssue = { ...issue, id: titleRecoveryIssueId("4412", 1), causedBy: [TVDB_AUTHENTICATION_ISSUE, lookupFailureIssueId("4412", lookup)] };
  getCoverageIssue(valid.id);
  resolveCoverageIssue(TVDB_AUTHENTICATION_ISSUE);
  const selected: CoverageIssueId[] = coverageIssueIdsWithPrefix(episodeCheckShowPrefix("4412"));
  const asText: string = id;

  // A raw string or lookup key cannot be an issue ID.
  // @ts-expect-error a raw string is not a Coverage Issue ID
  const rawIssue: CoverageIssue = { ...issue, id: rawId };
  // @ts-expect-error a string literal is not a Coverage Issue ID
  const literalIssue: CoverageIssue = { ...issue, id: "provider-authentication:TVDB" };
  // @ts-expect-error a raw string is not a cause link
  const rawCause: CoverageIssue = { ...issue, id, causedBy: [rawId] };
  // @ts-expect-error a lookup key is not a cause link
  const lookupCause: CoverageIssue = { ...issue, id, causedBy: [lookupKey(lookup)] };
  // @ts-expect-error a raw string cannot be read as an issue
  getCoverageIssue(rawId);
  // @ts-expect-error a lookup key cannot be read as an issue
  getCoverageIssue(lookupKey(lookup));
  // @ts-expect-error a raw string cannot be resolved
  resolveCoverageIssue(rawId);

  // A prefix cannot be an issue ID.
  // @ts-expect-error a prefix is not a Coverage Issue ID
  const prefixIssue: CoverageIssue = { ...issue, id: prefix };
  // @ts-expect-error a prefix is not a cause link
  const prefixCause: CoverageIssue = { ...issue, id, causedBy: [prefix] };
  // @ts-expect-error a prefix cannot be read as an issue
  getCoverageIssue(prefix);
  // @ts-expect-error a prefix cannot be resolved
  resolveCoverageIssue(prefix);

  // An ID, or a raw string, cannot be a prefix.
  // @ts-expect-error an issue ID is not a prefix
  coverageIssueIdsWithPrefix(id);
  // @ts-expect-error a raw string is not a prefix
  coverageIssueIdsWithPrefix(rawId);
  // @ts-expect-error the prefix query's results are IDs, not prefixes
  const selectedPrefixes: CoverageIssuePrefix[] = coverageIssueIdsWithPrefix(prefix);

  return [selected, asText, rawIssue, literalIssue, rawCause, lookupCause, prefixIssue, prefixCause, selectedPrefixes];
}
