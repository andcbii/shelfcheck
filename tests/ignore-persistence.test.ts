import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// This module's database boundary is server-only in Next.js. Tests run in Node.
const serverOnlyHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const sqlite = await import("../lib/sqlite");
serverOnlyHook.deregister();

const traktShow = (id: number) => ({ show: { title: `Show ${id}`, ids: { trakt: id } } });
const traktReport = () => ({
  shows: [traktShow(1), traktShow(2)],
  missing: [1, 2].map((id) => ({ ...traktShow(id), season: 1, episode: 1 })),
  scanCache: { "1": { value: 1 }, "2": { value: 2 } },
  lastScan: "2026-11-06T12:00:00.000Z",
});
type TraktReport = ReturnType<typeof traktReport>;
const trakt = () => sqlite.savedScanState("trakt");
const traktIds = (report: unknown) => (report as TraktReport).shows.map((row) => row.show.ids.trakt);
const plexReport = () => ({
  shows: ["one", "two"].map((id) => ({ ratingKey: id, title: id, missing: [{ season: 1, episode: 1 }] })),
  scanCache: { one: { value: 1 }, two: { value: 2 } },
  lastScan: "2026-11-06T12:00:00.000Z",
});

test("ignore persistence removes saved whole-show results and protects pending scan writes", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "shelfcheck-ignore-test-"));
  const previousDirectory = process.env.SHELFCHECK_DATA_DIR;
  const cache = globalThis as typeof globalThis & {
    __shelfcheckDatabase?: DatabaseSync;
    __shelfcheckScanIgnoreGuards?: object;
  };
  process.env.SHELFCHECK_DATA_DIR = directory;
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    delete cache.__shelfcheckScanIgnoreGuards;
    if (previousDirectory === undefined) delete process.env.SHELFCHECK_DATA_DIR;
    else process.env.SHELFCHECK_DATA_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  });

  await t.test("Trakt whole-show ignores prune report, missing rows, checkpoint, and cache together", () => {
    const seasonRule = { traktId: 1, title: "Show 1", seasons: [2] };
    trakt().options.patch({ ignoredShows: [], ignoredSeasons: [seasonRule] });
    trakt().report.write(traktReport());
    trakt().resumePoint.write(traktReport());
    trakt().options.patch({ ignoredShows: [{ ...traktShow(1).show, duration: "30d", expiresAt: "2099-01-01T00:00:00.000Z" }] });
    for (const report of [trakt().report.read(), trakt().resumePoint.read()] as TraktReport[]) {
      assert.deepEqual(report.shows.map((row) => row.show.ids.trakt), [2]);
      assert.deepEqual(report.missing.map((row) => row.show.ids.trakt), [2]);
      assert.deepEqual(Object.keys(report.scanCache), ["2"]);
    }
    assert.deepEqual(trakt().options.read().ignoredSeasons, [seasonRule]);
    trakt().options.patch({ ignoredShows: [] });
    assert.deepEqual(traktIds(trakt().report.read()), [2]);
  });

  await t.test("Plex whole-show ignores prune reports and checkpoints while retaining independent season rules", () => {
    const seasonRule = { ratingKey: "one", title: "one", seasons: [2] };
    sqlite.savedScanState("plex").options.patch({ ignoredShows: [], ignoredSeasons: [seasonRule] });
    sqlite.savedScanState("plex").report.write(plexReport());
    sqlite.savedScanState("plex").resumePoint.write(plexReport());
    sqlite.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "one", title: "one" }], ignoredSeasons: [seasonRule] });
    for (const report of [sqlite.savedScanState("plex").report.read(), sqlite.savedScanState("plex").resumePoint.read()] as ReturnType<typeof plexReport>[]) {
      assert.deepEqual(report.shows.map((row) => row.ratingKey), ["two"]);
      assert.deepEqual(Object.keys(report.scanCache), ["two"]);
    }
    assert.deepEqual(sqlite.savedScanState("plex").options.read().ignoredSeasons, [seasonRule]);
    sqlite.savedScanState("plex").options.patch({ ignoredShows: [], ignoredSeasons: [seasonRule] });
    assert.deepEqual((sqlite.savedScanState("plex").report.read() as ReturnType<typeof plexReport>).shows.map((row) => row.ratingKey), ["two"]);
  });

  // The upgrade itself discards legacy Trakt results (the legacy upgrade test below and
  // tests/database-migrations.test.ts); results retained in the saved scan state by some
  // other path are still removed when SQLite opens.
  await t.test("reopening a Trakt saved scan state removes retained results of active Ignores before reads or a direct Restore", () => {
    const seasonRule = { traktId: 1, title: "Show 1", seasons: [2] };
    for (const restoreFirst of [false, true]) {
      trakt().options.read();
      const options = { ignoredShows: [traktShow(1).show], ignoredSeasons: [seasonRule] };
      cache.__shelfcheckDatabase!.prepare(`INSERT INTO shelfcheck_scan_state (mode, options, report, resume_point) VALUES ('trakt', ?, ?, ?)
        ON CONFLICT(mode) DO UPDATE SET options = excluded.options, report = excluded.report, resume_point = excluded.resume_point`)
        .run(JSON.stringify(options), JSON.stringify(traktReport()), JSON.stringify(traktReport()));
      cache.__shelfcheckDatabase!.close();
      delete cache.__shelfcheckDatabase;

      if (!restoreFirst) {
        assert.deepEqual(traktIds(trakt().report.read()), [2]);
        assert.deepEqual((trakt().resumePoint.read() as TraktReport).missing.map((row) => row.show.ids.trakt), [2]);
      }
      trakt().options.patch({ ignoredShows: [] });
      cache.__shelfcheckDatabase!.close();
      delete cache.__shelfcheckDatabase;
      assert.deepEqual(trakt().options.read(), { ignoredShows: [], ignoredSeasons: [seasonRule] });
      for (const report of [trakt().report.read(), trakt().resumePoint.read()] as TraktReport[]) {
        assert.deepEqual(report.shows.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual(report.missing.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual(Object.keys(report.scanCache), ["2"]);
      }
    }
  });

  await t.test("reopening keeps retained Trakt results of an expired Ignore", () => {
    const expired = { ...traktShow(1).show, duration: "30d", expiresAt: "2000-01-01T00:00:00.000Z" };
    cache.__shelfcheckDatabase!.prepare("UPDATE shelfcheck_scan_state SET options = ?, report = ?, resume_point = ? WHERE mode = 'trakt'")
      .run(JSON.stringify({ ignoredShows: [expired] }), JSON.stringify(traktReport()), JSON.stringify(traktReport()));
    cache.__shelfcheckDatabase!.close();
    delete cache.__shelfcheckDatabase;
    for (const report of [trakt().report.read(), trakt().resumePoint.read()]) assert.deepEqual(traktIds(report), [1, 2]);
  });

  // The upgrade itself discards legacy Plex results (tests/database-migrations.test.ts); results
  // retained in the saved scan state by some other path are still removed when SQLite opens.
  await t.test("reopening a Plex saved scan state removes retained results of active Ignores before reads or a direct Restore", () => {
    const seasonRule = { ratingKey: "one", title: "one", seasons: [2] };
    for (const restoreFirst of [false, true]) {
      sqlite.savedScanState("plex").options.read();
      const settings = { ignoredShows: [{ ratingKey: "one", title: "one" }], ignoredSeasons: [seasonRule] };
      cache.__shelfcheckDatabase!.prepare(`INSERT INTO shelfcheck_scan_state (mode, options, report, resume_point) VALUES ('plex', ?, ?, ?)
        ON CONFLICT(mode) DO UPDATE SET options = excluded.options, report = excluded.report, resume_point = excluded.resume_point`)
        .run(JSON.stringify(settings), JSON.stringify(plexReport()), JSON.stringify(plexReport()));
      cache.__shelfcheckDatabase!.close();
      delete cache.__shelfcheckDatabase;

      if (!restoreFirst) {
        assert.deepEqual((sqlite.savedScanState("plex").report.read() as ReturnType<typeof plexReport>).shows.map((row) => row.ratingKey), ["two"]);
        assert.deepEqual(Object.keys((sqlite.savedScanState("plex").resumePoint.read() as ReturnType<typeof plexReport>).scanCache), ["two"]);
      }
      sqlite.savedScanState("plex").options.patch({ ignoredShows: [], ignoredSeasons: [seasonRule] });
      cache.__shelfcheckDatabase!.close();
      delete cache.__shelfcheckDatabase;
      assert.deepEqual(sqlite.savedScanState("plex").options.read(), { ignoredShows: [], ignoredSeasons: [seasonRule] });
      for (const report of [sqlite.savedScanState("plex").report.read(), sqlite.savedScanState("plex").resumePoint.read()] as ReturnType<typeof plexReport>[]) {
        assert.deepEqual(report.shows.map((row) => row.ratingKey), ["two"]);
        assert.deepEqual(Object.keys(report.scanCache), ["two"]);
      }
    }
  });

  await t.test("reopening keeps retained Plex results of an expired Ignore", () => {
    const expired = { ratingKey: "one", title: "one", duration: "30d", expiresAt: "2000-01-01T00:00:00.000Z" };
    cache.__shelfcheckDatabase!.prepare(`UPDATE shelfcheck_scan_state SET options = ?, report = ?, resume_point = ? WHERE mode = 'plex'`)
      .run(JSON.stringify({ ignoredShows: [expired] }), JSON.stringify(plexReport()), JSON.stringify(plexReport()));
    cache.__shelfcheckDatabase!.close();
    delete cache.__shelfcheckDatabase;
    for (const report of [sqlite.savedScanState("plex").report.read(), sqlite.savedScanState("plex").resumePoint.read()] as ReturnType<typeof plexReport>[]) {
      assert.deepEqual(report.shows.map((row) => row.ratingKey), ["one", "two"]);
    }
  });

  await t.test("Ignore then Restore during a Trakt scan cannot resurrect pending report or checkpoint rows", () => {
    trakt().options.patch({ ignoredShows: [] });
    trakt().report.write(traktReport());
    trakt().resumePoint.write(traktReport());
    const finish = sqlite.trackScanIgnores("trakt");
    try {
      trakt().options.patch({ ignoredShows: [traktShow(1).show] });
      trakt().options.patch({ ignoredShows: [] });
      trakt().report.write(traktReport());
      trakt().resumePoint.write(traktReport());
      for (const report of [trakt().report.read(), trakt().resumePoint.read()] as TraktReport[]) {
        assert.deepEqual(report.shows.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual(report.missing.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual(Object.keys(report.scanCache), ["2"]);
      }
    } finally { finish(); }
    trakt().report.write(traktReport());
    assert.equal(traktIds(trakt().report.read()).length, 2);
  });

  await t.test("Ignore then Restore during a Plex scan cannot resurrect pending report or checkpoint rows", () => {
    sqlite.savedScanState("plex").options.patch({ ignoredShows: [] });
    const finish = sqlite.trackScanIgnores("plex");
    try {
      sqlite.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "one", title: "one" }] });
      sqlite.savedScanState("plex").options.patch({ ignoredShows: [] });
      sqlite.savedScanState("plex").report.write(plexReport());
      sqlite.savedScanState("plex").resumePoint.write(plexReport());
      for (const report of [sqlite.savedScanState("plex").report.read(), sqlite.savedScanState("plex").resumePoint.read()] as ReturnType<typeof plexReport>[]) {
        assert.deepEqual(report.shows.map((row) => row.ratingKey), ["two"]);
        assert.deepEqual(Object.keys(report.scanCache), ["two"]);
      }
    } finally { finish(); }
    sqlite.savedScanState("plex").report.write(plexReport());
    assert.equal((sqlite.savedScanState("plex").report.read() as ReturnType<typeof plexReport>).shows.length, 2);
  });

  await t.test("a scan retains its initial ignore exclusions after their deadline passes", () => {
    const expiry = "2000-01-01T00:00:01.000Z";
    const started = Date.parse("2000-01-01T00:00:00.000Z");
    trakt().options.patch({ ignoredShows: [{ ...traktShow(1).show, expiresAt: expiry }] });
    sqlite.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "one", title: "one", expiresAt: expiry }] });
    const finishTrakt = sqlite.trackScanIgnores("trakt", started);
    const finishPlex = sqlite.trackScanIgnores("plex", started);
    try {
      trakt().report.write(traktReport());
      sqlite.savedScanState("plex").report.write(plexReport());
      assert.deepEqual(traktIds(trakt().report.read()), [2]);
      assert.deepEqual((sqlite.savedScanState("plex").report.read() as ReturnType<typeof plexReport>).shows.map((row) => row.ratingKey), ["two"]);
    } finally { finishTrakt(); finishPlex(); }
    trakt().report.write(traktReport());
    sqlite.savedScanState("plex").report.write(plexReport());
    assert.equal(traktIds(trakt().report.read()).length, 2);
    assert.equal((sqlite.savedScanState("plex").report.read() as ReturnType<typeof plexReport>).shows.length, 2);
  });

  await t.test("season ignores retain saved results and expired whole-show ignores allow fresh results", () => {
    const expiry = "2000-01-01T00:00:00.000Z";
    trakt().options.patch({ ignoredShows: [{ ...traktShow(1).show, expiresAt: expiry }], ignoredSeasons: [{ traktId: 1, title: "Show 1", seasons: [1] }] });
    trakt().report.write(traktReport());
    sqlite.savedScanState("plex").options.patch({ ignoredShows: [{ ratingKey: "one", title: "one", expiresAt: expiry }], ignoredSeasons: [{ ratingKey: "one", title: "one", seasons: [1] }] });
    sqlite.savedScanState("plex").report.write(plexReport());
    assert.equal((trakt().report.read() as TraktReport).missing.length, 2);
    assert.equal((sqlite.savedScanState("plex").report.read() as ReturnType<typeof plexReport>).shows.length, 2);
  });

  await t.test("stored deadlines and legacy permanent records survive reopening SQLite", () => {
    const legacy = { ratingKey: "legacy", title: "Legacy" };
    const temporary = { ratingKey: "temporary", title: "Temporary", duration: "90d", expiresAt: "2099-01-01T00:00:00.000Z" };
    sqlite.savedScanState("plex").options.patch({ ignoredShows: [legacy, temporary] });
    const traktIgnore = { ...traktShow(1).show, duration: "6m", expiresAt: "2099-01-01T00:00:00.000Z" };
    trakt().options.patch({ ignoredShows: [traktIgnore] });
    cache.__shelfcheckDatabase!.close();
    delete cache.__shelfcheckDatabase;
    assert.deepEqual(sqlite.savedScanState("plex").options.read().ignoredShows, [legacy, temporary]);
    assert.deepEqual(trakt().options.read().ignoredShows, [traktIgnore]);
  });
});

