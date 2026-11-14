import "server-only";
import { coverageDatabase } from "@/lib/sqlite";
import { ProviderHttpError, ProviderCooldownTooLongError, ProviderNetworkError, ProviderResponseError } from "@/lib/plex-provider-client";

export type LookupSourceStep = { provider: "Plex" | "TMDB" | "TVDB" | "Trakt"; kind: string; id?: number; cached?: boolean };
export type ProviderLookup = {
  source: LookupSourceStep[];
  requested?: { provider: LookupSourceStep["provider"]; kind: string; id?: number };
  status?: number;
  failureKind: "http" | "network" | "invalid-response" | "rate-limit";
  impact: string;
};

/** Store only selected identities and typed evidence, never raw request URLs or errors. */
export function providerLookupContext(error: unknown, context: Omit<ProviderLookup, "status" | "failureKind">): Pick<CoverageIssue, "category" | "lookup" | "cause" | "action"> {
  if ((error instanceof ProviderHttpError || error instanceof ProviderNetworkError || error instanceof ProviderResponseError) && error.requested) context = {...context,requested:error.requested};
  const status = error instanceof ProviderHttpError ? error.status : undefined;
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
  id: string;
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
  /** Failure IDs captured when this operation establishes its blocked inputs. */
  causedBy?: string[];
  /** Dependent impacts projected from the same durable current issue state. */
  impacts?: string[];
  show?: { ratingKey?: string; title?: string; tmdbId?: number; tvdbId?: number };
  episode?: { provider?: "TMDB" | "TVDB"; id?: number; showId?: number; season?: number; episode?: number; title?: string };
  mappingId?: string;
};
function store() {
  const db = coverageDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS shelfcheck_coverage_issues(id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  return db;
}
export function listCoverageIssues(): CoverageIssue[] {
  const issues: CoverageIssue[] = (store().prepare("SELECT payload FROM shelfcheck_coverage_issues ORDER BY id").all() as {payload:string}[]).map(row=>JSON.parse(row.payload));
  const byId = new Map(issues.map(issue=>[issue.id,issue]));
  // A dependent issue's own recorded impacts travel with it into its root, never impacts folded into it here.
  const ownImpacts = new Map(issues.map(issue=>[issue.id,issue.impacts || []]));
  const rootsFor = (id:string, seen:Set<string>): CoverageIssue[] | undefined => {
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
export function getCoverageIssue(id: string): CoverageIssue | undefined {
  const row = store().prepare("SELECT payload FROM shelfcheck_coverage_issues WHERE id=?").get(id) as {payload:string} | undefined;
  return row ? JSON.parse(row.payload) : undefined;
}
export function setCoverageIssue(issue: CoverageIssue) {
  store().prepare("INSERT INTO shelfcheck_coverage_issues VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(issue.id,JSON.stringify(issue));
}
/** Current cause IDs owned by one operation family, e.g. one show's episode checks. */
export function coverageIssueIdsWithPrefix(prefix: string): string[] {
  return (store().prepare("SELECT id FROM shelfcheck_coverage_issues WHERE substr(id,1,length(?))=? ORDER BY id").all(prefix,prefix) as {id:string}[]).map(row=>row.id);
}
export function resolveCoverageIssue(id: string) { store().prepare("DELETE FROM shelfcheck_coverage_issues WHERE id=?").run(id); }
export { coverageIssueCause } from "@/lib/value-guards";
