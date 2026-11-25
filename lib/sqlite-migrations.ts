import "server-only";

import { renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Every table is created and upgraded here, by numbered migrations tracked by the
// database's user_version. Version 0 means unversioned, not empty: databases written
// before migrations existed carry their tables at version 0. Append new migrations;
// never edit one that has shipped. A migration may return a line to log once the whole
// upgrade has committed, so the log never reports a change that rolled back.
const migrations: ((db: DatabaseSync) => string | void)[] = [
  baselineSchema,
  plexSavedScanState,
  traktSavedScanState,
  clearTraktResultsBeforeAirDates,
  seriesNotFoundHistory,
  lookupKeyReset,
  carriedCoverageMembers,
  manualMatchHealthRetired,
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

// The one backup taken before migrations first change a database written by an
// earlier release: shelfcheck-pre-migration-backup.db, next to shelfcheck.db. To roll
// back, stop Shelfcheck and restore this file as shelfcheck.db with the old image.
// It is written under a ".partial" name and renamed into place only once complete,
// so a file at the backup name is a complete backup and is never replaced. A file
// there that is not a readable database with tables stops the upgrade instead.
export const BACKUP_FILE_NAME = "shelfcheck-pre-migration-backup.db";

/**
 * Back up an unversioned database that already holds tables, before its first
 * migration. Throws, so that nothing is migrated, if the backup cannot be written.
 */
export function backupBeforeFirstMigration(db: DatabaseSync, file: string) {
  if (userVersion(db) !== 0) return;
  const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get() as { count: number };
  if (!tables.count) return;
  const backup = path.join(path.dirname(file), BACKUP_FILE_NAME);
  if (statSync(backup, { throwIfNoEntry: false })?.isFile()) {
    refuseUnusableBackup(backup);
    return;
  }
  const partial = `${backup}.partial`;
  rmSync(partial, { force: true });
  // VACUUM INTO reads through this connection, so committed data still in the WAL is included.
  try {
    db.prepare("VACUUM INTO ?").run(partial);
    renameSync(partial, backup);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

/** An earlier backup counts only if it opens, passes quick_check and holds at least one table. */
function refuseUnusableBackup(backup: string) {
  let usable = false;
  try {
    const db = new DatabaseSync(backup, { readOnly: true });
    try {
      const check = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
      const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number };
      usable = check.length === 1 && check[0].quick_check === "ok" && tables.count > 0;
    } finally {
      db.close();
    }
  } catch {
    usable = false;
  }
  if (!usable) throw new Error(`Shelfcheck will not upgrade this database: ${backup} is not a usable backup. Move that file aside, or restore it as the database if it is one, then start Shelfcheck again.`);
}

/** Apply every pending migration in one write transaction, or none of them. */
export function migrateDatabase(db: DatabaseSync) {
  if (userVersion(db) === SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  const committedLog: string[] = [];
  try {
    // Another connection may have migrated while this one waited for the write lock.
    const found = userVersion(db);
    if (found > SCHEMA_VERSION) throw newerDatabaseError(found);
    // A database being created has nothing to upgrade, so its migrations log nothing.
    const created = found === 0 && !hasAnyTable(db);
    for (let next = found; next < SCHEMA_VERSION; next++) {
      const line = migrations[next](db);
      if (line && !created) committedLog.push(line);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  for (const line of committedLog) console.info(line);
}

function hasAnyTable(db: DatabaseSync) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get());
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
  // Manual rules are durable instance data, independent of generated scan state.
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

type ColumnInfo = { name: string; type: string; notnull: number; pk: number };

function columnInfo(db: DatabaseSync, table: string) {
  return new Map((db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).map(column => [column.name, column]));
}

/**
 * An existing table this version cannot read must stop the upgrade, never be stamped
 * current. Each of today's columns must exist with the same declared type, NOT NULL and
 * primary-key position. No release ever created a column today's layout lacks, and
 * some saves insert by position, so any extra column is refused too.
 */
function refuseIncompatibleTables(db: DatabaseSync, names: string[]) {
  for (const name of names) {
    const found = columnInfo(db, name);
    const expected = [...expectedColumns(name).values()];
    const missing = expected.filter(column => !found.has(column.name)).map(column => column.name);
    if (missing.length) throw incompatibleTableError(`table ${name} has no ${missing.join(", ")} column${missing.length > 1 ? "s" : ""}`);
    const changed = expected.filter(({ name: column, type, notnull, pk }) => {
      const actual = found.get(column)!;
      return actual.type.toUpperCase() !== type.toUpperCase() || actual.notnull !== notnull || actual.pk !== pk;
    }).map(column => column.name);
    if (changed.length) throw incompatibleTableError(`table ${name} has an incompatible ${changed.join(", ")} column${changed.length > 1 ? "s" : ""}`);
    const extra = [...found.keys()].filter(column => !expected.some(candidate => candidate.name === column));
    if (extra.length) throw incompatibleTableError(`table ${name} has an unexpected ${extra.join(", ")} column${extra.length > 1 ? "s" : ""}`);
  }
}

function incompatibleTableError(reason: string) {
  return new Error(`Shelfcheck cannot upgrade this database: ${reason}. Restore a backup or use a new data directory.`);
}

/** Columns of today's definition, read from the table built in a private in-memory database. */
function expectedColumns(name: string) {
  const table = BASELINE_TABLES.find(candidate => candidate.name === name)!;
  const scratch = new DatabaseSync(":memory:");
  try {
    scratch.exec(table.sql);
    return columnInfo(scratch, name);
  } finally {
    scratch.close();
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

// The saved scan state of every scan mode: one row per mode, created on its first save.
// report, resume_point and status are nullable JSON. options is the mode's JSON object of
// Settings and Ignore Preferences together, NULL until the mode first saves state.
// state_updated_at moves with report, Resume point and options writes, never with status
// writes, so a scan heartbeat does not change when the saved state last changed.
const SAVED_SCAN_STATE_TABLE = `CREATE TABLE shelfcheck_scan_state(
  mode TEXT PRIMARY KEY NOT NULL CHECK(mode IN ('trakt','plex')),
  report TEXT,
  resume_point TEXT,
  status TEXT,
  options TEXT,
  state_updated_at TEXT
)`;

/** A legacy JSON object, or the fallback when it is missing, invalid or not an object, as its reads always did. */
function legacyObject(payload: string | null | undefined) {
  if (!payload) return {};
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Migration 2: move Plex to the saved scan state. Its settings become its options; its
 * report, Resume point and scan status are discarded, so the next Plex scan is a full
 * scan. The old Plex table is dropped. The Trakt row is created by its first save.
 */
function plexSavedScanState(db: DatabaseSync) {
  db.exec(SAVED_SCAN_STATE_TABLE);
  const legacy = db.prepare("SELECT settings, updated_at FROM shelfcheck_plex_state WHERE user_id = 'single-user'")
    .get() as { settings: string; updated_at: string } | undefined;
  if (legacy) {
    db.prepare("INSERT INTO shelfcheck_scan_state(mode, options, state_updated_at) VALUES('plex', ?, ?)")
      .run(JSON.stringify(legacyObject(legacy.settings)), legacy.updated_at);
  }
  db.exec("DROP TABLE shelfcheck_plex_state");
}

/**
 * Migration 3: move Trakt to the saved scan state. Its saved record, less its report,
 * Resume point (checkpoint) and legacy scan status, becomes its options, unknown fields
 * included; the report, Resume point and scan status are discarded, so the next Trakt
 * scan is a full scan. Both old Trakt tables are dropped.
 */
function traktSavedScanState(db: DatabaseSync) {
  const legacy = db.prepare("SELECT payload, updated_at FROM shelfcheck_states WHERE user_id = 'single-user'")
    .get() as { payload: string; updated_at: string } | undefined;
  if (legacy) {
    const options: Record<string, unknown> = { ...legacyObject(legacy.payload) };
    delete options.report;
    delete options.checkpoint;
    delete options.scan;
    db.prepare("INSERT INTO shelfcheck_scan_state(mode, options, state_updated_at) VALUES('trakt', ?, ?)")
      .run(JSON.stringify(options), legacy.updated_at);
  }
  db.exec("DROP TABLE shelfcheck_states");
  db.exec("DROP TABLE shelfcheck_scan_status");
}

/**
 * Migration 4: clear the Trakt report and Resume point saved before Trakt kept every
 * missing episode with its air date. Those reports already left out episodes inside the
 * Air-date delay, so none of their results or scan cache can be reused; the next Trakt
 * scan is a full scan. Trakt options and scan status, and the Plex row, are kept, and a
 * database with no Trakt row stays without one.
 */
function clearTraktResultsBeforeAirDates(db: DatabaseSync) {
  db.exec(`UPDATE shelfcheck_scan_state SET report = NULL, resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP
    WHERE mode = 'trakt' AND (report IS NOT NULL OR resume_point IS NOT NULL)`);
}

/**
 * Migration 5: the 404 history of provider series requests (ADR-0006). One row per provider and
 * series ID with at least one counted 404 day since its last complete catalogue download; a missing
 * row counts 0. It is provider state shared by every show reporting the ID, not a generated input,
 * so clearing the cache leaves it in place. `last_counted_day` is the UTC date (YYYY-MM-DD) of the
 * latest counted 404, so later 404s that day do not count again.
 */
function seriesNotFoundHistory(db: DatabaseSync) {
  db.exec(`CREATE TABLE shelfcheck_series_not_found(
    provider TEXT NOT NULL CHECK(provider IN ('tmdb','tvdb')),
    series_id INTEGER NOT NULL,
    counted_days INTEGER NOT NULL,
    last_counted_day TEXT NOT NULL,
    PRIMARY KEY(provider, series_id)
  )`);
}

/** The generated inputs migration 6 keeps: scan accounting, provider verification positions and pending safeguards. */
// Deliberately a copy of plex-catalogues' keptByFullClear, not an import: a shipped migration must not follow later app code changes.
const KEPT_BY_LOOKUP_KEY_RESET = ["full-scan", "completed-full-scan", "provider-verification", "pending-safeguards"];
const LOOKUP_ISSUE_PREFIX = "episode-identity:";

/** A stored JSON object, or undefined when the text is missing, invalid or not an object. */
function storedObject(payload: string | null | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Migration 6: saved provider relationships and lookup Coverage Issues move from URL-shaped keys to
 * lookup keys (`<kind>:<inputs>`), with no reader for the old keys, so everything saved under them is
 * cleared once (SHELFCHECK-40):
 * - every generated input except scan accounting, provider verification positions and pending
 *   safeguards: catalogues, inventory, comparisons with their relationships and IMDb identities, and
 *   shared crosswalk evidence, as a full Clear cache does;
 * - the Plex report's scan cache and the Plex Resume point, which carry IMDb identities too; the
 *   report's results, Plex status and options, and the Trakt row are kept;
 * - every `episode-identity:` Coverage Issue, and only the links to those issues in other issues'
 *   causes. Every other issue keeps its own cause and surviving links.
 * Decisions (Manual Matches, Report Missing flags, Ignores, catalogue overrides and selections),
 * credentials and the series 404 history live elsewhere and are untouched. Nothing is requested: the
 * next full Plex scan downloads catalogues again.
 */
function lookupKeyReset(db: DatabaseSync) {
  const generated = db.prepare(`DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key NOT IN (${KEPT_BY_LOOKUP_KEY_RESET.map(() => "?").join(",")})`)
    .run(...KEPT_BY_LOOKUP_KEY_RESET).changes;

  let scanState = 0;
  const plex = db.prepare("SELECT report, resume_point FROM shelfcheck_scan_state WHERE mode = 'plex'").get() as { report: string | null; resume_point: string | null } | undefined;
  if (plex) {
    const report = storedObject(plex.report);
    const cachedReport = report && Object.hasOwn(report, "scanCache");
    if (cachedReport) delete report.scanCache;
    if (cachedReport || plex.resume_point !== null) {
      db.prepare("UPDATE shelfcheck_scan_state SET report = ?, resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP WHERE mode = 'plex'")
        .run(cachedReport ? JSON.stringify(report) : plex.report);
      scanState = 1;
    }
  }

  // An exact prefix match: substr is case-sensitive and has no wildcards.
  const removed = new Set((db.prepare("SELECT id FROM shelfcheck_coverage_issues WHERE substr(id, 1, ?) = ?").all(LOOKUP_ISSUE_PREFIX.length, LOOKUP_ISSUE_PREFIX) as { id: string }[]).map(row => row.id));
  if (removed.size) {
    db.prepare("DELETE FROM shelfcheck_coverage_issues WHERE substr(id, 1, ?) = ?").run(LOOKUP_ISSUE_PREFIX.length, LOOKUP_ISSUE_PREFIX);
    const rows = db.prepare("SELECT id, payload FROM shelfcheck_coverage_issues").all() as { id: string; payload: string }[];
    const rewrite = db.prepare("UPDATE shelfcheck_coverage_issues SET payload = ? WHERE id = ?");
    for (const row of rows) {
      const issue = storedObject(row.payload);
      if (!issue || !Array.isArray(issue.causedBy) || !issue.causedBy.some(parent => removed.has(parent))) continue;
      const surviving = issue.causedBy.filter(parent => !removed.has(parent));
      if (surviving.length) issue.causedBy = surviving;
      else delete issue.causedBy;
      rewrite.run(JSON.stringify(issue), row.id);
    }
  }

  return generated || scanState || removed.size
    ? "Shelfcheck cleared its saved Plex scan data for the new provider lookup keys. Run a full Plex scan to download provider catalogues again; Manual Matches, Report Missing flags, Ignores, catalogue choices and settings were kept."
    : "Shelfcheck moved to the new provider lookup keys; there was no saved Plex scan data to clear.";
}

/**
 * Migration 7: carried Manual Match members (SHELFCHECK-154). Each committed Manual Match change
 * records the members whose shows need a cached recheck, one row per member and show placement,
 * with the coverage revision that recorded it. A cached recheck or a committed full Plex scan run
 * removes those whose shows it compared. Only a new table: every existing record is kept, and a database upgraded with
 * a pending comparison keeps it, without carried members, until a recheck or full scan completes it.
 */
function carriedCoverageMembers(db: DatabaseSync) {
  db.exec(`CREATE TABLE shelfcheck_coverage_carried(
    provider TEXT NOT NULL,
    episode_id INTEGER NOT NULL,
    show_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(provider, episode_id, show_id)
  )`);
}

/**
 * The operation of the member-verification Coverage Issues Manual Match health produced, which also
 * began their IDs. A literal, as historical migrations keep their own IDs.
 */
const MEMBER_VERIFICATION = "member-verification";

/**
 * Migration 8: Manual Match health is retired (ADR-0008), so every saved Manual Match can grant
 * coverage. Removes:
 * - `health` and `healthMessage` from every saved Manual Match, keeping its members and revision;
 * - every member-verification Coverage Issue (by its ID prefix or its operation), and only the links
 *   to those issues in other issues' causes;
 * - the Plex Resume point, whose results were compared while Pending and Needs review matches
 *   granted no coverage;
 * - the health each coverage group of the saved Plex report carried, so it is never served again.
 * Saved catalogues, the rest of the Plex report (with its scan cache) and every other record are
 * kept, so the next Plex scan is an ordinary scan: no download sweep and no forced recompare. Logs
 * only when it changed something.
 */
function manualMatchHealthRetired(db: DatabaseSync) {
  let mappings = 0;
  const rewriteMapping = db.prepare("UPDATE shelfcheck_coverage_mappings SET payload = ? WHERE id = ?");
  for (const row of db.prepare("SELECT id, payload FROM shelfcheck_coverage_mappings").all() as { id: string; payload: string }[]) {
    const mapping = storedObject(row.payload);
    if (!mapping || (!Object.hasOwn(mapping, "health") && !Object.hasOwn(mapping, "healthMessage"))) continue;
    delete mapping.health;
    delete mapping.healthMessage;
    rewriteMapping.run(JSON.stringify(mapping), row.id);
    mappings++;
  }

  const issues = db.prepare("SELECT id, payload FROM shelfcheck_coverage_issues").all() as { id: string; payload: string }[];
  const removed = new Set(issues.filter(row => row.id.startsWith(`${MEMBER_VERIFICATION}:`) || storedObject(row.payload)?.operation === MEMBER_VERIFICATION).map(row => row.id));
  if (removed.size) {
    const remove = db.prepare("DELETE FROM shelfcheck_coverage_issues WHERE id = ?");
    for (const id of removed) remove.run(id);
    const rewrite = db.prepare("UPDATE shelfcheck_coverage_issues SET payload = ? WHERE id = ?");
    for (const row of issues) {
      if (removed.has(row.id)) continue;
      const issue = storedObject(row.payload);
      if (!issue || !Array.isArray(issue.causedBy) || !issue.causedBy.some(parent => removed.has(parent))) continue;
      const surviving = issue.causedBy.filter(parent => !removed.has(parent));
      if (surviving.length) issue.causedBy = surviving;
      else delete issue.causedBy;
      rewrite.run(JSON.stringify(issue), row.id);
    }
  }

  const resumePoint = db.prepare("UPDATE shelfcheck_scan_state SET resume_point = NULL, state_updated_at = CURRENT_TIMESTAMP WHERE mode = 'plex' AND resume_point IS NOT NULL").run().changes;

  let reportGroups = 0;
  const plex = db.prepare("SELECT report FROM shelfcheck_scan_state WHERE mode = 'plex'").get() as { report: string | null } | undefined;
  const report = storedObject(plex?.report);
  if (report && Array.isArray(report.coverageGroups)) {
    for (const group of report.coverageGroups as unknown[]) {
      if (group === null || typeof group !== "object" || !Object.hasOwn(group, "health")) continue;
      delete (group as Record<string, unknown>).health;
      reportGroups++;
    }
    if (reportGroups) db.prepare("UPDATE shelfcheck_scan_state SET report = ?, state_updated_at = CURRENT_TIMESTAMP WHERE mode = 'plex'").run(JSON.stringify(report));
  }

  if (mappings || removed.size || resumePoint || reportGroups)
    return "Shelfcheck retired Manual Match health: every saved Manual Match can now grant coverage. Its member checks and the Plex Resume point were cleared; the next Plex scan is an ordinary scan.";
}
