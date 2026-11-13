import { listCoverageIssues, resolveCoverageIssue, type CoverageIssue } from "@/lib/coverage-issues";
import "server-only";
import { randomUUID } from "node:crypto";
import { coverageDatabase } from "@/lib/sqlite";
import { reportMissingSelectionProblem, type CoverageEvidence, type CoverageMapping, type CoverageMember } from "@/lib/manual-coverage-model";
export class CoverageError extends Error {
  constructor(message: string, public status = 400, public code = "validation", public mappingId?: string) {
    super(message);
  }
}

export function coverageState() {
  const state = coverageDatabase().prepare("SELECT revision,pending FROM shelfcheck_coverage_state WHERE id=1").get() as {revision:number;pending:number};
  const issues = listCoverageIssues();
  if (state.pending) issues.push({id:"comparison-pending",operation:"comparison",scope:"library",cause:"Coverage changes need to be compared against the saved library inventory.",action:"Retry the comparison or run a Plex scan."} satisfies CoverageIssue);
  return {revision:state.revision,pending:issues.length ? 1 : 0,issues};
}

const memberKey = (member: { provider: string; id: number }) => `${member.provider}:${member.id}`;

// Mapping payloads describe members; Report Missing flags live on the membership rows.
function withFlags(db: ReturnType<typeof coverageDatabase>, mapping: CoverageMapping): CoverageMapping {
  const flagged = new Set((db.prepare("SELECT provider,episode_id FROM shelfcheck_coverage_members WHERE mapping_id=? AND report_missing=1").all(mapping.id) as { provider: string; episode_id: number }[]).map(row => `${row.provider}:${row.episode_id}`));
  return { ...mapping, members: mapping.members.map(member => ({ ...member, reportMissing: flagged.has(memberKey(member)) })) };
}

export function listCoverageMappings(): CoverageMapping[] {
  const db = coverageDatabase();
  return (db.prepare("SELECT payload FROM shelfcheck_coverage_mappings ORDER BY rowid").all() as {
    payload: string;
  }[]).map(row => withFlags(db, JSON.parse(row.payload)));
}

export function assertCoverageMutationAllowed() {
  if ((globalThis as typeof globalThis & {__shelfcheckPlexScan?:Promise<void>}).__shelfcheckPlexScan) throw new CoverageError("Wait for the current Plex scan to finish before changing Manual Matches.",409,"scan-active");
}

/** Explicit flags supplied with a save, or undefined to retain flags on retained members. */
function requestedFlags(value: unknown, members: CoverageMember[]): Set<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || !members.some(member => member.provider === item.provider && member.id === item.id)))
    throw new CoverageError("Report Missing can only be set on episodes in this Manual Match.");
  return new Set(value.map(memberKey));
}

/**
 * Save reviewed members, or with `members` undefined change only the saved
 * Report Missing flags of an existing mapping without new provider review.
 */
