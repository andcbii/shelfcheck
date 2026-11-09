import "server-only";
import { randomUUID } from "node:crypto";
import { coverageDatabase } from "@/lib/sqlite";
import type { CoverageCorrection, CoverageEvidence, CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
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

export function saveCoverageMapping(members: CoverageMember[], edit?: { id: string; revision: number }): CoverageMapping {
  if (!members.some(m => m.provider === "TMDB") || !members.some(m => m.provider === "TVDB") || new Set(members.map(m => `${m.provider}:${m.id}`)).size !== members.length)
    throw new CoverageError("Review nonempty complete sets of distinct TMDB and TVDB episodes.");
  const db = coverageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    let existing: CoverageMapping | undefined;
    if (edit) {
      const row = db.prepare("SELECT payload FROM shelfcheck_coverage_mappings WHERE id=?").get(edit.id) as { payload: string } | undefined;
      if (!row) throw new CoverageError("This mapping was deleted. Reload the manager.", 404, "not-found", edit.id);
      existing = JSON.parse(row.payload);
      if (!Number.isInteger(edit.revision) || edit.revision !== existing!.revision)
        throw new CoverageError("This mapping changed since you opened it. Reopen it and review the latest records.", 409, "stale-revision", edit.id);
    }
    for (const m of members) {
      const row = db.prepare("SELECT mapping_id FROM shelfcheck_coverage_members WHERE provider=? AND episode_id=?").get(m.provider, m.id) as {
        mapping_id: string;
      } | undefined;
      if (row && row.mapping_id !== existing?.id)
        throw new CoverageError("This episode already belongs to a mapping. Open the existing mapping.", 409, "membership-conflict", row.mapping_id);
    }
    const mapping: CoverageMapping = { id: existing?.id || randomUUID(), revision: coverageState().revision + 1, members, createdAt: existing?.createdAt || new Date().toISOString() };
    db.prepare("INSERT INTO shelfcheck_coverage_mappings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(mapping.id, JSON.stringify(mapping));
    if (existing) {
      db.prepare("DELETE FROM shelfcheck_coverage_members WHERE mapping_id=?").run(existing.id);
      for (const correction of listCoverageCorrections().filter(c => c.mappingId === existing.id)) {
        // A complete-side declaration changes meaning whenever that side changes.
        const compatible = correction.identities.every(identity => members.some(m => sameIdentity(m, identity))) &&
          ["TMDB", "TVDB"].every(provider => {
            const selected = correction.identities.filter(i => i.provider === provider);
            const oldSide = existing!.members.filter(m => m.provider === provider);
            return !selected.length || selected.length !== oldSide.length || members.filter(m => m.provider === provider).every(m => oldSide.some(old => sameIdentity(old,m))) && members.filter(m => m.provider === provider).length === oldSide.length;
          });
        if (!compatible) db.prepare("DELETE FROM shelfcheck_coverage_corrections WHERE mapping_id=? AND show_key=? AND item_key=?").run(correction.mappingId,correction.showKey,correction.ratingKey);
      }
    }
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
  const result = deleteCoverageMappings([id]);
  if (!result.deleted.length) throw new CoverageError("Mapping not found.", 404, "not-found");
  return id;
}

export function deleteCoverageMappings(ids: unknown): { deleted: string[]; missing: string[] } {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.trim()))
    throw new CoverageError("Select explicit mapping identities to delete.");
  const db = coverageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const id of new Set<string>(ids)) {
      const result = db.prepare("DELETE FROM shelfcheck_coverage_mappings WHERE id=?").run(id);
      if (result.changes) correctionTable().prepare("DELETE FROM shelfcheck_coverage_corrections WHERE mapping_id=?").run(id);
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

export function saveCoverageEvidence(evidence: CoverageEvidence[], complete = true) {
  const db = correctionTable();
  for (const correction of listCoverageCorrections()) if ((complete || evidence.some(item=>item.showKey===correction.showKey && item.ratingKey===correction.ratingKey)) && !evidence.some(item=>item.showKey===correction.showKey && item.ratingKey===correction.ratingKey && item.fingerprint===correction.fingerprint)) db.prepare("DELETE FROM shelfcheck_coverage_corrections WHERE mapping_id=? AND show_key=? AND item_key=?").run(correction.mappingId,correction.showKey,correction.ratingKey);
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

function correctionTable() {
  const db=coverageDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS shelfcheck_coverage_corrections(mapping_id TEXT NOT NULL,show_key TEXT NOT NULL,item_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(mapping_id,show_key,item_key))");
  return db;
}
function sameIdentity(a: {provider:string;id:number}, b: {provider:string;id:number}) { return a.provider===b.provider && a.id===b.id; }
export function listCoverageCorrections(): CoverageCorrection[] {
  return (correctionTable().prepare("SELECT payload FROM shelfcheck_coverage_corrections").all() as {payload:string}[]).map(row=>JSON.parse(row.payload));
}
export function saveOwnershipCorrection(mappingId: unknown, revision: unknown, item: CoverageEvidence, identities: CoverageEvidence["identities"]) {
  const db=correctionTable();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (revision!==coverageState().revision) throw new CoverageError("Coverage changed. Reload the latest inventory.",409,"stale-revision");
    const mapping=listCoverageMappings().find(m=>m.id===mappingId);
    const current=readCoverageEvidence().find(e=>e.ratingKey===item?.ratingKey && e.showKey===item?.showKey && e.fingerprint===item?.fingerprint);
    if (!mapping || !current || !current.ratingKey || !current.identities.some(i=>mapping.members.some(m=>sameIdentity(m,i)))) throw new CoverageError("This item or mapping changed. Scan and review it again.",409,"stale-evidence");
    if (!Array.isArray(identities) || !identities.length || new Set(identities.map(i=>i.provider)).size!==1 || new Set(identities.map(i=>i.id)).size!==identities.length || identities.some(i=>!mapping.members.some(m=>sameIdentity(m,i)))) throw new CoverageError("Declare one complete provider side or selected parts from one side of this mapping.");
    const correction: CoverageCorrection={...current,mappingId:mapping.id,identities};
    db.prepare("INSERT INTO shelfcheck_coverage_corrections VALUES(?,?,?,?) ON CONFLICT(mapping_id,show_key,item_key) DO UPDATE SET payload=excluded.payload").run(mapping.id,current.showKey,current.ratingKey,JSON.stringify(correction));
    db.exec("UPDATE shelfcheck_coverage_state SET revision=revision+1,pending=1 WHERE id=1");
    db.exec("COMMIT");
    return correction;
  } catch(error) {db.exec("ROLLBACK");throw error;}
}
export function correctedCoverageInventory(mapping: CoverageMapping, inventory: CoverageEvidence[]): CoverageEvidence[] {
  const corrections=listCoverageCorrections().filter(c=>c.mappingId===mapping.id);
  return inventory.map(item=>{
    const correction=corrections.find(c=>c.showKey===item.showKey && c.ratingKey===item.ratingKey && c.fingerprint===item.fingerprint);
    if (correction) return {...item,identities:item.identities.filter(i=>!mapping.members.some(m=>sameIdentity(m,i))).concat(correction.identities)};
    const claimed=mapping.members.filter(m=>item.identities.some(i=>sameIdentity(m,i)));
    const ambiguous=mapping.members.length>2 && new Set(claimed.map(m=>m.provider)).size===2;
    return ambiguous ? {...item,identities:item.identities.filter(i=>!mapping.members.some(m=>sameIdentity(m,i)))} : item;
  });
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
