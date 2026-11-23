import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const sqlite = await import("../lib/sqlite");
const { savedScanState, trackScanIgnores } = await import("../lib/ignore-results");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanIgnoreGuards?: object };
const closeCached = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };

/** A fresh database in a disposable data directory; no cached handle or scan guard survives into or out of it. */
function freshDatabase(t: TestContext) {
  closeCached();
  delete cache.__shelfcheckScanIgnoreGuards;
  const dir = mkdtempSync(path.join(tmpdir(), "shelfcheck-ignore-results-"));
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

type Results = { shows: unknown[]; missing: unknown[]; scanCache: Record<string, unknown>; savedAt: string };
const traktRow = (id: number) => ({ show: { title: `Show ${id}`, ids: { trakt: id } } });
const plexRow = (key: string) => ({ ratingKey: key, title: key });
/** Each mode's results for two shows, one Ignore for the first, and the shows' keys read back from a saved part. */
const MODES = {
  trakt: {
    results: (savedAt = "report"): Results => ({ shows: [traktRow(1), traktRow(2)], missing: [1, 2].map(id => ({ ...traktRow(id), season: 1, episode: 1 })), scanCache: { "1": 1, "2": 2 }, savedAt }),
    ignore: (extra: object = {}) => ({ ...traktRow(1).show, ...extra }),
    keys: (rows: unknown[]) => (rows as ReturnType<typeof traktRow>[]).map(row => String(row.show.ids.trakt)),
    first: "1", second: "2",
  },
  plex: {
    results: (savedAt = "report"): Results => ({ shows: [plexRow("one"), plexRow("two")], missing: [{ ...plexRow("one"), season: 1 }, { ...plexRow("two"), season: 1 }], scanCache: { one: 1, two: 2 }, savedAt }),
    ignore: (extra: object = {}) => ({ ...plexRow("one"), ...extra }),
    keys: (rows: unknown[]) => (rows as { ratingKey: string }[]).map(row => row.ratingKey),
    first: "one", second: "two",
  },
} as const;
type Mode = keyof typeof MODES;
const modes = Object.keys(MODES) as Mode[];

/** The show keys kept in each pruned part of a saved report or Resume point. */
function kept(mode: Mode, saved: unknown) {
  const results = saved as Results;
  const { keys } = MODES[mode];
  return { shows: keys(results.shows), missing: keys(results.missing), scanCache: Object.keys(results.scanCache) };
}
const all = (mode: Mode) => ({ shows: [MODES[mode].first, MODES[mode].second], missing: [MODES[mode].first, MODES[mode].second], scanCache: [MODES[mode].first, MODES[mode].second] });
const secondOnly = (mode: Mode) => ({ shows: [MODES[mode].second], missing: [MODES[mode].second], scanCache: [MODES[mode].second] });

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

test("each result write removes an actively ignored show from shows, missing and scan cache together, in both modes", (t) => {
  freshDatabase(t);
  for (const mode of modes) {
    const store = savedScanState(mode);
    const writes = {
      report: () => { store.report.write(MODES[mode].results()); return store.report.read(); },
      "Resume point": () => { store.resumePoint.write(MODES[mode].results()); return store.resumePoint.read(); },
      "commit report": () => { store.commitReport(MODES[mode].results()); return store.report.read(); },
    };
    for (const [rule, expected] of [
      [MODES[mode].ignore(), secondOnly(mode)],
      [MODES[mode].ignore({ duration: "30d", expiresAt: FUTURE }), secondOnly(mode)],
      [MODES[mode].ignore({ duration: "30d", expiresAt: PAST }), all(mode)],
    ] as const) {
      store.options.patch({ ignoredShows: [rule] });
      for (const [write, saved] of Object.entries(writes)) assert.deepEqual(kept(mode, saved()), expected, `${mode} ${write}, Ignore ${JSON.stringify(rule)}`);
    }
  }
});

test("a scan keeps out the Ignores active at its start time; one whose expiry equals that time has ended", (t) => {
  freshDatabase(t);
  const started = Date.parse("2030-01-01T00:00:00.000Z");
  for (const mode of modes) {
    const store = savedScanState(mode);
    for (const [expiresAt, expected] of [["2030-01-01T00:00:01.000Z", secondOnly(mode)], ["2030-01-01T00:00:00.000Z", all(mode)]] as const) {
      store.options.patch({ ignoredShows: [MODES[mode].ignore({ duration: "30d", expiresAt })] });
      const finish = trackScanIgnores(mode, started);
      try {
        // Both rules are active now; only the scan's start time decides.
        store.options.patch({ ignoredShows: [] });
        store.report.write(MODES[mode].results());
        assert.deepEqual(kept(mode, store.report.read()), expected, `${mode}: expiry ${expiresAt}`);
      } finally { finish(); }
    }
  }
});

test("an Ignore during one mode's scan leaves the other mode's results alone", (t) => {
  freshDatabase(t);
  const plex = savedScanState("plex");
  const trakt = savedScanState("trakt");
  const finishPlex = trackScanIgnores("plex");
  const finishTrakt = trackScanIgnores("trakt");
  try {
    // The same key string in both modes: Plex rating key "1" and Trakt show 1.
    plex.options.patch({ ignoredShows: [plexRow("1")] });
    plex.options.patch({ ignoredShows: [] });
    trakt.report.write(MODES.trakt.results());
    assert.deepEqual(kept("trakt", trakt.report.read()), all("trakt"));
  } finally { finishPlex(); finishTrakt(); }
});

test("a stale scan's cleanup leaves a newer scan's guard in place", (t) => {
  freshDatabase(t);
  for (const mode of modes) {
    const store = savedScanState(mode);
    store.options.patch({ ignoredShows: [MODES[mode].ignore()] });
    const finishStale = trackScanIgnores(mode);
    const finishNewer = trackScanIgnores(mode);
    store.options.patch({ ignoredShows: [] });
    finishStale();
    store.report.write(MODES[mode].results());
    assert.deepEqual(kept(mode, store.report.read()), secondOnly(mode), `${mode}: the newer guard still holds the Ignore`);
    finishNewer();
    store.report.write(MODES[mode].results());
    assert.deepEqual(kept(mode, store.report.read()), all(mode), `${mode}: its own cleanup removes it`);
  }
});

test("a Settings-only patch during a scan adds nothing to its guard", (t) => {
  freshDatabase(t);
  for (const mode of modes) {
    const store = savedScanState(mode);
    // Active now, but not yet at the scan's start time, so the guard starts without it.
    store.options.patch({ ignoredShows: [] });
    const finish = trackScanIgnores(mode, Date.parse("2100-01-01T00:00:00.000Z"));
    try {
      sqlite.database().prepare("UPDATE shelfcheck_scan_state SET options = ? WHERE mode = ?").run(JSON.stringify({ ignoredShows: [MODES[mode].ignore({ duration: "30d", expiresAt: FUTURE })] }), mode);
      store.options.patch({ diagnosticsEnabled: false });
      store.options.patch({ ignoredShows: [] });
      store.report.write(MODES[mode].results());
      assert.deepEqual(kept(mode, store.report.read()), all(mode), `${mode}: neither patch marked the show`);
    } finally { finish(); }
  }
});

/** Save each mode's results with an active Ignore through SQL, as older versions retained them, then close the handle. */
function seedRetainedResults(ignore: (mode: Mode) => object = mode => MODES[mode].ignore()) {
  const db = sqlite.database();
  for (const mode of modes) {
    db.prepare(`INSERT INTO shelfcheck_scan_state(mode, options, report, resume_point, state_updated_at) VALUES(?, ?, ?, ?, '2020-01-01 00:00:00')
      ON CONFLICT(mode) DO UPDATE SET options = excluded.options, report = excluded.report, resume_point = excluded.resume_point, state_updated_at = excluded.state_updated_at`)
      .run(mode, JSON.stringify({ ignoredShows: [ignore(mode)] }), JSON.stringify(MODES[mode].results()), JSON.stringify(MODES[mode].results("resume")));
  }
  closeCached();
}

test("retained results of active Ignores are removed in both modes before the first operation of any kind, keeping the state timestamp", (t) => {
  freshDatabase(t);
  const firstOperations = {
    "a Trakt snapshot": () => savedScanState("trakt").snapshot(),
    "a Plex Restore": () => savedScanState("plex").options.patch({ ignoredShows: [] }),
    "a Plex status write": () => savedScanState("plex").status.write({ status: "running" }),
    "a Trakt scan start": () => trackScanIgnores("trakt")(),
  };
  for (const [name, first] of Object.entries(firstOperations)) {
    seedRetainedResults();
    first();
    for (const mode of modes) {
      const saved = savedScanState(mode).snapshot()!;
      assert.deepEqual([kept(mode, saved.report), kept(mode, saved.resumePoint)], [secondOnly(mode), secondOnly(mode)], `${name} first: ${mode}`);
      // A Restore is itself a real options write; removal alone moves nothing.
      if (!(name === "a Plex Restore" && mode === "plex")) assert.equal(saved.updatedAt, "2020-01-01 00:00:00", `${name} first: ${mode} keeps its timestamp`);
    }
  }
});

test("removal runs once per database handle and again after the handle is reopened", (t) => {
  freshDatabase(t);
  const trakt = savedScanState("trakt");
  trakt.options.read();
  // Results retained after the handle's first use stay until the next handle.
  sqlite.database().prepare("INSERT INTO shelfcheck_scan_state(mode, options, report) VALUES('trakt', ?, ?)").run(JSON.stringify({ ignoredShows: [MODES.trakt.ignore()] }), JSON.stringify(MODES.trakt.results()));
  assert.deepEqual(kept("trakt", trakt.report.read()), all("trakt"));
  closeCached();
  assert.deepEqual(kept("trakt", trakt.report.read()), secondOnly("trakt"));
});

test("a failed removal surfaces and is retried by the next operation", (t) => {
  freshDatabase(t);
  seedRetainedResults();
  sqlite.database().exec("CREATE TRIGGER reject_saved_state BEFORE UPDATE ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'saved state unavailable'); END;");
  closeCached();
  assert.throws(() => savedScanState("plex").report.read(), /saved state unavailable/);
  sqlite.database().exec("DROP TRIGGER reject_saved_state");
  assert.deepEqual(kept("plex", savedScanState("plex").report.read()), secondOnly("plex"));
  assert.deepEqual(kept("trakt", savedScanState("trakt").report.read()), secondOnly("trakt"));
});

test("a removal inside a transaction that rolls back runs again on a later operation", (t) => {
  freshDatabase(t);
  seedRetainedResults();
  const db = sqlite.database();
  db.exec("BEGIN IMMEDIATE");
  assert.deepEqual(kept("trakt", savedScanState("trakt").report.read()), secondOnly("trakt"), "Removed inside the transaction");
  db.exec("ROLLBACK");
  for (const mode of modes) assert.deepEqual(kept(mode, savedScanState(mode).report.read()), secondOnly(mode), `${mode}: removed again after the rollback`);
});

test("an unreadable saved part is left as it is while the other part is pruned", (t) => {
  freshDatabase(t);
  seedRetainedResults();
  sqlite.database().prepare("UPDATE shelfcheck_scan_state SET report = 'not json' WHERE mode = 'plex'").run();
  closeCached();
  assert.deepEqual(kept("plex", savedScanState("plex").resumePoint.read()), secondOnly("plex"));
  assert.equal((sqlite.database().prepare("SELECT report FROM shelfcheck_scan_state WHERE mode = 'plex'").get() as { report: string }).report, "not json");
});

test("a temporary Ignore that expires after the database opened but before the first saved scan state use keeps its retained results", (t) => {
  freshDatabase(t);
  const expiresAt = "2030-01-01T00:00:00.000Z";
  seedRetainedResults(mode => MODES[mode].ignore({ duration: "30d", expiresAt }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(expiresAt) - 1000 });
  // Another store opens the handle while the Ignore is still active.
  sqlite.database();
  t.mock.timers.setTime(Date.parse(expiresAt));
  for (const mode of modes) assert.deepEqual(kept(mode, savedScanState(mode).report.read()), all(mode), `${mode}: evaluated at the first use, when the Ignore has ended`);
});
