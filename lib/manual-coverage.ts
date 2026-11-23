import { listCoverageIssues, resolveCoverageIssue, type CoverageIssue } from "@/lib/coverage-issues";
import { isPlexScanActive } from "@/lib/plex-scan-active";
import "server-only";
import { randomUUID } from "node:crypto";
import { database } from "@/lib/sqlite";
import { memberKey, reportMissingSelectionProblem, type CoverageEvidence, type CoverageIdentity, type CoverageMapping, type CoverageMember } from "@/lib/manual-coverage-model";
export class CoverageError extends Error {
  constructor(message: string, public status = 400, public code = "validation", public mappingId?: string) {
    super(message);
  }
}

export function coverageState() {
  const state = database().prepare("SELECT revision,pending FROM shelfcheck_coverage_state WHERE id=1").get() as {revision:number;pending:number};
  const issues = listCoverageIssues();
  if (state.pending) issues.push({id:"comparison-pending",operation:"comparison",scope:"library",cause:"Coverage changes need to be compared against the saved library inventory.",action:"Retry the comparison or run a Plex scan."} satisfies CoverageIssue);
  return {revision:state.revision,pending:issues.length ? 1 : 0,issues};
}

// Mapping payloads describe members; Report Missing flags live on the membership rows.
function flaggedMembers(db: ReturnType<typeof database>, mappingId?: string): Set<string> {
  const rows = (mappingId === undefined
    ? db.prepare("SELECT mapping_id,provider,episode_id FROM shelfcheck_coverage_members WHERE report_missing=1").all()
    : db.prepare("SELECT mapping_id,provider,episode_id FROM shelfcheck_coverage_members WHERE mapping_id=? AND report_missing=1").all(mappingId)) as { mapping_id: string; provider: string; episode_id: number }[];
  return new Set(rows.map(row => `${row.mapping_id}|${row.provider}:${row.episode_id}`));
}
// The needs-review message a health recheck saves when a provider episode record is gone.
export const MISSING_MEMBER_MESSAGE = "A provider episode record was not found. Resolve and review replacements to repair this Manual Match.";
// The same message as saved before it said Manual Match. Rechecks skip needs-review matches, so it
// stays stored until the match is repaired; reading shows the current wording instead.
const LEGACY_MISSING_MEMBER_MESSAGE = "A provider episode record was not found. Resolve and review replacements to repair this mapping.";
function withFlags(db: ReturnType<typeof database>, mapping: CoverageMapping, flagged = flaggedMembers(db, mapping.id)): CoverageMapping {
  if (mapping.healthMessage === LEGACY_MISSING_MEMBER_MESSAGE) mapping = { ...mapping, healthMessage: MISSING_MEMBER_MESSAGE };
  return { ...mapping, members: mapping.members.map(member => ({ ...member, reportMissing: flagged.has(`${mapping.id}|${memberKey(member)}`) })) };
}

export function listCoverageMappings(): CoverageMapping[] {
  const db = database();
  // One query for every flag, not one per mapping.
  const flagged = flaggedMembers(db);
  return (db.prepare("SELECT payload FROM shelfcheck_coverage_mappings ORDER BY rowid").all() as {
    payload: string;
  }[]).map(row => withFlags(db, JSON.parse(row.payload), flagged));
}

export function assertCoverageMutationAllowed() {
  if (isPlexScanActive()) throw new CoverageError("Wait for the current Plex scan to finish before changing Manual Matches.",409,"scan-active");
}

/** Explicit flags supplied with a save, or undefined to retain flags on retained members. */
function requestedFlags(value: unknown, members: CoverageMember[]): Set<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || !members.some(member => member.provider === item.provider && member.id === item.id)))
    throw new CoverageError("Report Missing can only be set on episodes in this Manual Match.");
  return new Set(value.map(memberKey));
}

/** The saved payload of one Manual Match (without its Report Missing flags), or undefined when there is none. */
function savedManualMatch(db: ReturnType<typeof database>, id: string): CoverageMapping | undefined {
  const row = db.prepare("SELECT payload FROM shelfcheck_coverage_mappings WHERE id=?").get(id) as { payload: string } | undefined;
  return row && JSON.parse(row.payload);
}

/**
 * The Manual Match an edit changes, and the revision its editor opened. The
 * revision is as the request sent it; the store checks it inside its transaction.
 */
export type ManualMatchEdit = { id: string; revision: unknown };

/**
 * Members a Manual Match change affects, each once per show: their shows need a
 * cached recheck. An edit can keep an episode ID but move it to another show, so
 * the former and the new show placement are both kept.
 */
function distinctMembers(members: CoverageMember[]): CoverageMember[] {
  const seen = new Map<string, CoverageMember>();
  for (const member of members) {
    const key = `${memberKey(member)}:${member.showId}`;
    if (!seen.has(key)) seen.set(key, member);
  }
  return [...seen.values()];
}

