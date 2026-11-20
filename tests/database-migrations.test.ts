import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const sqlite = await import("../lib/sqlite");
const traktScan = await import("../lib/scan");
const plexScan = await import("../lib/plex-scan");
const scanRun = await import("../lib/scan-run");
const { BACKUP_FILE_NAME } = await import("../lib/sqlite-migrations");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanIgnoreGuards?: object };
const closeCached = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };

const EVERY_TABLE = [
  "shelfcheck_catalogue_candidates", "shelfcheck_catalogue_overrides", "shelfcheck_catalogue_selections",
  "shelfcheck_coverage_evidence", "shelfcheck_coverage_issues", "shelfcheck_coverage_mappings", "shelfcheck_coverage_members",
  "shelfcheck_coverage_previews", "shelfcheck_coverage_state", "shelfcheck_plex_generated_inputs", "shelfcheck_scan_state",
];

/** The database file in a disposable data directory, opened fresh: no cached handle survives into or out of it. */
function freshDatabaseFile(t: TestContext) {
  closeCached();
  const dir = mkdtempSync(path.join(tmpdir(), "shelfcheck-migrations-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    closeCached();
    delete cache.__shelfcheckScanIgnoreGuards;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR;
    else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, "shelfcheck.db");
}

/** Read a database file through its own connection, never the cached handle. Read-only fails on a missing file instead of creating it. */
function inspect<T>(file: string, read: (db: DatabaseSync) => T, options: { readOnly?: boolean } = {}): T {
  const db = new DatabaseSync(file, options);
  try { return read(db); } finally { db.close(); }
}
// A local reader, so the migration module need not export its private user_version helper.
const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'shelfcheck_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);

test("opening an empty data directory creates every table at the current version", (t) => {
  const file = freshDatabaseFile(t);
  assert.equal(sqlite.savedScanState("trakt").snapshot(), null);
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 4);
    assert.deepEqual(tables(db), EVERY_TABLE);
  });
});

/** Write a raw database the way an earlier release left it, then close it. */
function fixture(file: string, sql: string, seed?: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  db.exec(sql);
  seed?.(db);
  db.close();
}

const TODAY_LAYOUT = `
  CREATE TABLE shelfcheck_states (user_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE shelfcheck_scan_status (user_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE shelfcheck_plex_state (user_id TEXT PRIMARY KEY NOT NULL, report TEXT, checkpoint TEXT, scan_status TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE shelfcheck_coverage_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE shelfcheck_coverage_mappings(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE shelfcheck_coverage_members(provider TEXT NOT NULL, episode_id INTEGER NOT NULL, mapping_id TEXT NOT NULL REFERENCES shelfcheck_coverage_mappings(id) ON DELETE CASCADE, report_missing INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider, episode_id));
  CREATE TABLE shelfcheck_coverage_evidence(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
  CREATE TABLE shelfcheck_coverage_issues(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
  CREATE TABLE shelfcheck_coverage_previews(id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE shelfcheck_catalogue_candidates(identity TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('tmdb','tvdb')), series_id INTEGER NOT NULL, name TEXT, PRIMARY KEY(identity, provider, series_id));
  CREATE TABLE shelfcheck_catalogue_overrides(identity TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('tmdb','tvdb')), series_id INTEGER NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(identity, provider));
  CREATE TABLE shelfcheck_catalogue_selections(identity TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('tmdb','tvdb')), preferred_id INTEGER, using_id INTEGER, state TEXT NOT NULL, selected_at TEXT NOT NULL,
    preferred_downloaded_at TEXT, preferred_usable_until TEXT, preferred_failed_at TEXT, using_downloaded_at TEXT, using_failed_at TEXT, derived_from INTEGER, PRIMARY KEY(identity, provider));
  CREATE TABLE shelfcheck_plex_generated_inputs (cache_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
  INSERT INTO shelfcheck_coverage_state(id,revision,pending) VALUES(1,7,1);
`;
const GENERATED_KEYS = ["full-scan", "completed-full-scan", "provider-verification", "pending-safeguards", "tmdb:1", "tvdb:2", "comparison:3", "inventory", "deferred-tmdb", "pending-tvdb", "tmdb-crosswalk:4"];

