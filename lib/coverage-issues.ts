import "server-only";
import { coverageDatabase } from "@/lib/sqlite";

/** One current cause, owned and resolved only by the operation that evaluated it. */
export type CoverageIssue = {
  id: string;
  operation: string;
  provider?: "Plex" | "TMDB" | "TVDB" | "Trakt";
  scope: "library" | "show" | "episode";
  cause: string;
  action: string;
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