test("upgrading a legacy Trakt database keeps its Ignores and discards its retained results", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "shelfcheck-ignore-upgrade-"));
  const previousDirectory = process.env.SHELFCHECK_DATA_DIR;
  const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanIgnoreGuards?: object };
  cache.__shelfcheckDatabase?.close();
  delete cache.__shelfcheckDatabase;
  process.env.SHELFCHECK_DATA_DIR = directory;
  t.after(() => {
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    delete cache.__shelfcheckScanIgnoreGuards;
    if (previousDirectory === undefined) delete process.env.SHELFCHECK_DATA_DIR;
    else process.env.SHELFCHECK_DATA_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  });
  const seasonRule = { traktId: 1, title: "Show 1", seasons: [2] };
  const legacy = new DatabaseSync(path.join(directory, "shelfcheck.db"));
  legacy.exec("CREATE TABLE shelfcheck_states (user_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  legacy.prepare("INSERT INTO shelfcheck_states (user_id, payload) VALUES ('single-user', ?)")
    .run(JSON.stringify({ ignoredShows: [traktShow(1).show], ignoredSeasons: [seasonRule], report: traktReport(), checkpoint: traktReport() }));
  legacy.close();

  assert.deepEqual(trakt().options.read(), { ignoredShows: [traktShow(1).show], ignoredSeasons: [seasonRule] });
  assert.equal(trakt().report.read(), null, "The retained report is discarded, so no Restore can expose it");
  assert.equal(trakt().resumePoint.read(), null);
});