/** Every row of every Shelfcheck table, in a stable order. */
function everyRow(db: DatabaseSync) {
  return Object.fromEntries(tables(db).map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1, 2`).all().map(row => ({ ...row }))]));
}
/** Table and trigger definitions: the logical schema. */
const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row }));

test("opening an older sparse layout adds missing tables and columns without erasing data", (t) => {
  const file = freshDatabaseFile(t);
  fixture(file, `
    CREATE TABLE shelfcheck_states (user_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE shelfcheck_plex_state (user_id TEXT PRIMARY KEY NOT NULL, report TEXT, scan_status TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE shelfcheck_coverage_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
    INSERT INTO shelfcheck_coverage_state(id,revision,pending) VALUES(1,3,0);
    CREATE TABLE shelfcheck_coverage_mappings(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE shelfcheck_coverage_members(provider TEXT NOT NULL, episode_id INTEGER NOT NULL, mapping_id TEXT NOT NULL REFERENCES shelfcheck_coverage_mappings(id) ON DELETE CASCADE, PRIMARY KEY(provider, episode_id));
    INSERT INTO shelfcheck_coverage_mappings VALUES('m','{"id":"m"}');
    INSERT INTO shelfcheck_coverage_members VALUES('TMDB',1,'m');
    INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user','{"diagnostics":true}');
    INSERT INTO shelfcheck_plex_state(user_id,report,scan_status) VALUES('single-user','{"shows":[]}','{"status":"completed"}');
  `);

  assert.deepEqual(sqlite.savedScanState("plex").snapshot(), { report: null, resumePoint: null, status: null, options: {}, updatedAt: sqlite.savedScanState("plex").snapshot()!.updatedAt },
    "Plex Settings missing from an older table start empty; its report and status are discarded");
  assert.deepEqual(sqlite.savedScanState("trakt").snapshot()?.options, { diagnostics: true });
  assert.equal(sqlite.savedScanState("trakt").status.read(), null, "A missing Trakt status table has no status");
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 4);
    assert.deepEqual(tables(db), EVERY_TABLE);
    assert.deepEqual(db.prepare("SELECT provider,episode_id,mapping_id,report_missing FROM shelfcheck_coverage_members").all().map(row => ({ ...row })), [{ provider: "TMDB", episode_id: 1, mapping_id: "m", report_missing: 0 }], "Older members gain Report Missing off");
    assert.deepEqual({ ...db.prepare("SELECT revision,pending FROM shelfcheck_coverage_state").get() }, { revision: 3, pending: 0 });
  });
});

// A release that still saved ownership corrections, before members carried Report Missing.
const CORRECTIONS_LAYOUT = `
  CREATE TABLE shelfcheck_coverage_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
  INSERT INTO shelfcheck_coverage_state(id,revision,pending) VALUES(1,4,0);
  CREATE TABLE shelfcheck_coverage_mappings(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE shelfcheck_coverage_members(provider TEXT NOT NULL, episode_id INTEGER NOT NULL, mapping_id TEXT NOT NULL REFERENCES shelfcheck_coverage_mappings(id) ON DELETE CASCADE, PRIMARY KEY(provider, episode_id));
  INSERT INTO shelfcheck_coverage_mappings VALUES('kept','{"id":"kept"}');
  INSERT INTO shelfcheck_coverage_members VALUES('TMDB',100,'kept'),('TVDB',200,'kept');
  CREATE TABLE shelfcheck_coverage_corrections(mapping_id TEXT NOT NULL,show_key TEXT NOT NULL,item_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(mapping_id,show_key,item_key));
  INSERT INTO shelfcheck_coverage_corrections VALUES('kept','show','file','{}');
`;
const coverageState = (db: DatabaseSync) => ({ ...db.prepare("SELECT revision,pending FROM shelfcheck_coverage_state").get() });

test("ownership-correction retirement runs once, with today's revision and pending effect", (t) => {
  const file = freshDatabaseFile(t);
  fixture(file, CORRECTIONS_LAYOUT);

  sqlite.savedScanState("plex").options.read();
  closeCached();
  inspect(file, db => {
    assert.deepEqual(coverageState(db), { revision: 5, pending: 1 });
    assert.equal(tables(db).includes("shelfcheck_coverage_corrections"), false);
    db.exec("UPDATE shelfcheck_coverage_state SET pending=0");
  });

  sqlite.savedScanState("plex").options.read();
  closeCached();
  inspect(file, db => assert.deepEqual(coverageState(db), { revision: 5, pending: 0 }, "A later open does not retire again"));
});

test("a database from a newer Shelfcheck is refused and left untouched", (t) => {
  const file = freshDatabaseFile(t);
  fixture(file, "CREATE TABLE shelfcheck_states (user_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL); PRAGMA user_version = 5;");
  const before = inspect(file, db => ({ schema: schema(db), journal: db.prepare("PRAGMA journal_mode").get() }));

  assert.throws(() => sqlite.savedScanState("trakt").snapshot(), /schema version 5, newer than this Shelfcheck supports \(4\)/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 5);
    assert.deepEqual({ schema: schema(db), journal: db.prepare("PRAGMA journal_mode").get() }, before);
  });
});

test("an incompatible unversioned schema is refused clearly and left unchanged", (t) => {
  const file = freshDatabaseFile(t);
  fixture(file, "CREATE TABLE shelfcheck_states (user_id TEXT PRIMARY KEY NOT NULL, data TEXT); INSERT INTO shelfcheck_states VALUES('single-user','x');");
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("trakt").snapshot(), /cannot upgrade this database: table shelfcheck_states has no payload, updated_at columns/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 0);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before);
  });
});

test("a table with today's column names but a different type, NOT NULL or key is refused and left unchanged", (t) => {
  const file = freshDatabaseFile(t);
  // user_id is no longer the key and expires is text: the names alone match today's layout.
  fixture(file, `
    CREATE TABLE shelfcheck_states (user_id TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE shelfcheck_coverage_previews(id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires TEXT);
    INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user','{}');`);
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("trakt").snapshot(), /cannot upgrade this database: table shelfcheck_states has an incompatible user_id column/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 0);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before);
  });

  inspect(file, db => db.exec("DROP TABLE shelfcheck_states"));
  assert.throws(() => sqlite.savedScanState("trakt").snapshot(), /table shelfcheck_coverage_previews has an incompatible expires column/);
  inspect(file, db => assert.equal(version(db), 0));
});

test("a table with a column no Shelfcheck release created is refused and left unchanged", (t) => {
  const file = freshDatabaseFile(t);
  // Normal saves insert by position, so even a nullable extra column would make them fail once stamped current.
  fixture(file, `
    CREATE TABLE shelfcheck_coverage_evidence(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, unexpected TEXT);
    INSERT INTO shelfcheck_coverage_evidence VALUES(1,'{"e":1}',NULL);`);
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("trakt").snapshot(), /cannot upgrade this database: table shelfcheck_coverage_evidence has an unexpected unexpected column/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 0);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before);
  });
});

