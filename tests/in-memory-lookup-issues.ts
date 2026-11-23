import type { LookupSourceStep } from "../lib/coverage-issues";
import type { LookupDiagnostics } from "../lib/lookup-diagnostics";
import type { LookupFailureRecord, RecordedEpisodeCrosswalkFailure } from "../lib/lookup-failure-record";
import { lookupKey, type ProviderLookup } from "../lib/provider-lookup";

/** One raised failed request, as the in-memory diagnostics adapter received it. */
export type RaisedLookupFailure = { lookup?: ProviderLookup; error?: unknown; lookupSource?: LookupSourceStep[]; failedAt?: string };

/**
 * One show's lookup Coverage Issues held in memory: an evidence source's read port and diagnostics
 * adapter over the same open failed requests, by relationship key. It records what the source raises
 * and resolves; how each failure is described (and which kinds raise none) is the real adapter's rule.
 */
export function inMemoryLookupIssues(options: { crosswalkFailures?: RecordedEpisodeCrosswalkFailure[]; now?: () => string } = {}) {
  const open = new Map<string, RaisedLookupFailure>();
  const failures: LookupFailureRecord = {
    failure(lookup) {
      const issue = open.get(lookupKey(lookup));
      return issue ? { open: true, ...(issue.failedAt !== undefined ? { failedAt: issue.failedAt } : {}) } : undefined;
    },
    episodeCrosswalkFailures: () => [...(options.crosswalkFailures || [])],
  };
  const diagnostics: LookupDiagnostics = {
    raiseFailure(lookup, error, lookupSource) { open.set(lookupKey(lookup), { lookup, error, lookupSource, failedAt: options.now?.() }); },
    resolve(lookup) { open.delete(lookupKey(lookup)); },
  };
  return {
    /** Open failed requests by relationship key. Set one to record an earlier scan's failure. */
    open, failures, diagnostics,
  };
}

/** The scan run's Trakt login issue held in memory. */
export function inMemoryTraktLogin() {
  const login = {
    failed: false as boolean,
    raiseFailure() { login.failed = true; },
    resolve() { login.failed = false; },
  };
  return login;
}
