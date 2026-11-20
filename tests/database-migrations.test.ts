import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const sqlite = await import("../lib/sqlite");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanIgnoreGuards?: object };
const closeCached = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };

const EVERY_TABLE = [
  "shelfcheck_catalogue_candidates", "shelfcheck_catalogue_overrides", "shelfcheck_catalogue_selections",
  "shelfcheck_coverage_evidence", "shelfcheck_coverage_issues", "shelfcheck_coverage_mappings", "shelfcheck_coverage_members",
  "shelfcheck_coverage_previews", "shelfcheck_coverage_state", "shelfcheck_plex_generated_inputs", "shelfcheck_plex_state",
  "shelfcheck_scan_status", "shelfcheck_states",
];

/** A disposable data directory, opened fresh: no cached handle survives into or out of it. */
function dataDirectory(t: TestContext) {
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

/** Read the database file through its own connection, never the cached handle. */
function inspect<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try { return read(db); } finally { db.close(); }
}
const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'shelfcheck_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);

test("opening an empty data directory creates every table at the current version", (t) => {
  const file = dataDirectory(t);
  assert.equal(sqlite.readSingleUserState().state, null);
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 1);
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

test("opening today's unversioned layout keeps every table and row and stamps the current version", (t) => {
  const file = dataDirectory(t);
  fixture(file, TODAY_LAYOUT, db => {
    db.prepare("INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user',?)").run(JSON.stringify({ ignoredShows: [], diagnostics: true, report: { shows: [] } }));
    db.prepare("INSERT INTO shelfcheck_scan_status(user_id,payload) VALUES('single-user',?)").run(JSON.stringify({ status: "completed" }));
    db.prepare("INSERT INTO shelfcheck_plex_state(user_id,report,checkpoint,scan_status,settings) VALUES('single-user',?,?,?,?)").run("{\"shows\":[]}", "{\"done\":1}", "{\"status\":\"completed\"}", "{\"libraries\":[\"1\"]}");
    db.exec(`INSERT INTO shelfcheck_coverage_mappings VALUES('m','{"id":"m"}');
      INSERT INTO shelfcheck_coverage_members VALUES('TMDB',1,'m',1),('TVDB',2,'m',0);
      INSERT INTO shelfcheck_coverage_evidence VALUES(1,'{"e":1}');
      INSERT INTO shelfcheck_coverage_issues VALUES('i','{"id":"i"}');
      INSERT INTO shelfcheck_coverage_previews VALUES('p','[]',9999999999999);
      INSERT INTO shelfcheck_catalogue_candidates VALUES('show','tmdb',1,'One');
      INSERT INTO shelfcheck_catalogue_overrides VALUES('show','tmdb',1,'2026-01-01');
      INSERT INTO shelfcheck_catalogue_selections(identity,provider,preferred_id,using_id,state,selected_at) VALUES('show','tmdb',1,1,'using','2026-01-01');`);
    for (const key of GENERATED_KEYS) db.prepare("INSERT INTO shelfcheck_plex_generated_inputs VALUES(?,?)").run(key, JSON.stringify({ key }));
  });
  const before = inspect(file, everyRow);

  assert.deepEqual(sqlite.readPlexSettings(), { libraries: ["1"] });
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 1);
    assert.deepEqual(everyRow(db), before, "Every table and row is kept, including every generated input and Report Missing flag");
  });
});

test("opening an older sparse layout adds missing tables and columns without erasing data", (t) => {
  const file = dataDirectory(t);
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

  assert.deepEqual(sqlite.readPlexReport(), { shows: [] });
  assert.deepEqual(sqlite.readPlexSettings(), {}, "The Plex table gains Settings with its default");
  assert.equal(sqlite.readPlexCheckpoint(), null, "The Plex table gains a Resume point column");
  assert.deepEqual(sqlite.readSingleUserState().state, { diagnostics: true });
  assert.equal(sqlite.readSingleUserScanStatus(), null, "A missing Trakt status table is created empty");
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 1);
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
  const file = dataDirectory(t);
  fixture(file, CORRECTIONS_LAYOUT);

  sqlite.readPlexSettings();
  closeCached();
  inspect(file, db => {
    assert.deepEqual(coverageState(db), { revision: 5, pending: 1 });
    assert.equal(tables(db).includes("shelfcheck_coverage_corrections"), false);
    db.exec("UPDATE shelfcheck_coverage_state SET pending=0");
  });

  sqlite.readPlexSettings();
  closeCached();
  inspect(file, db => assert.deepEqual(coverageState(db), { revision: 5, pending: 0 }, "A later open does not retire again"));
});

test("a database from a newer Shelfcheck is refused and left untouched", (t) => {
  const file = dataDirectory(t);
  fixture(file, "CREATE TABLE shelfcheck_states (user_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL); PRAGMA user_version = 2;");
  const before = inspect(file, db => ({ schema: schema(db), journal: db.prepare("PRAGMA journal_mode").get() }));

  assert.throws(() => sqlite.readSingleUserState(), /schema version 2, newer than this Shelfcheck supports \(1\)/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 2);
    assert.deepEqual({ schema: schema(db), journal: db.prepare("PRAGMA journal_mode").get() }, before);
  });
});

test("an incompatible unversioned schema is refused clearly and left unchanged", (t) => {
  const file = dataDirectory(t);
  fixture(file, "CREATE TABLE shelfcheck_states (user_id TEXT PRIMARY KEY NOT NULL, data TEXT); INSERT INTO shelfcheck_states VALUES('single-user','x');");
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.readSingleUserState(), /cannot upgrade this database: table shelfcheck_states has no payload, updated_at columns/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 0);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before);
  });
});