test("a migration failing after a real schema change rolls back everything, and a retry succeeds once", (t) => {
  const file = freshDatabaseFile(t);
  // The trigger fires on the coverage state update that follows dropping the corrections table.
  fixture(file, `${CORRECTIONS_LAYOUT}
    CREATE TRIGGER forced_failure BEFORE UPDATE ON shelfcheck_coverage_state BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;`);
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("plex").options.read(), /forced migration failure/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 0);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before, "Logical schema and rows are unchanged");
    db.exec("DROP TRIGGER forced_failure");
  });

  sqlite.savedScanState("plex").options.read();
  closeCached();
  sqlite.savedScanState("plex").options.read();
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 4);
    assert.deepEqual(coverageState(db), { revision: 5, pending: 1 }, "The retry retires corrections exactly once");
  });
});

test("a second open runs no migration but still removes ignored results at open", (t) => {
  const file = freshDatabaseFile(t);
  sqlite.savedScanState("trakt").snapshot();
  closeCached();
  const show = (id: number) => ({ show: { title: `Show ${id}`, ids: { trakt: id } } });
  inspect(file, db => {
    // A corrections table appearing after migration would be retired only if migration 1 ran again.
    db.exec("CREATE TABLE shelfcheck_coverage_corrections(mapping_id TEXT); INSERT INTO shelfcheck_coverage_corrections VALUES('m');");
    db.prepare("INSERT INTO shelfcheck_scan_state(mode,options,report) VALUES('trakt',?,?)")
      .run(JSON.stringify({ ignoredShows: [show(1).show] }), JSON.stringify({ shows: [show(1), show(2)] }));
  });

  const report = sqlite.savedScanState("trakt").report.read() as { shows: ReturnType<typeof show>[] };
  assert.deepEqual(report.shows.map(row => row.show.ids.trakt), [2], "Ignored results are removed at open");
  closeCached();
  inspect(file, db => {
    assert.equal(tables(db).includes("shelfcheck_coverage_corrections"), true, "Migration 1 did not run again");
    assert.deepEqual(coverageState(db), { revision: 0, pending: 0 });
  });
});

const backupOf = (file: string) => path.join(path.dirname(file), BACKUP_FILE_NAME);
/** Open the backup on its own, read-only, so a missing backup fails. */
const inspectBackup = <T>(file: string, read: (db: DatabaseSync) => T) => inspect(backupOf(file), read, { readOnly: true });
const legacyOptions = { ignoredShows: [], diagnostics: true, futureOption: { kept: true } };

test("upgrading an unversioned database first writes a complete backup, including committed WAL data", (t) => {
  const file = freshDatabaseFile(t);
  fixture(file, TODAY_LAYOUT);
  // A legacy process left committed writes in the WAL: auto-checkpoint is off and its handle stays open.
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    legacy.prepare("INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user',?)").run(JSON.stringify({ ...legacyOptions, report: { shows: [{ show: { ids: { trakt: 1 } } }] }, checkpoint: { done: 1 } }));
    legacy.prepare("INSERT INTO shelfcheck_scan_status(user_id,payload) VALUES('single-user',?)").run(JSON.stringify({ status: "completed" }));
    legacy.prepare("INSERT INTO shelfcheck_plex_state(user_id,report,checkpoint,scan_status,settings) VALUES('single-user',?,?,?,?)").run("{\"shows\":[]}", "{\"done\":2}", "{\"status\":\"completed\"}", JSON.stringify({ libraries: ["1"], futureSetting: 3 }));
    legacy.exec(`INSERT INTO shelfcheck_coverage_mappings VALUES('m','{"id":"m"}');
      INSERT INTO shelfcheck_coverage_members VALUES('TMDB',1,'m',1);`);
    for (const key of GENERATED_KEYS) legacy.prepare("INSERT INTO shelfcheck_plex_generated_inputs VALUES(?,?)").run(key, JSON.stringify({ key }));
    const before = { schema: schema(legacy), rows: everyRow(legacy) };
    assert.equal(before.rows.shelfcheck_states.length, 1, "The fixture's writes are committed, but only in the WAL");

    sqlite.savedScanState("plex").options.read();
    closeCached();
    inspectBackup(file, db => {
      assert.equal(version(db), 0, "The backup holds the old, unversioned database");
      assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before, "Old schema, both modes' state, options with unknown fields and unrelated data");
    });
  } finally {
    legacy.close();
  }
});

