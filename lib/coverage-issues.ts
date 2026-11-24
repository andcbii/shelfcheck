import "server-only";
import { database } from "@/lib/sqlite";
import { ProviderHttpError, ProviderCooldownTooLongError, ProviderNetworkError, ProviderResponseError } from "@/lib/provider-client";
import type { CoverageIssueId, CoverageIssuePrefix } from "@/lib/coverage-issue-ids";

export type LookupSourceStep = { provider: "Plex" | "TMDB" | "TVDB" | "Trakt"; kind: string; id?: number; cached?: boolean };
export type ProviderLookup = {
  source: LookupSourceStep[];
  requested?: { provider: LookupSourceStep["provider"]; kind: string; id?: number };
  status?: number;
  /** `missing-id`: no series ID to look up, from Plex or through the other provider. */
  failureKind: "http" | "network" | "invalid-response" | "rate-limit" | "missing-id";
  impact: string;
};

/** Store only selected identities and typed evidence, never raw request URLs or errors. */
export function providerLookupContext(error: unknown, context: Omit<ProviderLookup, "status" | "failureKind">): Pick<CoverageIssue, "category" | "lookup" | "cause" | "action"> {
  if ((error instanceof ProviderHttpError || error instanceof ProviderNetworkError || error instanceof ProviderResponseError || error instanceof ProviderCooldownTooLongError) && error.requested) context = {...context,requested:error.requested};
  // A server error's long wait keeps its HTTP status; only a rate-limit cooldown reads as a rate limit.
  const status = error instanceof ProviderHttpError ? error.status : error instanceof ProviderCooldownTooLongError && error.reason === "server" ? error.status : undefined;
  const failureKind = status !== undefined ? "http" : error instanceof ProviderCooldownTooLongError ? "rate-limit" : error instanceof TypeError || error instanceof Error && /network|fetch|request failed after retries|timeout/i.test(error.message) ? "network" : "invalid-response";
  const provider = context.requested?.provider || "Provider";
  const source = context.source.at(-1);
  const reference = source?.provider === "TMDB" && source.kind === "external TVDB ID" ? "TMDB's external ID reference" : source?.provider === "Plex" ? "the Plex provider ID reference" : "the recorded source reference";
  return {
    category: "Provider Lookup", lookup: {...context, ...(status !== undefined ? {status} : {}), failureKind},
    cause: status === 404 ? "404 — record not found" : status !== undefined ? `${status} — ${provider} request failed` : failureKind === "network" ? `${provider} network request failed` : failureKind === "rate-limit" ? `${provider} rate limit prevented verification` : `${provider} returned an incomplete or unreadable response`,
    action: status === 404 ? `Check ${reference}; retry after checking or correcting the reference.` : status === 401 || status === 403 ? `Check ${provider} credentials or permissions, then retry the Plex scan.` : `Retry the Plex scan after ${provider} availability recovers.`,
  };
}

/** One current cause, owned and resolved only by the operation that evaluated it. */
export type CoverageIssue = {
  id: CoverageIssueId;
  operation: string;
  provider?: "Plex" | "TMDB" | "TVDB" | "Trakt";
  scope: "library" | "show" | "episode";
  cause: string;
  action: string;
  /** Provider Lookup: a request or response failed. Episode Matching: a check over available evidence failed. Provider Catalogue: an individual catalogue record was unusable. */
  category?: "Provider Lookup" | "Episode Matching" | "Provider Catalogue";
  lookup?: ProviderLookup;
  /** Provider Lookup: when this request last failed (ISO time). Absent on causes recorded before it was kept. */
  failedAt?: string;
  /** A provider choosing among several Plex series whose preferred series failed: each candidate that failed, why, and its catalogue age and 404 progress, in the order tried. */
  candidates?: { id: number; cause: string; catalogueRefresh?: CatalogueRefreshState }[];
  /** Failure IDs captured when this operation establishes its blocked inputs. */
  causedBy?: CoverageIssueId[];
  /** Dependent impacts projected from the same durable current issue state. */
  impacts?: string[];
  show?: { ratingKey?: string; title?: string; tmdbId?: number; tvdbId?: number };
  episode?: { provider?: "TMDB" | "TVDB"; id?: number; showId?: number; season?: number; episode?: number; title?: string };
  mappingId?: string;
  /** Catalogue-refresh issues: the age and 404 progress of the catalogue in use, else of the failed series (ADR-0006). */
  catalogueRefresh?: CatalogueRefreshState;
};
/** A failed catalogue refresh's state as of the resolution that recorded it. Times are ISO strings. */
export type CatalogueRefreshState = {
  /** When the refresh was attempted: the resolution time (a scan's start). */
  checkedAt: string;
  /** The series' last complete catalogue download; absent when it was never downloaded. */
  downloadedAt?: string;
  /** When the series request itself answered 404 (this one included), or the series is gone: its counted 404 days. */
  seriesNotFoundDays?: number;
  /** The series is a Gone provider record (ADR-0006): its saved catalogue is kept but not compared. */
  gone?: true;
};
/**
 * The storage boundary for Coverage Issue IDs: an ID or cause link read back from saved data is
 * adopted exactly as it was saved. It is not checked against today's kinds and never dropped, so
 * issues and cause links saved by earlier versions, including kinds no longer produced, keep loading,
 * showing and folding. Private: application code makes IDs only with the vocabulary's constructors
 * (`@/lib/coverage-issue-ids`), never from text.
 */