export function saveCoverageMapping(members: CoverageMember[] | undefined, edit?: { id: string; revision: number }, reportMissing?: unknown): CoverageMapping {
  assertCoverageMutationAllowed();
  if (members && (!members.some(m => m.provider === "TMDB") || !members.some(m => m.provider === "TVDB") || new Set(members.map(memberKey)).size !== members.length))
    throw new CoverageError("Review nonempty complete sets of distinct TMDB and TVDB episodes.");
  if (!members && (!edit || reportMissing === undefined))
    throw new CoverageError("Resolve and review both episode records before saving.");
  const db = coverageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    let existing: CoverageMapping | undefined;
    if (edit) {
      const row = db.prepare("SELECT payload FROM shelfcheck_coverage_mappings WHERE id=?").get(edit.id) as { payload: string } | undefined;
      if (!row) throw new CoverageError("This mapping was deleted. Reload the manager.", 404, "not-found", edit.id);
      existing = withFlags(db, JSON.parse(row.payload));
      if (!Number.isInteger(edit.revision) || edit.revision !== existing!.revision)
        throw new CoverageError("This mapping changed since you opened it. Reopen it and review the latest records.", 409, "stale-revision", edit.id);
    }
    const flagsOnly = !members;
    // Flags are stored on membership rows, never in the member descriptions.
    members = (members || existing!.members).map(member => { const description = { ...member }; delete description.reportMissing; return description; });
    const flags = requestedFlags(reportMissing, members) || new Set(existing?.members.filter(member => member.reportMissing).map(memberKey));
    for (const key of flags) if (!members.some(member => memberKey(member) === key)) flags.delete(key);
    // Every manual save, including membership edits that change the mapping's shape,
    // must leave a many-to-many mapping with flags on both sides or none. Nothing is
    // written before this check, so a rejected save leaves the saved state untouched.
    const selectionProblem = reportMissingSelectionProblem(members.map(member => ({ ...member, reportMissing: flags.has(memberKey(member)) })));
    if (selectionProblem) throw new CoverageError(selectionProblem, 400, "report-missing-one-sided", existing?.id);
    for (const m of members) {
      const row = db.prepare("SELECT mapping_id FROM shelfcheck_coverage_members WHERE provider=? AND episode_id=?").get(m.provider, m.id) as {
        mapping_id: string;
      } | undefined;
      if (row && row.mapping_id !== existing?.id)
        throw new CoverageError("This episode already belongs to a mapping. Open the existing mapping.", 409, "membership-conflict", row.mapping_id);
    }
    // A flag-only save reviews no provider records, so it keeps the saved health.
    const kept = flagsOnly && existing ? { ...(existing.health ? { health: existing.health } : {}), ...(existing.healthMessage ? { healthMessage: existing.healthMessage } : {}) } : {};
    const mapping: CoverageMapping = { id: existing?.id || randomUUID(), revision: coverageState().revision + 1, members, createdAt: existing?.createdAt || new Date().toISOString(), ...kept };
    db.prepare("INSERT INTO shelfcheck_coverage_mappings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(mapping.id, JSON.stringify(mapping));
    if (existing) db.prepare("DELETE FROM shelfcheck_coverage_members WHERE mapping_id=?").run(existing.id);
    for (const m of members)
      db.prepare("INSERT INTO shelfcheck_coverage_members(provider,episode_id,mapping_id,report_missing) VALUES(?,?,?,?)").run(m.provider, m.id, mapping.id, flags.has(memberKey(m)) ? 1 : 0);
    db.prepare("UPDATE shelfcheck_coverage_state SET revision=?,pending=1 WHERE id=1").run(mapping.revision);
    if (existing && !flagsOnly) for (const issue of listCoverageIssues().filter(issue=>issue.mappingId === existing.id)) resolveCoverageIssue(issue.id);
    db.exec("COMMIT");
    return withFlags(db, mapping);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteCoverageMapping(id: string) {
  const result = deleteCoverageMappings([id]);
  if (!result.deleted.length) throw new CoverageError("Mapping not found.", 404, "not-found");
  return id;
}

export function deleteCoverageMappings(ids: unknown): { deleted: string[]; missing: string[] } {
  assertCoverageMutationAllowed();
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.trim()))
    throw new CoverageError("Select explicit mapping identities to delete.");
  const db = coverageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const id of new Set<string>(ids)) {
      const result = db.prepare("DELETE FROM shelfcheck_coverage_mappings WHERE id=?").run(id);
      if (result.changes) for (const issue of listCoverageIssues().filter(issue=>issue.mappingId === id)) resolveCoverageIssue(issue.id);
      (result.changes ? deleted : missing).push(id);
    }
    if (deleted.length) db.exec("UPDATE shelfcheck_coverage_state SET revision=revision+1,pending=1 WHERE id=1");
    db.exec("COMMIT");
    return { deleted, missing };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveCoverageEvidence(evidence: CoverageEvidence[]) {
  coverageDatabase().prepare("INSERT INTO shelfcheck_coverage_evidence VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(evidence));
}

export function readCoverageEvidence(): CoverageEvidence[] {
  const row = coverageDatabase().prepare("SELECT payload FROM shelfcheck_coverage_evidence WHERE id=1").get() as {
    payload: string;
  } | undefined;
  return row ? JSON.parse(row.payload) : [];
}

export function completeCoverageRecheck(revision: number) {
  coverageDatabase().prepare("UPDATE shelfcheck_coverage_state SET pending=0 WHERE id=1 AND revision=?").run(revision);
}

export function beginCoverageRecheck(revision: number) {
  coverageDatabase().prepare("UPDATE shelfcheck_coverage_state SET pending=1 WHERE id=1 AND revision=?").run(revision);
}

// Lookup results must never overwrite a mapping repaired or deleted during an HTTP request.
export function updateCoverageHealth(snapshot: CoverageMapping, health: NonNullable<CoverageMapping["health"]>, healthMessage?: string) {
  const db = coverageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT payload FROM shelfcheck_coverage_mappings WHERE id=?").get(snapshot.id) as {payload:string} | undefined;
    const current: CoverageMapping | undefined = row && JSON.parse(row.payload);
    if (current && current.revision === snapshot.revision && ((current.health || "healthy") !== health || current.healthMessage !== healthMessage)) {
      const revision = coverageState().revision + 1;
      db.prepare("UPDATE shelfcheck_coverage_mappings SET payload=? WHERE id=?").run(JSON.stringify({...current, health, healthMessage, revision}), current.id);
      db.prepare("UPDATE shelfcheck_coverage_state SET revision=?,pending=1 WHERE id=1").run(revision);
    }
    db.exec("COMMIT");
  } catch(error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