test("when the backup cannot be written, no migration runs and the open fails", (t) => {
  const file = freshDatabaseFile(t);
  fixture(file, `${TODAY_LAYOUT} INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user','{"diagnostics":true}');`);
  // A directory where the backup belongs obstructs it the same way on every platform.
  mkdirSync(backupOf(file));
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("trakt").snapshot());
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  assert.equal(existsSync(`${backupOf(file)}.partial`), false, "The incomplete backup is removed");
  inspect(file, db => {
    assert.equal(version(db), 0, "No migration ran");
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before);
  });
});

for (const [kind, content] of [["an empty file", ""], ["a file that is not a database", "incomplete"]] as const) {
  test(`${kind} at the backup name is refused, kept and not migrated past`, (t) => {
    const file = freshDatabaseFile(t);
    fixture(file, `${TODAY_LAYOUT} INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user','{"diagnostics":true}');`);
    writeFileSync(backupOf(file), content);
    const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

    assert.throws(() => sqlite.savedScanState("trakt").snapshot(), new RegExp(`${BACKUP_FILE_NAME.replace(/\./g, "\\.")} .*not a usable backup`));
    assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
    assert.equal(readFileSync(backupOf(file), "utf8"), content, "The file at the backup name is not overwritten");
    inspect(file, db => {
      assert.equal(version(db), 0, "No migration ran");
      assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before);
    });
  });
}

test("a retry after a failed migration keeps the original backup, and a partial file never counts as one", (t) => {
  const file = freshDatabaseFile(t);
  fixture(file, `${CORRECTIONS_LAYOUT}
    CREATE TRIGGER forced_failure BEFORE UPDATE ON shelfcheck_coverage_state BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;`);
  // An interrupted earlier attempt left an incomplete file under the temporary name.
  writeFileSync(`${backupOf(file)}.partial`, "incomplete");
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("plex").options.read(), /forced migration failure/);
  inspectBackup(file, db => assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before, "The backup is the complete original, not the partial file"));
  const original = readFileSync(backupOf(file));
  inspect(file, db => db.exec("DROP TRIGGER forced_failure"));

  sqlite.savedScanState("plex").options.read();
  closeCached();
  assert.deepEqual(readFileSync(backupOf(file)), original, "The retry keeps the original backup");
  assert.deepEqual(readdirSync(path.dirname(file)).filter(name => !name.startsWith("shelfcheck.db")), [path.basename(backupOf(file))], "No second backup and no partial file");
});

test("no backup is written for a new database, on a later open, or beside a refused newer database", (t) => {
  const file = freshDatabaseFile(t);
  const directoryEntries = () => readdirSync(path.dirname(file)).filter(name => !name.startsWith("shelfcheck.db"));
  sqlite.savedScanState("trakt").snapshot();
  closeCached();
  assert.deepEqual(directoryEntries(), [], "A database that did not exist before is not backed up");

  sqlite.savedScanState("trakt").options.patch({ diagnostics: true });
  closeCached();
  sqlite.savedScanState("trakt").snapshot();
  closeCached();
  assert.deepEqual(directoryEntries(), [], "A later open with no pending migration writes no backup");

  inspect(file, db => db.exec("PRAGMA user_version = 5"));
  assert.throws(() => sqlite.savedScanState("trakt").snapshot(), /newer than this Shelfcheck supports/);
  assert.deepEqual(directoryEntries(), [], "A refused newer database gets no backup");
});

// Migration 2: Plex moves to the saved scan state.
function versionOneWithPlex(file: string, settings: string) {
  fixture(file, `${TODAY_LAYOUT} PRAGMA user_version = 1;`, db => {
    db.prepare("INSERT INTO shelfcheck_plex_state(user_id,report,checkpoint,scan_status,settings,updated_at) VALUES('single-user',?,?,?,?,'2026-01-02 03:04:05')")
      .run(JSON.stringify({ shows: [{ ratingKey: "one" }] }), JSON.stringify({ shows: [], savedAt: "x" }), JSON.stringify({ status: "running", processed: 1, total: 2 }), settings);
    db.prepare("INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user',?)").run(JSON.stringify({ diagnostics: true, report: { shows: [] } }));
  });
}

test("upgrading Plex keeps its Settings, including unknown fields, and discards its report, Resume point and scan status", (t) => {
  const file = freshDatabaseFile(t);
  const settings = { ignoredShows: [{ ratingKey: "one", title: "One" }], diagnosticsEnabled: false, futureSetting: { kept: 3 } };
  versionOneWithPlex(file, JSON.stringify(settings));

  assert.deepEqual(sqlite.savedScanState("plex").snapshot(), { report: null, resumePoint: null, status: null, options: settings, updatedAt: "2026-01-02 03:04:05" });
  assert.deepEqual(sqlite.savedScanState("trakt").options.read(), { diagnostics: true }, "Trakt moves in the same open");
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 4);
    assert.equal(tables(db).includes("shelfcheck_plex_state"), false, "The old Plex table is dropped");
  });
});

