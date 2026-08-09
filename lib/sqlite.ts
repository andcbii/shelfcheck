import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SINGLE_USER_ID = "single-user";

type DatabaseCache = typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

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

export function dataDirectory() {
  return process.env.SHELFCHECK_DATA_DIR || path.join(process.cwd(), ".runtime", "data");
}

function database() {
  const cache = globalThis as DatabaseCache;
  if (cache.__shelfcheckDatabase) return cache.__shelfcheckDatabase;

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
  database().prepare(`INSERT INTO shelfcheck_states (user_id, payload, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(state));
}

export function patchSingleUserState<T extends Record<string, unknown>>(patch: T) {
  const current = readSingleUserState<Record<string, unknown>>();
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
  database().prepare(`INSERT INTO shelfcheck_plex_state (user_id, report, scan_status, updated_at)
    VALUES (?, ?, '{}', CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET report = excluded.report, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(report));
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
  database().prepare(`INSERT INTO shelfcheck_plex_state (user_id, checkpoint, scan_status, updated_at)
    VALUES (?, ?, '{}', CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET checkpoint = excluded.checkpoint, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(checkpoint));
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
  database().prepare(`INSERT INTO shelfcheck_plex_state (user_id, settings, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(settings));
}
