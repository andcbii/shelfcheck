import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ignoredPlexKeys, ignoredTraktIds } from "@/lib/ignored-shows";
import { backupBeforeFirstMigration, migrateDatabase, refuseNewerDatabase } from "@/lib/sqlite-migrations";

const SINGLE_USER_ID = "single-user";

type ScanMode = "trakt" | "plex";
type DatabaseCache = typeof globalThis & {
  __shelfcheckDatabase?: DatabaseSync;
  __shelfcheckScanIgnoreGuards?: Partial<Record<ScanMode, Set<string>>>;
};

function scanIgnoreGuards() {
  const cache = globalThis as DatabaseCache;
  return cache.__shelfcheckScanIgnoreGuards ||= {};
}

// An ignore applied during a scan invalidates that scan's result even if the
// user restores the show before its pending provider requests finish.
export function trackScanIgnores(mode: ScanMode, now = Date.now()): () => void {
  const ignored = mode === "trakt"
    ? [...ignoredTraktIds(readSingleUserState().state?.ignoredShows, now)].map(String)
    : [...ignoredPlexKeys(savedOptions("plex").ignoredShows, now)];
  const guard = new Set(ignored);
  scanIgnoreGuards()[mode] = guard;
  return () => {
    if (scanIgnoreGuards()[mode] === guard) delete scanIgnoreGuards()[mode];
  };
}

function recordScanIgnores(mode: ScanMode, ignored: Iterable<string>) {
  const guard = scanIgnoreGuards()[mode];
  if (guard) for (const key of ignored) guard.add(key);
}

function blockedShowKeys(mode: ScanMode, ignoredShows: unknown) {
  const active = mode === "trakt" ? [...ignoredTraktIds(ignoredShows)].map(String) : [...ignoredPlexKeys(ignoredShows)];
  return new Set([...active, ...(scanIgnoreGuards()[mode] || [])]);
}

function pruneIgnoredResults<T>(value: T, mode: ScanMode, blocked: Set<string>): T {
  if (!value || typeof value !== "object" || !blocked.size) return value;
  const report = value as Record<string, unknown>;
  const isVisible = (item: unknown) => {
    if (!item || typeof item !== "object") return true;
    const row = item as { ratingKey?: string; show?: { ids?: { trakt?: number } } };
    const key = mode === "plex" ? row.ratingKey : String(row.show?.ids?.trakt);
    return key === undefined || !blocked.has(key);
  };
  return {
    ...report,
    ...(Array.isArray(report.shows) ? { shows: report.shows.filter(isVisible) } : {}),
    ...(Array.isArray(report.missing) ? { missing: report.missing.filter(isVisible) } : {}),
    ...(report.scanCache && typeof report.scanCache === "object" ? {
      scanCache: Object.fromEntries(Object.entries(report.scanCache).filter(([key]) => !blocked.has(key))),
    } : {}),
  } as T;
}

function parseStoredJson<T>(payload: string | null | undefined, fallback: T): T {
  if (!payload) return fallback;
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === "object" ? value as T : fallback;
  } catch {
    return fallback;
  }
}