test("upgrading Plex Settings that are not a JSON object starts its options empty, as reading them always did", (t) => {
  for (const invalid of ["not json", "[1,2]", "7"]) {
    const file = freshDatabaseFile(t);
    versionOneWithPlex(file, invalid);
    assert.deepEqual(sqlite.savedScanState("plex").snapshot()?.options, {}, invalid);
    closeCached();
  }
});

test("after the upgrade, new Plex state survives a close and reopen, so the wipe happens once", (t) => {
  const file = freshDatabaseFile(t);
  versionOneWithPlex(file, "{}");
  const plex = sqlite.savedScanState("plex");
  plex.report.write({ shows: [{ ratingKey: "new" }] });
  plex.resumePoint.write({ savedAt: "later" });
  plex.status.write({ status: "completed" });
  closeCached();
  assert.deepEqual(plex.snapshot(), { report: { shows: [{ ratingKey: "new" }] }, resumePoint: { savedAt: "later" }, status: { status: "completed" }, options: {}, updatedAt: plex.snapshot()!.updatedAt });
});

test("a failing Plex migration also rolls back the baseline migration before it", (t) => {
  const file = freshDatabaseFile(t);
  // A stray table under the new name makes migration 2 fail after migration 1 retired the corrections.
  fixture(file, `${CORRECTIONS_LAYOUT} CREATE TABLE shelfcheck_scan_state(mode TEXT, note TEXT);`);
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("plex").options.read(), /shelfcheck_scan_state already exists/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 0);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before, "The corrections table and coverage state are as they were");
  });
});

// Migration 3: Trakt moves to the saved scan state.
const SAVED_SCAN_STATE_V2 = "CREATE TABLE shelfcheck_scan_state(mode TEXT PRIMARY KEY NOT NULL CHECK(mode IN ('trakt','plex')), report TEXT, resume_point TEXT, status TEXT, options TEXT, state_updated_at TEXT);";
/** A version 2 database: Plex already moved, Trakt still in its two old tables. */
function versionTwoWithTrakt(file: string, payload: string) {
  fixture(file, `${TODAY_LAYOUT.replace(/CREATE TABLE shelfcheck_plex_state [^;]*;/, "")} ${SAVED_SCAN_STATE_V2} PRAGMA user_version = 2;`, db => {
    db.prepare("INSERT INTO shelfcheck_scan_state(mode,options,state_updated_at) VALUES('plex',?,'2026-01-01 00:00:00')").run(JSON.stringify({ libraries: ["1"] }));
    db.prepare("INSERT INTO shelfcheck_states(user_id,payload,updated_at) VALUES('single-user',?,'2026-01-02 03:04:05')").run(payload);
    db.prepare("INSERT INTO shelfcheck_scan_status(user_id,payload) VALUES('single-user',?)").run(JSON.stringify({ status: "running", processed: 1, total: 2 }));
  });
}
const traktLegacyOptions = { ignoredShows: [{ title: "One", ids: { trakt: 1 } }], ignoredSeasons: [], diagnosticsEnabled: false, airingGraceDays: 3, futureOption: { kept: true } };

test("upgrading Trakt keeps its options, including unknown fields, and discards its report, Resume point and scan status", (t) => {
  const file = freshDatabaseFile(t);
  versionTwoWithTrakt(file, JSON.stringify({ ...traktLegacyOptions, report: { shows: [{ show: { ids: { trakt: 2 } } }] }, checkpoint: { shows: [] }, scan: { status: "running" } }));

  assert.deepEqual(sqlite.savedScanState("trakt").snapshot(), { report: null, resumePoint: null, status: null, options: traktLegacyOptions, updatedAt: "2026-01-02 03:04:05" });
  assert.deepEqual(sqlite.savedScanState("plex").options.read(), { libraries: ["1"] }, "Plex is not touched again");
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 4);
    assert.equal(tables(db).includes("shelfcheck_states"), false, "The old Trakt state table is dropped");
    assert.equal(tables(db).includes("shelfcheck_scan_status"), false, "The old Trakt status table is dropped");
  });
});

test("upgrading a Trakt record that is not a JSON object starts its options empty, as reading it always did", (t) => {
  for (const invalid of ["not json", "[1,2]", "7"]) {
    const file = freshDatabaseFile(t);
    versionTwoWithTrakt(file, invalid);
    assert.deepEqual(sqlite.savedScanState("trakt").snapshot(), { report: null, resumePoint: null, status: null, options: {}, updatedAt: "2026-01-02 03:04:05" }, invalid);
    closeCached();
  }
});

test("after the upgrade, new Trakt state survives a close and reopen, so the wipe happens once", (t) => {
  const file = freshDatabaseFile(t);
  versionTwoWithTrakt(file, JSON.stringify(traktLegacyOptions));
  const trakt = sqlite.savedScanState("trakt");
  trakt.report.write({ shows: [{ show: { ids: { trakt: 2 } } }] });
  trakt.resumePoint.write({ savedAt: "later" });
  trakt.status.write({ status: "completed" });
  closeCached();
  assert.deepEqual(trakt.snapshot(), { report: { shows: [{ show: { ids: { trakt: 2 } } }] }, resumePoint: { savedAt: "later" }, status: { status: "completed" }, options: traktLegacyOptions, updatedAt: trakt.snapshot()!.updatedAt });
});