test("a migration failing after a real schema change rolls back everything, and a retry succeeds once", (t) => {
  const file = dataDirectory(t);
  // The trigger fires on the coverage state update that follows dropping the corrections table.
  fixture(file, `${CORRECTIONS_LAYOUT}
    CREATE TRIGGER forced_failure BEFORE UPDATE ON shelfcheck_coverage_state BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;`);
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.readPlexSettings(), /forced migration failure/);
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 0);
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before, "Logical schema and rows are unchanged");
    db.exec("DROP TRIGGER forced_failure");
  });

  sqlite.readPlexSettings();
  closeCached();
  sqlite.readPlexSettings();
  closeCached();
  inspect(file, db => {
    assert.equal(version(db), 1);
    assert.deepEqual(coverageState(db), { revision: 5, pending: 1 }, "The retry retires corrections exactly once");
  });
});

test("a second open runs no migration but still removes ignored results at open", (t) => {
  const file = dataDirectory(t);
  sqlite.readSingleUserState();
  closeCached();
  const show = (id: number) => ({ show: { title: `Show ${id}`, ids: { trakt: id } } });
  inspect(file, db => {
    // A corrections table appearing after migration would be retired only if migration 1 ran again.
    db.exec("CREATE TABLE shelfcheck_coverage_corrections(mapping_id TEXT); INSERT INTO shelfcheck_coverage_corrections VALUES('m');");
    db.prepare("INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user',?)")
      .run(JSON.stringify({ ignoredShows: [show(1).show], report: { shows: [show(1), show(2)] } }));
  });

  const state = sqlite.readSingleUserState().state as { report: { shows: ReturnType<typeof show>[] } };
  assert.deepEqual(state.report.shows.map(row => row.show.ids.trakt), [2], "Ignored results are removed at open");
  closeCached();
  inspect(file, db => {
    assert.equal(tables(db).includes("shelfcheck_coverage_corrections"), true, "Migration 1 did not run again");
    assert.deepEqual(coverageState(db), { revision: 0, pending: 0 });
  });
});

// Written next to the database before the first migration; see lib/sqlite-migrations.ts.
const backupOf = (file: string) => path.join(path.dirname(file), "shelfcheck-pre-migration-backup.db");
/** Open the backup on its own, read-only, so a missing file fails instead of being created. */
function inspectBackup<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(backupOf(file), { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
const legacyOptions = { ignoredShows: [], diagnostics: true, futureOption: { kept: true } };

test("upgrading an unversioned database first writes a complete backup, including committed WAL data", (t) => {
  const file = dataDirectory(t);
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

    sqlite.readPlexSettings();
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
  const file = dataDirectory(t);
  fixture(file, `${TODAY_LAYOUT} INSERT INTO shelfcheck_states(user_id,payload) VALUES('single-user','{"diagnostics":true}');`);
  // A directory where the backup belongs obstructs it the same way on every platform.
  mkdirSync(backupOf(file));
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.readSingleUserState());
  assert.equal(cache.__shelfcheckDatabase, undefined, "No handle is cached");
  inspect(file, db => {
    assert.equal(version(db), 0, "No migration ran");
    assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before);
  });
});

test("a retry after a failed migration keeps the original backup, and a partial file never counts as one", (t) => {
  const file = dataDirectory(t);
  fixture(file, `${CORRECTIONS_LAYOUT}
    CREATE TRIGGER forced_failure BEFORE UPDATE ON shelfcheck_coverage_state BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;`);
  // An interrupted earlier attempt left an incomplete file under the temporary name.
  writeFileSync(`${backupOf(file)}.partial`, "incomplete");
  const before = inspect(file, db => ({ schema: schema(db), rows: everyRow(db) }));

  assert.throws(() => sqlite.readPlexSettings(), /forced migration failure/);
  inspectBackup(file, db => assert.deepEqual({ schema: schema(db), rows: everyRow(db) }, before, "The backup is the complete original, not the partial file"));
  const original = readFileSync(backupOf(file));
  inspect(file, db => db.exec("DROP TRIGGER forced_failure"));

  sqlite.readPlexSettings();
  closeCached();
  assert.deepEqual(readFileSync(backupOf(file)), original, "The retry keeps the original backup");
  assert.deepEqual(readdirSync(path.dirname(file)).filter(name => !name.startsWith("shelfcheck.db")), [path.basename(backupOf(file))], "No second backup and no partial file");
});

test("no backup is written for a new database, on a later open, or beside a refused newer database", (t) => {
  const file = dataDirectory(t);
  const directoryEntries = () => readdirSync(path.dirname(file)).filter(name => !name.startsWith("shelfcheck.db"));
  sqlite.readSingleUserState();
  closeCached();
  assert.deepEqual(directoryEntries(), [], "A database that did not exist before is not backed up");

  sqlite.patchSingleUserState({ diagnostics: true });
  closeCached();
  sqlite.readSingleUserState();
  closeCached();
  assert.deepEqual(directoryEntries(), [], "A later open with no pending migration writes no backup");

  inspect(file, db => db.exec("PRAGMA user_version = 2"));
  assert.throws(() => sqlite.readSingleUserState(), /newer than this Shelfcheck supports/);
  assert.deepEqual(directoryEntries(), [], "A refused newer database gets no backup");
});