// Runs once per opened handle, after migrations, because whether an Ignore is
// active depends on the current time. It uses only the handle it is given.
function normalizeStoredIgnores(db: DatabaseSync) {
  // Older versions retained results when Ignore was applied. Remove those
  // results before any read or Restore can expose them after an upgrade.
  const traktRow = db.prepare("SELECT payload FROM shelfcheck_states WHERE user_id = ?")
    .get(SINGLE_USER_ID) as { payload: string } | undefined;
  if (traktRow) {
    const state = parseStoredJson<Record<string, unknown>>(traktRow.payload, {});
    const blocked = blockedShowKeys("trakt", state.ignoredShows);
    const pruned = {
      ...state,
      ...(state.report ? { report: pruneIgnoredResults(state.report, "trakt", blocked) } : {}),
      ...(state.checkpoint ? { checkpoint: pruneIgnoredResults(state.checkpoint, "trakt", blocked) } : {}),
    };
    if (JSON.stringify(pruned) !== JSON.stringify(state)) {
      db.prepare("UPDATE shelfcheck_states SET payload = ? WHERE user_id = ?").run(JSON.stringify(pruned), SINGLE_USER_ID);
    }
  }

  // Every mode saved in the shared saved scan state; Trakt moves there in a later migration.
  const savedRows = db.prepare("SELECT mode, report, resume_point, options FROM shelfcheck_scan_state")
    .all() as { mode: ScanMode; report: string | null; resume_point: string | null; options: string | null }[];
  for (const row of savedRows) {
    const options = parseStoredJson<Record<string, unknown>>(row.options, {});
    const blocked = blockedShowKeys(row.mode, options.ignoredShows);
    const report = parseStoredJson<Record<string, unknown> | null>(row.report, null);
    const point = parseStoredJson<Record<string, unknown> | null>(row.resume_point, null);
    const prunedReport = pruneIgnoredResults(report, row.mode, blocked);
    const prunedPoint = pruneIgnoredResults(point, row.mode, blocked);
    if (JSON.stringify(prunedReport) !== JSON.stringify(report) || JSON.stringify(prunedPoint) !== JSON.stringify(point)) {
      db.prepare("UPDATE shelfcheck_scan_state SET report = ?, resume_point = ? WHERE mode = ?")
        .run(prunedReport === null ? row.report : JSON.stringify(prunedReport), prunedPoint === null ? row.resume_point : JSON.stringify(prunedPoint), row.mode);
    }
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
    normalizeStoredIgnores(db);
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

export function readSingleUserState<T extends Record<string, unknown> = Record<string, unknown>>() {
  const row = database().prepare(
    "SELECT payload, updated_at FROM shelfcheck_states WHERE user_id = ?",
  ).get(SINGLE_USER_ID) as { payload: string; updated_at: string } | undefined;
  return row
    ? { state: parseStoredJson<T>(row.payload, {} as T), updatedAt: row.updated_at }
    : { state: null, updatedAt: null };
}

function writeSingleUserState<T extends Record<string, unknown>>(state: T) {
  const blocked = blockedShowKeys("trakt", state.ignoredShows);
  const pruned = {
    ...state,
    ...(state.report ? { report: pruneIgnoredResults(state.report, "trakt", blocked) } : {}),
    ...(state.checkpoint ? { checkpoint: pruneIgnoredResults(state.checkpoint, "trakt", blocked) } : {}),
  };
  database().prepare(`INSERT INTO shelfcheck_states (user_id, payload, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(pruned));
}

export function patchSingleUserState<T extends Record<string, unknown>>(patch: T) {
  const current = readSingleUserState<Record<string, unknown>>();
  if (Object.prototype.hasOwnProperty.call(patch, "ignoredShows")) {
    recordScanIgnores("trakt", [...ignoredTraktIds(patch.ignoredShows)].map(String));
  }
  writeSingleUserState({ ...(current.state || {}), ...patch });
}

export function readSingleUserScanStatus<T extends Record<string, unknown> = Record<string, unknown>>(): T | null {
  const row = database().prepare(
    "SELECT payload FROM shelfcheck_scan_status WHERE user_id = ?",
  ).get(SINGLE_USER_ID) as { payload: string } | undefined;
  if (row) return parseStoredJson<T | null>(row.payload, null);

  const current = readSingleUserState();
  const legacy = current.state?.scan as Record<string, unknown> | undefined;
  if (!legacy) return null;
  writeSingleUserScanStatus(legacy);
  const stateWithoutScan = { ...(current.state || {}) };
  delete stateWithoutScan.scan;
  writeSingleUserState(stateWithoutScan);
  return legacy as T;
}

export function writeSingleUserScanStatus<T extends Record<string, unknown>>(scan: T) {
  database().prepare(`INSERT INTO shelfcheck_scan_status (user_id, payload, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(scan));
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

/**
 * The saved scan state of one scan mode: its report, Resume point, scan status and
 * options. Options are the mode's Settings and Ignore Preferences, kept together in one
 * JSON object. Each write changes only its own part. Report and Resume point writes
 * remove actively ignored results first; an options patch that sets ignoredShows
 * records them for a running scan and prunes the saved report and Resume point.
 * Operations join a transaction already open on the database instead of nesting one.
 */
export type SavedScanState<R, P, S, O> = {
  report: { read(): R | null; write(report: R): void; clear(): void };
  resumePoint: { read(): P | null; write(point: P): void; clear(): void };
  status: { read(): S | null; write(status: S): void };
  options: { read(): O; patch(patch: Partial<O>): void };
  /** All four parts and the state timestamp in one statement; null when the mode has no row. */
  snapshot(): SavedScanStateSnapshot<R, P, S, O> | null;
  /** Saves a finished report and clears its Resume point, as one write. */
  commitReport(report: R): void;
  /** Clears the report and its Resume point, as one write. */
  clearReportAndResumePoint(): void;
};

type SavedStateRow = { report: string | null; resume_point: string | null; status: string | null; options: string | null; state_updated_at: string | null };

/** Run `work` inside the transaction already open, or in a new one when none is. */
function inTransaction<T>(work: () => T): T {
  const db = database();
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
}

function savedRow(mode: ScanMode) {
  return database().prepare("SELECT report, resume_point, status, options, state_updated_at FROM shelfcheck_scan_state WHERE mode = ?")
    .get(mode) as SavedStateRow | undefined;
}

function savedOptions(mode: ScanMode): Record<string, unknown> {
  const row = database().prepare("SELECT options FROM shelfcheck_scan_state WHERE mode = ?").get(mode) as { options: string | null } | undefined;
  return parseStoredJson<Record<string, unknown>>(row?.options, {});
}

function prunedForSave(mode: ScanMode, value: unknown) {
  return JSON.stringify(pruneIgnoredResults(value, mode, blockedShowKeys(mode, savedOptions(mode).ignoredShows)));
}

// Every statement names its columns here; callers never supply column names.
const SAVED_STATE_SQL = {
  report: `INSERT INTO shelfcheck_scan_state(mode, report, state_updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mode) DO UPDATE SET report = excluded.report, state_updated_at = CURRENT_TIMESTAMP`,
  resumePoint: `INSERT INTO shelfcheck_scan_state(mode, resume_point, state_updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mode) DO UPDATE SET resume_point = excluded.resume_point, state_updated_at = CURRENT_TIMESTAMP`,
  commitReport: `INSERT INTO shelfcheck_scan_state(mode, report, state_updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mode) DO UPDATE SET report = excluded.report, resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP`,
  status: `INSERT INTO shelfcheck_scan_state(mode, status) VALUES(?, ?)
    ON CONFLICT(mode) DO UPDATE SET status = excluded.status`,
  options: `INSERT INTO shelfcheck_scan_state(mode, options, state_updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mode) DO UPDATE SET options = excluded.options, state_updated_at = CURRENT_TIMESTAMP`,
  clearReport: "UPDATE shelfcheck_scan_state SET report = NULL, state_updated_at = CURRENT_TIMESTAMP WHERE mode = ?",
  clearResumePoint: "UPDATE shelfcheck_scan_state SET resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP WHERE mode = ?",
  clearBoth: "UPDATE shelfcheck_scan_state SET report = NULL, resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP WHERE mode = ?",
} as const;

/** The saved scan state store bound to one mode; the caller supplies the mode's own part types. */
export function savedScanState<
  R = Record<string, unknown>, P = Record<string, unknown>, S = Record<string, unknown>, O extends Record<string, unknown> = Record<string, unknown>,
>(mode: ScanMode): SavedScanState<R, P, S, O> {
  const run = (sql: keyof typeof SAVED_STATE_SQL, value?: string) => {
    const statement = database().prepare(SAVED_STATE_SQL[sql]);
    if (value === undefined) statement.run(mode);
    else statement.run(mode, value);
  };
  return {
    report: {
      read: () => parseStoredJson<R | null>(savedRow(mode)?.report, null),
      write: (report) => run("report", prunedForSave(mode, report)),
      clear: () => run("clearReport"),
    },
    resumePoint: {
      read: () => parseStoredJson<P | null>(savedRow(mode)?.resume_point, null),
      write: (point) => run("resumePoint", prunedForSave(mode, point)),
      clear: () => run("clearResumePoint"),
    },
    status: {
      read: () => parseStoredJson<S | null>(savedRow(mode)?.status, null),
      write: (status) => run("status", JSON.stringify(status)),
    },
    options: {
      read: () => savedOptions(mode) as O,
      patch: (patch) => inTransaction(() => patchOptions(mode, patch)),
    },
    snapshot: () => {
      const row = savedRow(mode);
      return row ? {
        report: parseStoredJson<R | null>(row.report, null),
        resumePoint: parseStoredJson<P | null>(row.resume_point, null),
        status: parseStoredJson<S | null>(row.status, null),
        options: row.options === null ? null : parseStoredJson<O>(row.options, {} as O),
        updatedAt: row.state_updated_at,
      } : null;
    },
    commitReport: (report) => run("commitReport", prunedForSave(mode, report)),
    clearReportAndResumePoint: () => run("clearBoth"),
  };
}

/**
 * Merge the supplied option fields over the saved ones. Only a patch that sets
 * ignoredShows touches the report and Resume point: it records the Ignores for a
 * running scan and, while any show is blocked, removes that show's saved results.
 */
function patchOptions(mode: ScanMode, patch: Record<string, unknown>) {
  const options = { ...savedOptions(mode), ...patch };
  database().prepare(SAVED_STATE_SQL.options).run(mode, JSON.stringify(options));
  if (!Object.prototype.hasOwnProperty.call(patch, "ignoredShows")) return;
  recordScanIgnores(mode, mode === "trakt" ? [...ignoredTraktIds(patch.ignoredShows)].map(String) : ignoredPlexKeys(patch.ignoredShows));
  const blocked = blockedShowKeys(mode, options.ignoredShows);
  if (!blocked.size) return;
  const row = savedRow(mode);
  const report = parseStoredJson<Record<string, unknown> | null>(row?.report, null);
  const point = parseStoredJson<Record<string, unknown> | null>(row?.resume_point, null);
  if (report) database().prepare("UPDATE shelfcheck_scan_state SET report = ? WHERE mode = ?").run(JSON.stringify(pruneIgnoredResults(report, mode, blocked)), mode);
  if (point) database().prepare("UPDATE shelfcheck_scan_state SET resume_point = ? WHERE mode = ?").run(JSON.stringify(pruneIgnoredResults(point, mode, blocked)), mode);
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
