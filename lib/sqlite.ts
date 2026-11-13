import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ignoredPlexKeys, ignoredTraktIds } from "@/lib/ignored-shows";

const SINGLE_USER_ID = "single-user";
const normalizedIgnoreDatabases = new WeakSet<DatabaseSync>();

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

function ensurePlexSettingsColumn(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(shelfcheck_plex_state)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "settings")) db.exec("ALTER TABLE shelfcheck_plex_state ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
  if (!columns.some((column) => column.name === "checkpoint")) db.exec("ALTER TABLE shelfcheck_plex_state ADD COLUMN checkpoint TEXT");
}

function normalizeStoredIgnores(db: DatabaseSync) {
  if (normalizedIgnoreDatabases.has(db)) return;

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
  normalizedIgnoreDatabases.add(db);
}

export function dataDirectory() {
  return process.env.SHELFCHECK_DATA_DIR || path.join(process.cwd(), ".runtime", "data");
}

function database() {
  const cache = globalThis as DatabaseCache;
  if (cache.__shelfcheckDatabase) {
    normalizeStoredIgnores(cache.__shelfcheckDatabase);
    return cache.__shelfcheckDatabase;
  }

  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "shelfcheck.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS shelfcheck_states (
    user_id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS shelfcheck_scan_status (
    user_id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS shelfcheck_plex_state (
    user_id TEXT PRIMARY KEY NOT NULL,
    report TEXT,
    checkpoint TEXT,
    scan_status TEXT NOT NULL DEFAULT '{}',
    settings TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  ensurePlexSettingsColumn(db);
  normalizeStoredIgnores(db);
  db.exec("PRAGMA optimize");
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

// Manual rules are durable instance data, independent of generated scan state.
export function coverageDatabase() {
  const db = database();
  db.exec(`CREATE TABLE IF NOT EXISTS shelfcheck_coverage_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO shelfcheck_coverage_state(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS shelfcheck_coverage_mappings(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shelfcheck_coverage_members(provider TEXT NOT NULL, episode_id INTEGER NOT NULL, mapping_id TEXT NOT NULL REFERENCES shelfcheck_coverage_mappings(id) ON DELETE CASCADE, report_missing INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider, episode_id));
    CREATE TABLE IF NOT EXISTS shelfcheck_coverage_evidence(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);`);
  addReportMissingColumn(db);
  retireOwnershipCorrections(db);
  return db;
}

// Report Missing is mapping-member state keyed by provider episode, so it
// follows membership and is deleted with its mapping. Existing members start off.
const reportMissingDatabases = new WeakSet<DatabaseSync>();
function addReportMissingColumn(db: DatabaseSync) {
  if (reportMissingDatabases.has(db)) return;
  const columns = db.prepare("PRAGMA table_info(shelfcheck_coverage_members)").all() as { name: string }[];
  if (!columns.some(column => column.name === "report_missing")) db.exec("ALTER TABLE shelfcheck_coverage_members ADD COLUMN report_missing INTEGER NOT NULL DEFAULT 0");
  reportMissingDatabases.add(db);
}

// Ownership corrections were retired: complete-set Manual Matches stand alone.
// Discard saved corrections without converting them into any other decision, and
// ask for a comparison when they may have shaped the cached results.
const retiredCorrectionDatabases = new WeakSet<DatabaseSync>();
function retireOwnershipCorrections(db: DatabaseSync) {
  if (retiredCorrectionDatabases.has(db)) return;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shelfcheck_coverage_corrections'").get()) { retiredCorrectionDatabases.add(db); return; }
  const saved = db.prepare("SELECT COUNT(*) AS count FROM shelfcheck_coverage_corrections").get() as { count: number };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TABLE shelfcheck_coverage_corrections");
    if (saved.count) db.exec("UPDATE shelfcheck_coverage_state SET revision=revision+1,pending=1 WHERE id=1");
    db.exec("COMMIT");
    retiredCorrectionDatabases.add(db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Generated provider catalogues and inputs do not pass through report ignore pruning.
function plexInputsDatabase() {
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS shelfcheck_plex_generated_inputs (cache_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)");
  return db;
}
export function readPlexGeneratedInputs<T>(key: string): T | null {
  const row = plexInputsDatabase().prepare("SELECT payload FROM shelfcheck_plex_generated_inputs WHERE cache_key=?").get(key) as {payload:string}|undefined;
  return parseStoredJson<T|null>(row?.payload, null);
}
export function listPlexGeneratedInputs<T>(prefix: string): Record<string, T> {
  const rows = plexInputsDatabase().prepare("SELECT cache_key,payload FROM shelfcheck_plex_generated_inputs WHERE cache_key LIKE ?").all(`${prefix}%`) as {cache_key:string;payload:string}[];
  return Object.fromEntries(rows.flatMap(row => {
    const value = parseStoredJson<T|null>(row.payload, null);
    return value === null ? [] : [[row.cache_key.slice(prefix.length), value]];
  }));
}
export function writePlexGeneratedInputs<T>(key: string, inputs: T) {
  plexInputsDatabase().prepare("INSERT INTO shelfcheck_plex_generated_inputs(cache_key,payload) VALUES(?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload").run(key, JSON.stringify(inputs));
}
export function deletePlexGeneratedInputs() {
  // Scan accounting and provider verification positions survive explicit catalogue/report clearing.
  plexInputsDatabase().exec("DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key NOT IN ('full-scan','completed-full-scan','provider-verification','pending-safeguards')");
}
