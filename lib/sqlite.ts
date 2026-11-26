import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeFirstMigration, migrateDatabase, refuseNewerDatabase } from "@/lib/sqlite-migrations";

export type ScanMode = "trakt" | "plex";
type DatabaseCache = typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

// Every saved scan state statement names its columns here; callers never supply column names.
const SAVED_STATE_SQL = {
  row: "SELECT report, resume_point, status, options, state_updated_at FROM shelfcheck_scan_state WHERE mode = ?",
  options: "SELECT options FROM shelfcheck_scan_state WHERE mode = ?",
  /** Parameters: report, Resume point, mode. Leaves the state timestamp alone. */
  savedResults: "UPDATE shelfcheck_scan_state SET report = ?, resume_point = ? WHERE mode = ?",
  /** Parameters: report, mode. Leaves the state timestamp alone. */
  savedReport: "UPDATE shelfcheck_scan_state SET report = ? WHERE mode = ?",
  /** Parameters: Resume point, mode. Leaves the state timestamp alone. */
  savedResumePoint: "UPDATE shelfcheck_scan_state SET resume_point = ? WHERE mode = ?",
  writeReport: `INSERT INTO shelfcheck_scan_state(mode, report, state_updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mode) DO UPDATE SET report = excluded.report, state_updated_at = CURRENT_TIMESTAMP`,
  writeResumePoint: `INSERT INTO shelfcheck_scan_state(mode, resume_point, state_updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mode) DO UPDATE SET resume_point = excluded.resume_point, state_updated_at = CURRENT_TIMESTAMP`,
  commitReport: `INSERT INTO shelfcheck_scan_state(mode, report, state_updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mode) DO UPDATE SET report = excluded.report, resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP`,
  writeStatus: `INSERT INTO shelfcheck_scan_state(mode, status) VALUES(?, ?)
    ON CONFLICT(mode) DO UPDATE SET status = excluded.status`,
  writeOptions: `INSERT INTO shelfcheck_scan_state(mode, options, state_updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mode) DO UPDATE SET options = excluded.options, state_updated_at = CURRENT_TIMESTAMP`,
  clearResumePoint: "UPDATE shelfcheck_scan_state SET resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP WHERE mode = ?",
  clearReportAndResumePoint: "UPDATE shelfcheck_scan_state SET report = NULL, resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP WHERE mode = ?",
} as const;

function parseStoredJson<T>(payload: string | null | undefined, fallback: T): T {
  if (!payload) return fallback;
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === "object" ? value as T : fallback;
  } catch {
    return fallback;
  }
}

export function dataDirectory() {
  return process.env.SHELFCHECK_DATA_DIR || path.join(process.cwd(), ".runtime", "data");
}

/** Open, upgrade and prepare the database; nothing is cached unless every step succeeds. */
function openDatabase(file: string) {
  const db = new DatabaseSync(file);
  try {
    refuseNewerDatabase(db);
    backupBeforeFirstMigration(db, file);
    // Connection settings cannot change inside the migration transaction.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrateDatabase(db);
    db.exec("PRAGMA optimize");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The one open database handle: opened, upgraded and cached on first use. */
export function database() {
  const cache = globalThis as DatabaseCache;
  if (cache.__shelfcheckDatabase) return cache.__shelfcheckDatabase;
  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true });
  const db = openDatabase(path.join(directory, "shelfcheck.db"));
  cache.__shelfcheckDatabase = db;
  return db;
}

/** A mode's four saved parts, read in one statement. */
export type SavedScanStateSnapshot<R, P, S, O> = {
  report: R | null;
  resumePoint: P | null;
  status: S | null;
  /** Null until the mode first saves its report, Resume point or options. */
  options: O | null;
  /** When the report, Resume point or options last changed; status writes do not move it. */
  updatedAt: string | null;
};

type SavedStateRow = { report: string | null; resume_point: string | null; status: string | null; options: string | null; state_updated_at: string | null };

/** The statements a mode's store runs with (mode) or (mode, value). */
type ModeWrite = "writeReport" | "writeResumePoint" | "commitReport" | "writeStatus" | "writeOptions" | "clearResumePoint" | "clearReportAndResumePoint";

/**
 * The raw saved scan state of one mode on one database handle (the open one by
 * default): it stores and loads the report, Resume point, scan status and options,
 * and applies no rules to them. Each write changes only its own part and runs on
 * the given handle, so it joins any transaction open there.
 *
 * Only the public saved scan state store may use it; a lint rule enforces this, so
 * no write can skip that store.
 */
