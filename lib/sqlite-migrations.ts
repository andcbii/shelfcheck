import "server-only";

import type { DatabaseSync } from "node:sqlite";

// Every table is created and upgraded here, by numbered migrations tracked by the
// database's user_version. Version 0 means unversioned, not empty: databases written
// before migrations existed carry their tables at version 0. Append new migrations;
// never edit one that has shipped.
const migrations: ((db: DatabaseSync) => void)[] = [
  baselineSchema,
];

export const SCHEMA_VERSION = migrations.length;

function userVersion(db: DatabaseSync) {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function newerDatabaseError(found: number) {
  return new Error(`This Shelfcheck database is at schema version ${found}, newer than this Shelfcheck supports (${SCHEMA_VERSION}). Run a newer Shelfcheck, or restore a backup made for this version.`);
}

/** Refuse, before anything is written, a database from a newer Shelfcheck. */
export function refuseNewerDatabase(db: DatabaseSync) {
  const found = userVersion(db);
  if (found > SCHEMA_VERSION) throw newerDatabaseError(found);
}

/** Apply every pending migration in one write transaction, or none of them. */
export function migrateDatabase(db: DatabaseSync) {
  if (userVersion(db) === SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another connection may have migrated while this one waited for the write lock.
    const found = userVersion(db);
    if (found > SCHEMA_VERSION) throw newerDatabaseError(found);
    for (let next = found; next < SCHEMA_VERSION; next++) migrations[next](db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function hasTable(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnsOf(db: DatabaseSync, table: string) {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
}

// Today's layout. Older releases created these tables lazily, so any subset may exist.
const BASELINE_TABLES: { name: string; sql: string }[] = [
  { name: "shelfcheck_states", sql: `CREATE TABLE shelfcheck_states(
    user_id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )` },
  { name: "shelfcheck_scan_status", sql: `CREATE TABLE shelfcheck_scan_status(
    user_id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )` },
  { name: "shelfcheck_plex_state", sql: `CREATE TABLE shelfcheck_plex_state(
    user_id TEXT PRIMARY KEY NOT NULL,
    report TEXT,
    checkpoint TEXT,
    scan_status TEXT NOT NULL DEFAULT '{}',
    settings TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )` },
  { name: "shelfcheck_coverage_state", sql: "CREATE TABLE shelfcheck_coverage_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0)" },
  { name: "shelfcheck_coverage_mappings", sql: "CREATE TABLE shelfcheck_coverage_mappings(id TEXT PRIMARY KEY, payload TEXT NOT NULL)" },
  // Report Missing is mapping-member state keyed by provider episode, so it
  // follows membership and is deleted with its mapping. Existing members start off.
  { name: "shelfcheck_coverage_members", sql: "CREATE TABLE shelfcheck_coverage_members(provider TEXT NOT NULL, episode_id INTEGER NOT NULL, mapping_id TEXT NOT NULL REFERENCES shelfcheck_coverage_mappings(id) ON DELETE CASCADE, report_missing INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider, episode_id))" },
  { name: "shelfcheck_coverage_evidence", sql: "CREATE TABLE shelfcheck_coverage_evidence(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)" },
  { name: "shelfcheck_coverage_issues", sql: "CREATE TABLE shelfcheck_coverage_issues(id TEXT PRIMARY KEY,payload TEXT NOT NULL)" },
  { name: "shelfcheck_coverage_previews", sql: "CREATE TABLE shelfcheck_coverage_previews(id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires INTEGER NOT NULL)" },
  // Catalogue selection for shows with several Plex provider IDs. Overrides are user
  // decisions and candidate sets are observed Plex state, so neither is a generated
  // input: clearing the cache or saving Plex settings leaves them in place.
  // Candidates are the last completely observed set; selections record the catalogue
  // a scan chose to use, kept apart so a temporary fallback cannot erase a preference.
  { name: "shelfcheck_catalogue_candidates", sql: "CREATE TABLE shelfcheck_catalogue_candidates(identity TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('tmdb','tvdb')), series_id INTEGER NOT NULL, name TEXT, PRIMARY KEY(identity, provider, series_id))" },
  { name: "shelfcheck_catalogue_overrides", sql: "CREATE TABLE shelfcheck_catalogue_overrides(identity TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('tmdb','tvdb')), series_id INTEGER NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(identity, provider))" },
  { name: "shelfcheck_catalogue_selections", sql: `CREATE TABLE shelfcheck_catalogue_selections(identity TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('tmdb','tvdb')), preferred_id INTEGER, using_id INTEGER, state TEXT NOT NULL, selected_at TEXT NOT NULL,
      preferred_downloaded_at TEXT, preferred_usable_until TEXT, preferred_failed_at TEXT, using_downloaded_at TEXT, using_failed_at TEXT, derived_from INTEGER, PRIMARY KEY(identity, provider))` },
  // Generated provider catalogues and inputs do not pass through report ignore pruning.
  { name: "shelfcheck_plex_generated_inputs", sql: "CREATE TABLE shelfcheck_plex_generated_inputs(cache_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)" },
];

// Columns older releases added to existing tables when they were first used.
const LEGACY_COLUMNS: { table: string; column: string; sql: string }[] = [
  { table: "shelfcheck_plex_state", column: "settings", sql: "ALTER TABLE shelfcheck_plex_state ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'" },
  { table: "shelfcheck_plex_state", column: "checkpoint", sql: "ALTER TABLE shelfcheck_plex_state ADD COLUMN checkpoint TEXT" },
  { table: "shelfcheck_coverage_members", column: "report_missing", sql: "ALTER TABLE shelfcheck_coverage_members ADD COLUMN report_missing INTEGER NOT NULL DEFAULT 0" },
];

/**
 * Migration 1: bring an unversioned database (empty, today's layout, or an older
 * sparse one) to today's schema without erasing anything it already holds.
 */
function baselineSchema(db: DatabaseSync) {
  const existing = BASELINE_TABLES.filter(table => hasTable(db, table.name));
  for (const table of BASELINE_TABLES) if (!hasTable(db, table.name)) db.exec(table.sql);
  for (const { table, column, sql } of LEGACY_COLUMNS) if (!columnsOf(db, table).has(column)) db.exec(sql);
  refuseIncompatibleTables(db, existing.map(table => table.name));
  db.exec("INSERT OR IGNORE INTO shelfcheck_coverage_state(id) VALUES(1)");
  retireOwnershipCorrections(db);
}

/** An existing table this version cannot read must stop the upgrade, never be stamped current. */
function refuseIncompatibleTables(db: DatabaseSync, names: string[]) {
  for (const name of names) {
    const expected = expectedColumns(db, name);
    const found = columnsOf(db, name);
    const missing = [...expected].filter(column => !found.has(column));
    if (missing.length) throw new Error(`Shelfcheck cannot upgrade this database: table ${name} has no ${missing.join(", ")} column${missing.length > 1 ? "s" : ""}. Restore a backup or use a new data directory.`);
  }
}

/** Columns of today's definition, read from a temporary table built from it. */
function expectedColumns(db: DatabaseSync, name: string) {
  const table = BASELINE_TABLES.find(candidate => candidate.name === name)!;
  db.exec(table.sql.replace(`CREATE TABLE ${name}(`, "CREATE TEMP TABLE shelfcheck_expected_columns("));
  try {
    return new Set((db.prepare("PRAGMA temp.table_info(shelfcheck_expected_columns)").all() as { name: string }[]).map(column => column.name));
  } finally {
    db.exec("DROP TABLE temp.shelfcheck_expected_columns");
  }
}

// Ownership corrections were retired: complete-set Manual Matches stand alone.
// Discard saved corrections without converting them into any other decision, and
// ask for a comparison when they may have shaped the cached results.
function retireOwnershipCorrections(db: DatabaseSync) {
  if (!hasTable(db, "shelfcheck_coverage_corrections")) return;
  const saved = db.prepare("SELECT COUNT(*) AS count FROM shelfcheck_coverage_corrections").get() as { count: number };
  db.exec("DROP TABLE shelfcheck_coverage_corrections");
  if (saved.count) db.exec("UPDATE shelfcheck_coverage_state SET revision=revision+1,pending=1 WHERE id=1");
}