test("a failing Trakt migration also rolls back the Plex migration before it", (t) => {
  const file = freshDatabaseFile(t);
  versionOneWithPlex(file, JSON.stringify({ libraries: ["1"] }));
  // A dropped table is emptied without firing triggers, so a row that still refers to the old
  // Trakt record makes dropping it fail after Plex has moved and Trakt's options were copied.
  inspect(file, db => db.exec(`CREATE TABLE fixture_trakt_reference(user_id TEXT REFERENCES shelfcheck_states(user_id));
    INSERT INTO fixture_trakt_reference VALUES('single-user');`));
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("trakt").options.read(), /FOREIGN KEY constraint failed/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 1);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before, "The Plex table, its data and the saved scan state table are as they were");
  });
});

// The final upgrade matrix: every supported version to the latest in one open.
/** Every table this upgrade does not own, with representative rows, including every generated input and a Report Missing flag. */
function seedUnrelated(db: DatabaseSync) {
  db.exec(`INSERT INTO shelfcheck_coverage_mappings VALUES('m','{"id":"m"}');
    INSERT INTO shelfcheck_coverage_members VALUES('TMDB',1,'m',1),('TVDB',2,'m',0);
    INSERT INTO shelfcheck_coverage_evidence VALUES(1,'{"e":1}');
    INSERT INTO shelfcheck_coverage_issues VALUES('i','{"id":"i"}');
    INSERT INTO shelfcheck_coverage_previews VALUES('p','[]',9999999999999);
    INSERT INTO shelfcheck_catalogue_candidates VALUES('show','tmdb',1,'One');
    INSERT INTO shelfcheck_catalogue_overrides VALUES('show','tmdb',1,'2026-01-01');
    INSERT INTO shelfcheck_catalogue_selections(identity,provider,preferred_id,using_id,state,selected_at) VALUES('show','tmdb',1,1,'using','2026-01-01');`);
  for (const key of GENERATED_KEYS) db.prepare("INSERT INTO shelfcheck_plex_generated_inputs VALUES(?,?)").run(key, JSON.stringify({ key }));
}
const VERSION_TWO_LAYOUT = `${TODAY_LAYOUT.replace(/CREATE TABLE shelfcheck_plex_state [^;]*;/, "")} ${SAVED_SCAN_STATE_V2}`;
const OLD_SCAN_STATE_TABLES = ["shelfcheck_plex_state", "shelfcheck_scan_state", "shelfcheck_scan_status", "shelfcheck_states"];
const plexLegacySettings = { libraries: ["1"], futureSetting: 3 };
const runningStatus = JSON.stringify({ status: "running", processed: 1, total: 2, startedAt: "2026-01-01T00:00:00.000Z", heartbeatAt: "2026-01-01T00:00:01.000Z" });

/** Trakt's two old tables, as every release before migration 3 saved them: a running scan with a report and Resume point. */
function seedLegacyTrakt(db: DatabaseSync) {
  db.prepare("INSERT INTO shelfcheck_states(user_id,payload,updated_at) VALUES('single-user',?,'2026-01-02 03:04:05')")
    .run(JSON.stringify({ ...traktLegacyOptions, report: { shows: [{ show: { ids: { trakt: 2 } } }], missing: [], lastScan: "x" }, checkpoint: { shows: [], savedAt: "x" }, scan: { status: "running" } }));
  db.prepare("INSERT INTO shelfcheck_scan_status(user_id,payload) VALUES('single-user',?)").run(runningStatus);
}
function seedLegacyPlex(db: DatabaseSync) {
  db.prepare("INSERT INTO shelfcheck_plex_state(user_id,report,checkpoint,scan_status,settings,updated_at) VALUES('single-user',?,?,?,?,'2026-01-01 00:00:00')")
    .run(JSON.stringify({ shows: [{ ratingKey: "one" }] }), JSON.stringify({ shows: [], savedAt: "x" }), runningStatus, JSON.stringify(plexLegacySettings));
}

const UPGRADES = [
  { from: "an unversioned database", sql: TODAY_LAYOUT, seed: (db: DatabaseSync) => { seedLegacyTrakt(db); seedLegacyPlex(db); } },
  { from: "a version 1 database", sql: `${TODAY_LAYOUT} PRAGMA user_version = 1;`, seed: (db: DatabaseSync) => { seedLegacyTrakt(db); seedLegacyPlex(db); } },
  // At version 2 Plex was already wiped by migration 2: the Plex report saved since then is kept.
  { from: "a version 2 database", sql: `${VERSION_TWO_LAYOUT} PRAGMA user_version = 2;`, plexReport: { shows: [{ ratingKey: "since" }] }, seed: (db: DatabaseSync) => {
    seedLegacyTrakt(db);
    db.prepare("INSERT INTO shelfcheck_scan_state(mode,report,options,state_updated_at) VALUES('plex',?,?,'2026-01-01 00:00:00')").run(JSON.stringify({ shows: [{ ratingKey: "since" }] }), JSON.stringify(plexLegacySettings));
  } },
] as const;