export function rawSavedScanState(mode: ScanMode, db: DatabaseSync = database()) {
  const run = (sql: ModeWrite, value?: unknown) => {
    const statement = db.prepare(SAVED_STATE_SQL[sql]);
    if (value === undefined) statement.run(mode);
    else statement.run(mode, JSON.stringify(value));
  };
  const json = (value: unknown) => value === null ? null : JSON.stringify(value);
  return {
    /** All four parts and the state timestamp in one statement; null when the mode has no row. A part that is not a JSON object reads as null. */
    read(): SavedScanStateSnapshot<unknown, unknown, unknown, Record<string, unknown>> | null {
      const row = db.prepare(SAVED_STATE_SQL.row).get(mode) as SavedStateRow | undefined;
      return row ? {
        report: parseStoredJson<unknown>(row.report, null),
        resumePoint: parseStoredJson<unknown>(row.resume_point, null),
        status: parseStoredJson<unknown>(row.status, null),
        options: row.options === null ? null : parseStoredJson<Record<string, unknown>>(row.options, {}),
        updatedAt: row.state_updated_at,
      } : null;
    },
    /** The saved options; empty when none are saved. */
    readOptions(): Record<string, unknown> {
      const row = db.prepare(SAVED_STATE_SQL.options).get(mode) as { options: string | null } | undefined;
      return parseStoredJson<Record<string, unknown>>(row?.options, {});
    },
    writeReport: (report: unknown) => run("writeReport", report),
    writeResumePoint: (point: unknown) => run("writeResumePoint", point),
    /** Saves a finished report and clears its Resume point, as one write. */
    commitReport: (report: unknown) => run("commitReport", report),
    writeStatus: (status: unknown) => run("writeStatus", status),
    writeOptions: (options: Record<string, unknown>) => run("writeOptions", options),
    clearResumePoint: () => run("clearResumePoint"),
    clearReportAndResumePoint: () => run("clearReportAndResumePoint"),
    /**
     * Maintenance update: replace the given parts of the saved report and Resume point
     * in one statement. Null clears a part; an omitted part is kept exactly as stored.
     * It never creates a row, never touches options or status, and never moves the
     * state timestamp, so maintenance does not look like a new result.
     */
    replaceResults(parts: { report?: unknown; resumePoint?: unknown }) {
      const report = Object.hasOwn(parts, "report");
      const point = Object.hasOwn(parts, "resumePoint");
      if (report && point) db.prepare(SAVED_STATE_SQL.savedResults).run(json(parts.report), json(parts.resumePoint), mode);
      else if (report) db.prepare(SAVED_STATE_SQL.savedReport).run(json(parts.report), mode);
      else if (point) db.prepare(SAVED_STATE_SQL.savedResumePoint).run(json(parts.resumePoint), mode);
    },
    /** Run `work` inside the transaction already open on this handle, or in a new one when none is. */
    inTransaction<T>(work: () => T): T {
      if (db.isTransaction) return work();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** Run `work` inside the transaction already open on the open database, or in a new one when none is. */
export function inDatabaseTransaction<T>(work: () => T): T {
  return rawSavedScanState("plex").inTransaction(work);
}

export function readPlexGeneratedInputs<T>(key: string): T | null {
  const row = database().prepare("SELECT payload FROM shelfcheck_plex_generated_inputs WHERE cache_key=?").get(key) as {payload:string}|undefined;
  return parseStoredJson<T|null>(row?.payload, null);
}
export function listPlexGeneratedInputs<T>(prefix: string): Record<string, T> {
  const rows = database().prepare("SELECT cache_key,payload FROM shelfcheck_plex_generated_inputs WHERE cache_key LIKE ?").all(`${prefix}%`) as {cache_key:string;payload:string}[];
  return Object.fromEntries(rows.flatMap(row => {
    const value = parseStoredJson<T|null>(row.payload, null);
    return value === null ? [] : [[row.cache_key.slice(prefix.length), value]];
  }));
}
export function writePlexGeneratedInputs<T>(key: string, inputs: T) {
  database().prepare("INSERT INTO shelfcheck_plex_generated_inputs(cache_key,payload) VALUES(?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload").run(key, JSON.stringify(inputs));
}
/** Deletes every generated input whose key is not exactly one of `keep`; an empty `keep` deletes them all. */
export function deletePlexGeneratedInputsExcept(keep: readonly string[]) {
  const db = database();
  if (!keep.length) { db.exec("DELETE FROM shelfcheck_plex_generated_inputs"); return; }
  db.prepare(`DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key NOT IN (${keep.map(() => "?").join(",")})`).run(...keep);
}