/**
 * Save reviewed members, or with `members` undefined change only the saved
 * Report Missing flags of an existing mapping without new provider review.
 * Returns the saved mapping with its flags, and the members the save affects
 * (the former and the new members; every member for a flag-only edit), both
 * read inside the save's transaction. The scan check inside that transaction
 * is authoritative.
 */
export function saveCoverageMapping(members: CoverageMember[] | undefined, edit?: ManualMatchEdit, reportMissing?: unknown): { mapping: CoverageMapping; affectedMembers: CoverageMember[] } {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    assertCoverageMutationAllowed();
    if (members && (!members.some(m => m.provider === "TMDB") || !members.some(m => m.provider === "TVDB") || new Set(members.map(memberKey)).size !== members.length))
      throw new CoverageError("Review nonempty complete sets of distinct TMDB and TVDB episodes.");
    if (!members && (!edit || reportMissing === undefined))
      throw new CoverageError("Resolve and review both episode records before saving.");
    let existing: CoverageMapping | undefined;
    if (edit) {
      const saved = savedManualMatch(db, edit.id);
      if (!saved) throw new CoverageError("This Manual Match was deleted. Reload the page.", 404, "not-found", edit.id);
      existing = withFlags(db, saved);
      if (!Number.isInteger(edit.revision) || edit.revision !== existing.revision)
        throw new CoverageError("This Manual Match changed since you opened it. Reopen it and review the latest records.", 409, "stale-revision", edit.id);
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
        throw new CoverageError("This episode already belongs to a Manual Match. Open that Manual Match.", 409, "membership-conflict", row.mapping_id);
    }
    // A flag-only save reviews no provider records, so it keeps the saved health.
    const kept = flagsOnly && existing ? { ...(existing.health ? { health: existing.health } : {}), ...(existing.healthMessage ? { healthMessage: existing.healthMessage } : {}) } : {};
    const mapping: CoverageMapping = { id: existing?.id || randomUUID(), revision: coverageState().revision + 1, members, createdAt: existing?.createdAt || new Date().toISOString(), ...kept };
    db.prepare("INSERT INTO shelfcheck_coverage_mappings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(mapping.id, JSON.stringify(mapping));
    if (existing) db.prepare("DELETE FROM shelfcheck_coverage_members WHERE mapping_id=?").run(existing.id);
    for (const m of members)
      db.prepare("INSERT INTO shelfcheck_coverage_members(provider,episode_id,mapping_id,report_missing) VALUES(?,?,?,?)").run(m.provider, m.id, mapping.id, flags.has(memberKey(m)) ? 1 : 0);
    db.prepare("UPDATE shelfcheck_coverage_state SET revision=?,pending=1 WHERE id=1").run(mapping.revision);
    const affectedMembers = distinctMembers([...(existing?.members || []), ...members]);
    carryMembers(db, affectedMembers, mapping.revision);
    if (existing && !flagsOnly) for (const issue of listCoverageIssues().filter(issue=>issue.mappingId === existing.id)) resolveCoverageIssue(issue.id);
    const saved = { mapping: withFlags(db, mapping), affectedMembers };
    db.exec("COMMIT");
    return saved;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Automatic Ignore cleanup: delete the explicit Report Missing flags of these
 * members, together with `alongside` (the Ignore rule itself), in one transaction.
 * This is not a manual save, so it never applies the both-sides-or-none rule and
 * may leave a many-to-many mapping with flags on one side. Each affected mapping
 * gets a new revision, so an editor opened before the Ignore cannot save its
 * stale draft and silently restore the deleted flags.
 * Returns every member of the affected mappings, for the affected-show recheck.
 */
export function clearReportMissingFlags(members: CoverageIdentity[], alongside: () => void): CoverageMember[] {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const flagged = members.flatMap(member => {
      const row = db.prepare("SELECT mapping_id FROM shelfcheck_coverage_members WHERE provider=? AND episode_id=? AND report_missing=1").get(member.provider, member.id) as { mapping_id: string } | undefined;
      return row ? [{ ...member, mappingId: row.mapping_id }] : [];
    });
    if (flagged.length) assertCoverageMutationAllowed();
    const affected = [...new Set(flagged.map(member => member.mappingId))];
    const revision = coverageState().revision + 1;
    for (const member of flagged) db.prepare("UPDATE shelfcheck_coverage_members SET report_missing=0 WHERE provider=? AND episode_id=?").run(member.provider, member.id);
    const impact: CoverageMember[] = [];
    for (const id of affected) {
      const mapping: CoverageMapping = { ...savedManualMatch(db, id)!, revision };
      db.prepare("UPDATE shelfcheck_coverage_mappings SET payload=? WHERE id=?").run(JSON.stringify(mapping), id);
      impact.push(...mapping.members);
    }
    if (affected.length) {
      db.prepare("UPDATE shelfcheck_coverage_state SET revision=?,pending=1 WHERE id=1").run(revision);
      carryMembers(db, impact, revision);
    }
    alongside();
    db.exec("COMMIT");
    return impact;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type ManualMatchDeletion = { deleted: string[]; missing: string[]; affectedMembers: CoverageMember[] };

/** Delete one Manual Match; a missing one is "not found" and changes nothing. */
export function deleteCoverageMapping(id: string): ManualMatchDeletion {
  const result = deleteCoverageMappings([id]);
  if (!result.deleted.length) throw new CoverageError("Manual Match not found.", 404, "not-found");
  return result;
}

/**
 * Delete each listed Manual Match once. Returns the deleted and missing IDs and
 * the members of the Manual Matches actually deleted, read inside the delete's
 * transaction before their rows go. The scan check inside that transaction is
 * authoritative.
 */
export function deleteCoverageMappings(ids: unknown): ManualMatchDeletion {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    assertCoverageMutationAllowed();
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.trim()))
      throw new CoverageError("Select the Manual Matches to delete.");
    const deleted: string[] = [];
    const missing: string[] = [];
    const affectedMembers: CoverageMember[] = [];
    for (const id of new Set<string>(ids)) {
      affectedMembers.push(...(savedManualMatch(db, id)?.members || []));
      const result = db.prepare("DELETE FROM shelfcheck_coverage_mappings WHERE id=?").run(id);
      if (result.changes) for (const issue of listCoverageIssues().filter(issue=>issue.mappingId === id)) resolveCoverageIssue(issue.id);
      (result.changes ? deleted : missing).push(id);
    }
    const distinct = distinctMembers(affectedMembers);
    if (deleted.length) {
      db.exec("UPDATE shelfcheck_coverage_state SET revision=revision+1,pending=1 WHERE id=1");
      carryMembers(db, distinct, coverageState().revision);
    }
    db.exec("COMMIT");
    return { deleted, missing, affectedMembers: distinct };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveCoverageEvidence(evidence: CoverageEvidence[]) {
  database().prepare("INSERT INTO shelfcheck_coverage_evidence VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(evidence));
}

export function readCoverageEvidence(): CoverageEvidence[] {
  const row = database().prepare("SELECT payload FROM shelfcheck_coverage_evidence WHERE id=1").get() as {
    payload: string;
  } | undefined;
  return row ? JSON.parse(row.payload) : [];
}

/**
 * A carried member: a Manual Match member (with its show placement) whose shows a
 * committed change left for a cached recheck, and the coverage revision that carried
 * it. Carried members survive a restart and keep the comparison pending.
 */
export type CarriedMember = { member: CoverageMember; revision: number };

/** Carry these members at `revision`, inside the committing change's transaction. A member already carried takes the newer revision. */
function carryMembers(db: ReturnType<typeof database>, members: CoverageMember[], revision: number) {
  for (const member of distinctMembers(members)) {
    const description = { ...member };
    delete description.reportMissing;
    db.prepare("INSERT INTO shelfcheck_coverage_carried(provider,episode_id,show_id,revision,payload) VALUES(?,?,?,?,?) ON CONFLICT(provider,episode_id,show_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload")
      .run(member.provider, member.id, member.showId, revision, JSON.stringify(description));
  }
}

/** Every carried member: each committed change's members until a cached recheck or completed full Plex scan covers them. */
export function carriedMembers(): CarriedMember[] {
  return (database().prepare("SELECT revision,payload FROM shelfcheck_coverage_carried ORDER BY rowid").all() as { revision: number; payload: string }[])
    .map(row => ({ member: JSON.parse(row.payload), revision: row.revision }));
}

/**
 * Complete a comparison of coverage `revision`: drop the carried members it
 * rechecked, each only as carried when the recheck read it (a change committed
 * since carries it again at a newer revision, and keeps it), then clear pending
 * only when `revision` is still current and no carried member remains.
 */
export function completeCoverageRecheck(revision: number, rechecked: CarriedMember[] = []) {
  completeComparison(revision, db => {
    for (const { member, revision: carried } of rechecked)
      db.prepare("DELETE FROM shelfcheck_coverage_carried WHERE provider=? AND episode_id=? AND show_id=? AND revision<=?").run(member.provider, member.id, member.showId, carried);
  });
}

/** Complete a full Plex scan of coverage `revision`: it compared every show, so every member carried at or before that revision is covered. */
export function completeFullCoverageScan(revision: number) {
  completeComparison(revision, db => db.prepare("DELETE FROM shelfcheck_coverage_carried WHERE revision<=?").run(revision));
}

function completeComparison(revision: number, uncarry: (db: ReturnType<typeof database>) => void) {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    uncarry(db);
    db.prepare("UPDATE shelfcheck_coverage_state SET pending=0 WHERE id=1 AND revision=? AND NOT EXISTS (SELECT 1 FROM shelfcheck_coverage_carried)").run(revision);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function beginCoverageRecheck(revision: number) {
  database().prepare("UPDATE shelfcheck_coverage_state SET pending=1 WHERE id=1 AND revision=?").run(revision);
}

// Lookup results must never overwrite a mapping repaired or deleted during an HTTP request.
export function updateCoverageHealth(snapshot: CoverageMapping, health: NonNullable<CoverageMapping["health"]>, healthMessage?: string) {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = savedManualMatch(db, snapshot.id);
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