for (const upgrade of UPGRADES) {
  test(`${upgrade.from} upgrades straight to the latest: each mode's results wiped once, idle, options and every other table kept, no provider request`, async (t) => {
    const file = freshDatabaseFile(t);
    fixture(file, upgrade.sql, db => { upgrade.seed(db); seedUnrelated(db); });
    // A database already migrated once has its original backup beside it; it must stay the only one.
    if (upgrade.from !== "an unversioned database") inspect(file, db => db.prepare("VACUUM INTO ?").run(backupOf(file)));
    const before = inspect(file, everyRow);
    const original = upgrade.from === "an unversioned database" ? null : readFileSync(backupOf(file));
    const requests = t.mock.method(globalThis, "fetch", async () => { throw new Error("The upgrade made a provider request"); });

    assert.deepEqual(traktScan.getScanStatus(), { status: "idle", processed: 0, total: 0 }, "Trakt shows idle, not the old running scan");
    assert.deepEqual(plexScan.getPlexScanStatus(), { status: "idle", processed: 0, total: 0 }, "Plex shows idle, not the old running scan");
    for (const mode of ["trakt", "plex"] as const) {
      const saved = sqlite.savedScanState(mode).snapshot()!;
      const report = mode === "plex" && "plexReport" in upgrade ? upgrade.plexReport : null;
      assert.deepEqual([saved.report, saved.resumePoint, saved.status], [report, null, null], `${mode} has no Resume point or status, and only a report saved after its own wipe`);
    }
    assert.deepEqual(sqlite.savedScanState("trakt").options.read(), traktLegacyOptions, "Trakt options, unknown fields included, are kept");
    assert.deepEqual(sqlite.savedScanState("plex").options.read(), plexLegacySettings, "Plex options, unknown fields included, are kept");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.mock.callCount(), 0, "No scan starts by itself");
    assert.equal(scanRun.scanRuns.isActive(), false);
    closeCached();

    inspect(file, db => {
      assert.equal(version(db), 4);
      assert.deepEqual(tables(db), EVERY_TABLE, "The old scan state tables are dropped");
      const after = everyRow(db);
      for (const name of OLD_SCAN_STATE_TABLES) { delete before[name]; delete after[name]; }
      assert.deepEqual(after, before, "Every other table and row is kept");
    });
    const backups = readdirSync(path.dirname(file)).filter(name => !name.startsWith("shelfcheck.db"));
    assert.deepEqual(backups, [BACKUP_FILE_NAME], "Only the original backup exists");
    if (original) assert.deepEqual(readFileSync(backupOf(file)), original, "The original backup is unchanged");
    else inspectBackup(file, db => assert.equal(version(db), 0, "The backup is the unversioned original"));

    // The wipe happens once: state saved after the upgrade survives a reopen.
    sqlite.savedScanState("trakt").report.write({ shows: [], missing: [], lastScan: "after" });
    sqlite.savedScanState("plex").resumePoint.write({ savedAt: "after" });
    closeCached();
    assert.deepEqual(sqlite.savedScanState("trakt").report.read(), { shows: [], missing: [], lastScan: "after" });
    assert.deepEqual(sqlite.savedScanState("plex").resumePoint.read(), { savedAt: "after" });
  });
}

// Migration 4: the Trakt report and Resume point saved before air dates were kept are cleared once.
const traktOptionsV3 = { ...traktLegacyOptions, ignoredSeasons: [{ title: "Two", ids: { trakt: 2 }, season: 1 }] };
const traktStatusV3 = { status: "completed", processed: 2, total: 2, finishedAt: "2026-01-02T00:00:00.000Z" };
const oldScanCache = { 2: { collectionFingerprint: "f", airedEpisodes: 3, traktUpdatedAt: "2026-01-01T00:00:00.000Z", lastCheckedAt: "2026-01-02T00:00:00.000Z" } };
const OLD_TRAKT_REPORTS = {
  "an old report with missing episodes": { shows: [{ show: { title: "Two", ids: { trakt: 2 } } }], missing: [{ show: { title: "Two", ids: { trakt: 2 } }, season: 1, episode: 2 }], lastScan: "2026-01-02T00:00:00.000Z", scanCache: oldScanCache, airingGraceDays: 3 },
  "an old report with an empty missing list and a populated scan cache": { shows: [{ show: { title: "Two", ids: { trakt: 2 } } }], missing: [], lastScan: "2026-01-02T00:00:00.000Z", scanCache: oldScanCache, airingGraceDays: 3 },
};
const oldResumePoint = { ...OLD_TRAKT_REPORTS["an old report with missing episodes"], savedAt: "2026-01-02T00:00:00.000Z", resumePointVersion: 1 };
const plexRowV3 = { report: { shows: [{ ratingKey: "kept" }] }, resumePoint: { savedAt: "x" }, status: { status: "completed" }, options: plexLegacySettings };

/**
 * A version 3 database, as the release before migration 4 left it, with its one backup beside it.
 * Today's open builds the layout; no later migration changed it, so stepping user_version back is that release's database.
 */
