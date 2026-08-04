import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SINGLE_USER_ID = "single-user";

type DatabaseCache = typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

function dataDirectory() {
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
  db.exec("PRAGMA optimize");
  cache.__shelfcheckDatabase = db;
  return db;
}

export function readSingleUserState() {
  const row = database().prepare(
    "SELECT payload, updated_at FROM shelfcheck_states WHERE user_id = ?",
  ).get(SINGLE_USER_ID) as { payload: string; updated_at: string } | undefined;
  return row
    ? { state: JSON.parse(row.payload) as Record<string, unknown>, updatedAt: row.updated_at }
    : { state: null, updatedAt: null };
}

export function writeSingleUserState(state: Record<string, unknown>) {
  database().prepare(`INSERT INTO shelfcheck_states (user_id, payload, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP`)
    .run(SINGLE_USER_ID, JSON.stringify(state));
}

export function patchSingleUserState(patch: Record<string, unknown>) {
  const current = readSingleUserState();
  writeSingleUserState({ ...(current.state || {}), ...patch });
}
