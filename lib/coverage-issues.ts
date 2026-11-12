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
  category?: "Provider Lookup";
  lookup?: ProviderLookup;
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
  return (store().prepare("SELECT payload FROM shelfcheck_coverage_issues ORDER BY id").all() as {payload:string}[]).map(row=>JSON.parse(row.payload));
}
export function getCoverageIssue(id: string): CoverageIssue | undefined {
  const row = store().prepare("SELECT payload FROM shelfcheck_coverage_issues WHERE id=?").get(id) as {payload:string} | undefined;
  return row ? JSON.parse(row.payload) : undefined;
}
export function setCoverageIssue(issue: CoverageIssue) {
  store().prepare("INSERT INTO shelfcheck_coverage_issues VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(issue.id,JSON.stringify(issue));
}
export function resolveCoverageIssue(id: string) { store().prepare("DELETE FROM shelfcheck_coverage_issues WHERE id=?").run(id); }
export function coverageIssueCause(error: unknown) { return error instanceof Error ? error.message : String(error); }