function versionThree(file: string, trakt: { report: unknown } | null, seed?: (db: DatabaseSync) => void) {
  sqlite.savedScanState("plex").snapshot();
  closeCached();
  inspect(file, db => {
    db.exec("PRAGMA user_version = 3");
    db.prepare("INSERT INTO shelfcheck_scan_state(mode,report,resume_point,status,options,state_updated_at) VALUES('plex',?,?,?,?,'2026-01-01 00:00:00')")
      .run(...[plexRowV3.report, plexRowV3.resumePoint, plexRowV3.status, plexRowV3.options].map(value => JSON.stringify(value)));
    if (trakt) db.prepare("INSERT INTO shelfcheck_scan_state(mode,report,resume_point,status,options,state_updated_at) VALUES('trakt',?,?,?,?,'2026-01-02 03:04:05')")
      .run(...[trakt.report, oldResumePoint, traktStatusV3, traktOptionsV3].map(value => JSON.stringify(value)));
    seedUnrelated(db);
    seed?.(db);
    db.prepare("VACUUM INTO ?").run(backupOf(file));
  });
}

for (const [name, report] of Object.entries(OLD_TRAKT_REPORTS)) {
  test(`upgrading a version 3 database clears ${name} and the Trakt Resume point, and keeps everything else`, async (t) => {
    const file = freshDatabaseFile(t);
    versionThree(file, { report });
    const before = inspect(file, everyRow);
    const original = readFileSync(backupOf(file));
    const requests = t.mock.method(globalThis, "fetch", async () => { throw new Error("The upgrade made a provider request"); });

    const trakt = sqlite.savedScanState("trakt").snapshot()!;
    assert.deepEqual([trakt.report, trakt.resumePoint], [null, null], "The Trakt report and Resume point are cleared");
    assert.deepEqual(trakt.status, traktStatusV3, "Trakt scan status is kept");
    assert.deepEqual(trakt.options, traktOptionsV3, "Trakt options, Ignores and unknown fields included, are kept");
    assert.deepEqual(sqlite.savedScanState("plex").snapshot(), { ...plexRowV3, updatedAt: "2026-01-01 00:00:00" }, "The whole Plex row is kept");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.mock.callCount(), 0, "No scan starts by itself");
    assert.equal(scanRun.scanRuns.isActive(), false);
    closeCached();

    inspect(file, db => {
      assert.equal(version(db), 4);
      const after = everyRow(db);
      delete before.shelfcheck_scan_state;
      delete after.shelfcheck_scan_state;
      assert.deepEqual(after, before, "Every other table and row is kept");
    });
    const backups = readdirSync(path.dirname(file)).filter(name => !name.startsWith("shelfcheck.db"));
    assert.deepEqual(backups, [BACKUP_FILE_NAME], "No second backup is written");
    assert.deepEqual(readFileSync(backupOf(file)), original, "The existing backup is unchanged");
  });
}

test("upgrading a version 3 database with no Trakt row leaves it without one", (t) => {
  const file = freshDatabaseFile(t);
  versionThree(file, null);
  assert.equal(sqlite.savedScanState("trakt").snapshot(), null);
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 4);
    assert.deepEqual(db.prepare("SELECT mode FROM shelfcheck_scan_state ORDER BY mode").all().map(row => row.mode), ["plex"]);
  });
});

test("after migration 4, a new Trakt report and Resume point survive a reopen, so the clear happens once", (t) => {
  const file = freshDatabaseFile(t);
  versionThree(file, { report: OLD_TRAKT_REPORTS["an old report with missing episodes"] });
  const trakt = sqlite.savedScanState("trakt");
  assert.equal(trakt.report.read(), null);
  const report = { shows: [], missing: [{ show: { title: "Two", ids: { trakt: 2 } }, season: 1, episode: 3, firstAired: "2026-01-09T00:00:00.000Z" }], lastScan: "after", scanCache: {}, airingGraceDays: 0 };
  trakt.report.write(report);
  trakt.resumePoint.write({ ...report, savedAt: "after", resumePointVersion: 2 });
  closeCached();
  assert.deepEqual(trakt.report.read(), report);
  assert.deepEqual(trakt.resumePoint.read(), { ...report, savedAt: "after", resumePointVersion: 2 });
  closeCached();
  inspect(file, db => assert.equal(version(db), 4, "The version advanced once"));
});

test("a failure after migration 4 clears the Trakt results rolls back the clear and the version together", (t) => {
  const file = freshDatabaseFile(t);
  // RAISE(FAIL) keeps the clearing write in the transaction, so only the migration's rollback can undo it.
  versionThree(file, { report: OLD_TRAKT_REPORTS["an old report with missing episodes"] }, db => db.exec(`CREATE TRIGGER forced_failure AFTER UPDATE OF report ON shelfcheck_scan_state
    BEGIN SELECT RAISE(FAIL, 'forced migration failure'); END;`));
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.savedScanState("trakt").snapshot(), /forced migration failure/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 3);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before, "The Trakt report and Resume point are as they were");
    db.exec("DROP TRIGGER forced_failure");
  });

  assert.equal(sqlite.savedScanState("trakt").report.read(), null, "A retry clears them");
});
