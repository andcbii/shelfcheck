import type { DatabaseSync } from "node:sqlite";

/** A Coverage Issue payload as the issue table holds it: its ID and cause links are plain saved text. */
export type StoredCoverageIssue = { id: string; causedBy?: string[] } & Record<string, unknown>;

/**
 * Seed Coverage Issues as saved payloads, the way the database migration tests do, for IDs a test
 * writes out itself: historical or unknown kinds, or literal IDs kept independent of the vocabulary.
 * The app adopts them when it reads the issue table, as it does any ID saved by an earlier version.
 */
export function seedStoredCoverageIssues(db: DatabaseSync, ...issues: StoredCoverageIssue[]) {
  const insert = db.prepare("INSERT INTO shelfcheck_coverage_issues VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload");
  for (const issue of issues) insert.run(issue.id, JSON.stringify(issue));
}
