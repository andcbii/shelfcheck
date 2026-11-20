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
    : [...ignoredPlexKeys(readPlexSettings().ignoredShows, now)];
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

  const plexRow = db.prepare("SELECT settings, report, checkpoint FROM shelfcheck_plex_state WHERE user_id = ?")
    .get(SINGLE_USER_ID) as { settings: string; report: string | null; checkpoint: string | null } | undefined;
  if (plexRow) {
    const settings = parseStoredJson<Record<string, unknown>>(plexRow.settings, {});
    const blocked = blockedShowKeys("plex", settings.ignoredShows);
    const report = parseStoredJson<Record<string, unknown> | null>(plexRow.report, null);
    const checkpoint = parseStoredJson<Record<string, unknown> | null>(plexRow.checkpoint, null);
    const prunedReport = pruneIgnoredResults(report, "plex", blocked);
    const prunedCheckpoint = pruneIgnoredResults(checkpoint, "plex", blocked);
    if (JSON.stringify(prunedReport) !== JSON.stringify(report) || JSON.stringify(prunedCheckpoint) !== JSON.stringify(checkpoint)) {
      db.prepare("UPDATE shelfcheck_plex_state SET report = ?, checkpoint = ? WHERE user_id = ?")
        .run(prunedReport === null ? plexRow.report : JSON.stringify(prunedReport), prunedCheckpoint === null ? plexRow.checkpoint : JSON.stringify(prunedCheckpoint), SINGLE_USER_ID);
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

export function readPlexScanStatus<T extends Record<string, unknown> = Record<string, unknown>>(): T | null {
  const row = database().prepare("SELECT scan_status FROM shelfcheck_plex_state WHERE user_id = ?")
    .get(SINGLE_USER_ID) as { scan_status: string } | undefined;
  return row ? parseStoredJson<T | null>(row.scan_status, null) : null;
}

export function writePlexScanStatus<T extends Record<string, unknown>>(scan: T) {
  database().prepare(`INSERT INTO shelfcheck_plex_state (user_id, scan_status, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET scan_status = excluded.scan_status, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(scan));
}

export function readPlexReport<T extends Record<string, unknown> = Record<string, unknown>>(): T | null {
  const row = database().prepare("SELECT report FROM shelfcheck_plex_state WHERE user_id = ?")
    .get(SINGLE_USER_ID) as { report: string | null } | undefined;
  return parseStoredJson<T | null>(row?.report, null);
}

export function writePlexReport<T extends Record<string, unknown>>(report: T) {
  const pruned = pruneIgnoredResults(report, "plex", blockedShowKeys("plex", readPlexSettings().ignoredShows));
  database().prepare(`INSERT INTO shelfcheck_plex_state (user_id, report, scan_status, updated_at)
    VALUES (?, ?, '{}', CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET report = excluded.report, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(pruned));
}

export function clearPlexReport() {
  database().prepare("UPDATE shelfcheck_plex_state SET report = NULL, checkpoint = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?")
    .run(SINGLE_USER_ID);
}

export function readPlexCheckpoint<T extends Record<string, unknown> = Record<string, unknown>>(): T | null {
  const row = database().prepare("SELECT checkpoint FROM shelfcheck_plex_state WHERE user_id = ?")
    .get(SINGLE_USER_ID) as { checkpoint: string | null } | undefined;
  return parseStoredJson<T | null>(row?.checkpoint, null);
}

export function writePlexCheckpoint<T extends Record<string, unknown>>(checkpoint: T) {
  const pruned = pruneIgnoredResults(checkpoint, "plex", blockedShowKeys("plex", readPlexSettings().ignoredShows));
  database().prepare(`INSERT INTO shelfcheck_plex_state (user_id, checkpoint, scan_status, updated_at)
    VALUES (?, ?, '{}', CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET checkpoint = excluded.checkpoint, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(pruned));
}

export function clearPlexCheckpoint() {
  database().prepare("UPDATE shelfcheck_plex_state SET checkpoint = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(SINGLE_USER_ID);
}

export function readPlexSettings<T extends Record<string, unknown> = Record<string, unknown>>(): T {
  const row = database().prepare("SELECT settings FROM shelfcheck_plex_state WHERE user_id = ?")
    .get(SINGLE_USER_ID) as { settings: string } | undefined;
  return row ? parseStoredJson<T>(row.settings, {} as T) : {} as T;
}

export function writePlexSettings<T extends Record<string, unknown>>(settings: T) {
  const ignored = ignoredPlexKeys(settings.ignoredShows);
  recordScanIgnores("plex", ignored);
  database().prepare(`INSERT INTO shelfcheck_plex_state (user_id, settings, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(settings));
  if (blockedShowKeys("plex", settings.ignoredShows).size) {
    const report = readPlexReport();
    if (report) writePlexReport(report);
    const checkpoint = readPlexCheckpoint();
    if (checkpoint) writePlexCheckpoint(checkpoint);
  }
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