function adoptStoredId(saved: string) {
  return saved as CoverageIssueId;
}
/** A saved Coverage Issue payload, with its ID and cause links adopted at the storage boundary. */
function storedIssue(payload: string): CoverageIssue {
  const issue = JSON.parse(payload);
  // A payload that is not an object is returned as it was read, as before adoption.
  if (typeof issue !== "object" || issue === null || Array.isArray(issue)) return issue;
  return { ...issue, ...("id" in issue ? { id: adoptStoredId(issue.id) } : {}), ...(Array.isArray(issue.causedBy) ? { causedBy: issue.causedBy.map(adoptStoredId) } : {}) };
}
/**
 * The cause links of a carrier saved outside the issue table (such as a saved catalogue's title
 * recovery), adopted at the storage boundary like the issue table's: every string is kept as saved.
 * For storage reads only; lint limits who may call it.
 */
export function savedCoverageIssueIds(saved: unknown[]): CoverageIssueId[] {
  return saved.filter((item): item is string => typeof item === "string").map(adoptStoredId);
}
export function listCoverageIssues(): CoverageIssue[] {
  const issues: CoverageIssue[] = (database().prepare("SELECT payload FROM shelfcheck_coverage_issues ORDER BY id").all() as {payload:string}[]).map(row=>storedIssue(row.payload));
  const byId = new Map(issues.map(issue=>[issue.id,issue]));
  // A dependent issue's own recorded impacts travel with it into its root, never impacts folded into it here.
  const ownImpacts = new Map(issues.map(issue=>[issue.id,issue.impacts || []]));
  const rootsFor = (id:CoverageIssueId, seen:Set<CoverageIssueId>): CoverageIssue[] | undefined => {
    const issue = byId.get(id);
    if (!issue || seen.has(id)) return undefined;
    if (!issue.causedBy?.length) return [issue];
    const next = new Set([...seen,id]);
    const parents = issue.causedBy.map(parent=>rootsFor(parent,next));
    return parents.every(parent=>parent !== undefined) ? parents.flat() : undefined;
  };
  return issues.filter(issue=>{
    // Legacy issues and missing causes remain visible; never guess from show IDs.
    if (!issue.causedBy?.length) return true;
    const roots = rootsFor(issue.id,new Set());
    if (!roots) return true;
    const impact = `${issue.show?.title ? `${issue.show.title}: ` : ""}${issue.cause}${issue.lookup ? ` ${issue.lookup.impact}` : ""}${ownImpacts.get(issue.id)!.map(item=>` ${item}`).join("")}`;
    for (const root of roots) {
      root.impacts = [...new Set([...(root.impacts || []),impact])];
    }
    return false;
  });
}
export function getCoverageIssue(id: CoverageIssueId): CoverageIssue | undefined {
  const row = database().prepare("SELECT payload FROM shelfcheck_coverage_issues WHERE id=?").get(id) as {payload:string} | undefined;
  return row ? storedIssue(row.payload) : undefined;
}
export function setCoverageIssue(issue: CoverageIssue) {
  database().prepare("INSERT INTO shelfcheck_coverage_issues VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(issue.id,JSON.stringify(issue));
}
/** Current cause IDs owned by one operation family, e.g. one show's episode checks: an exact, case-sensitive prefix match. */
export function coverageIssueIdsWithPrefix(prefix: CoverageIssuePrefix): CoverageIssueId[] {
  return (database().prepare("SELECT id FROM shelfcheck_coverage_issues WHERE substr(id,1,length(?))=? ORDER BY id").all(prefix,prefix) as {id:string}[]).map(row=>adoptStoredId(row.id));
}
export function resolveCoverageIssue(id: CoverageIssueId) { database().prepare("DELETE FROM shelfcheck_coverage_issues WHERE id=?").run(id); }
/**
 * Resolves a cause an operation made unnecessary, unless another current cause still names it in
 * `causedBy`: a root stays while any dependent remains.
 */
export function resolveCoverageIssueWithoutDependents(id: CoverageIssueId) {
  database().prepare("DELETE FROM shelfcheck_coverage_issues WHERE id=? AND NOT EXISTS (SELECT 1 FROM shelfcheck_coverage_issues AS dependent, json_each(dependent.payload,'$.causedBy') AS parent WHERE parent.value=?)").run(id,id);
}
export { coverageIssueCause } from "@/lib/value-guards";
