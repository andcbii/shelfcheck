import "server-only";
import { randomUUID } from "node:crypto";
import { coverageDatabase } from "@/lib/sqlite";
import type { CoverageEvidence, CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
export class CoverageError extends Error {
  constructor(message: string, public status = 400, public code = "validation", public mappingId?: string) {
    super(message);
  }
}

export function coverageState() {
  return coverageDatabase().prepare("SELECT revision,pending FROM shelfcheck_coverage_state WHERE id=1").get() as {
    revision: number;
    pending: number;
  };
}

export function listCoverageMappings(): CoverageMapping[] {
  return (coverageDatabase().prepare("SELECT payload FROM shelfcheck_coverage_mappings ORDER BY rowid").all() as {
    payload: string;
  }[]).map(row => JSON.parse(row.payload));
}

export function saveCoverageMapping(members: CoverageMember[]): CoverageMapping {
  if (members.length !== 2 || members.filter(m => m.provider === "TMDB").length !== 1 || members.filter(m => m.provider === "TVDB").length !== 1)
    throw new CoverageError("Review one TMDB episode and one TVDB episode.");
  const db = coverageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const m of members) {
      const row = db.prepare("SELECT mapping_id FROM shelfcheck_coverage_members WHERE provider=? AND episode_id=?").get(m.provider, m.id) as {
        mapping_id: string;
      } | undefined;
      if (row)
        throw new CoverageError("This episode already belongs to a mapping. Open the existing mapping.", 409, "membership-conflict", row.mapping_id);
    }
    const mapping: CoverageMapping = { id: randomUUID(), revision: coverageState().revision + 1, members, createdAt: new Date().toISOString() };
    db.prepare("INSERT INTO shelfcheck_coverage_mappings VALUES(?,?)").run(mapping.id, JSON.stringify(mapping));
    for (const m of members)
      db.prepare("INSERT INTO shelfcheck_coverage_members VALUES(?,?,?)").run(m.provider, m.id, mapping.id);
    db.prepare("UPDATE shelfcheck_coverage_state SET revision=?,pending=1 WHERE id=1").run(mapping.revision);
    db.exec("COMMIT");
    return mapping;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteCoverageMapping(id: string) {
  const db = coverageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("DELETE FROM shelfcheck_coverage_mappings WHERE id=?").run(id);
    if (!result.changes)
      throw new CoverageError("Mapping not found.", 404, "not-found");
    db.exec("UPDATE shelfcheck_coverage_state SET revision=revision+1,pending=1 WHERE id=1");
    db.exec("COMMIT");
    return id;
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
