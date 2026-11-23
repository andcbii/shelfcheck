import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

// The raw saved scan state store is tested here only for its maintenance update, which
// keeps the state timestamp; everything else goes through the public store. This file is
// the one test the lint boundary lets use the raw store.
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const sqlite = await import("../lib/sqlite");
const ignoreResults = await import("../lib/ignore-results");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanIgnoreGuards?: object };
const closeCached = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };

/** A fresh database in a disposable data directory; no cached handle or scan guard survives into or out of it. */
function freshDatabase(t: TestContext) {
  closeCached();
  delete cache.__shelfcheckScanIgnoreGuards;
  const dir = mkdtempSync(path.join(tmpdir(), "shelfcheck-raw-saved-state-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    closeCached();
    delete cache.__shelfcheckScanIgnoreGuards;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR;
    else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

type Row = { ratingKey?: string; show?: { ids: { trakt: number } } };
type Results = { shows: Row[]; scanCache: Record<string, unknown> };
const plexResults = (savedAt = "report"): Results & { savedAt: string } => ({ shows: [{ ratingKey: "one" }, { ratingKey: "two" }], scanCache: { one: 1, two: 2 }, savedAt });
const traktResults = (savedAt = "report"): Results & { savedAt: string } => ({ shows: [1, 2].map(id => ({ show: { ids: { trakt: id } } })), scanCache: { "1": 1, "2": 2 }, savedAt });

/** A trigger that rejects every update of the saved scan state, as a failing store would. */
const rejectUpdates = (when = "") => cache.__shelfcheckDatabase!.exec(`CREATE TRIGGER reject_saved_state BEFORE UPDATE ${when} ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'saved state unavailable'); END;`);
const allowUpdates = () => cache.__shelfcheckDatabase!.exec("DROP TRIGGER reject_saved_state");
const backdate = () => cache.__shelfcheckDatabase!.exec("UPDATE shelfcheck_scan_state SET state_updated_at = '2020-01-01 00:00:00'");
const replace = (mode: "plex" | "trakt", parts: { report?: unknown; resumePoint?: unknown }) => sqlite.rawSavedScanState(mode).replaceResults(parts);

test("replacing saved results changes the report and Resume point together, keeping options, status and the state timestamp", (t) => {
  freshDatabase(t);
  const plex = ignoreResults.savedScanState("plex");
  const trakt = ignoreResults.savedScanState("trakt");
  plex.options.patch({ diagnosticsEnabled: false, futureOption: { kept: true } });
  plex.report.write(plexResults());
  plex.resumePoint.write(plexResults("resume"));
  plex.status.write({ status: "running" });
  trakt.report.write(traktResults());
  backdate();

  replace("plex", { report: plexResults("pruned"), resumePoint: plexResults("pruned resume") });
  assert.deepEqual(plex.snapshot(), {
    report: plexResults("pruned"), resumePoint: plexResults("pruned resume"), status: { status: "running" },
    options: { diagnosticsEnabled: false, futureOption: { kept: true } }, updatedAt: "2020-01-01 00:00:00",
  });
  assert.deepEqual(trakt.report.read(), traktResults(), "The other mode is untouched");

  replace("plex", { resumePoint: plexResults("only resume") });
  assert.deepEqual([plex.report.read(), plex.resumePoint.read()], [plexResults("pruned"), plexResults("only resume")], "An omitted part is kept");

  replace("plex", { report: null, resumePoint: null });
  assert.deepEqual([plex.report.read(), plex.resumePoint.read(), plex.snapshot()!.updatedAt], [null, null, "2020-01-01 00:00:00"]);
});

test("replacing saved results creates no row, leaves a status-only row without options, and is rejected as one write", (t) => {
  freshDatabase(t);
  const plex = ignoreResults.savedScanState("plex");
  const trakt = ignoreResults.savedScanState("trakt");
  replace("plex", { report: plexResults(), resumePoint: plexResults("resume") });
  assert.equal(plex.snapshot(), null, "A mode with no row gains none");

  trakt.status.write({ status: "completed" });
  replace("trakt", { report: traktResults(), resumePoint: null });
  assert.deepEqual(trakt.snapshot(), { report: traktResults(), resumePoint: null, status: { status: "completed" }, options: null, updatedAt: null }, "Options stay null and the timestamp unset");

  trakt.resumePoint.write(traktResults("resume"));
  rejectUpdates("OF resume_point");
  assert.throws(() => replace("trakt", { report: traktResults("new"), resumePoint: traktResults("new resume") }), /saved state unavailable/);
  allowUpdates();
  assert.deepEqual([trakt.report.read(), trakt.resumePoint.read()], [traktResults(), traktResults("resume")], "Neither part changes alone");
});

test("replacing saved results joins a transaction already open, so its rollback undoes it", (t) => {
  freshDatabase(t);
  const plex = ignoreResults.savedScanState("plex");
  plex.report.write(plexResults());
  plex.resumePoint.write(plexResults("resume"));
  const db = sqlite.database();
  db.exec("BEGIN IMMEDIATE");
  replace("plex", { report: plexResults("new"), resumePoint: null });
  assert.deepEqual(plex.report.read(), plexResults("new"), "The change is visible inside the transaction");
  db.exec("ROLLBACK");
  assert.deepEqual([plex.report.read(), plex.resumePoint.read()], [plexResults(), plexResults("resume")]);
});
