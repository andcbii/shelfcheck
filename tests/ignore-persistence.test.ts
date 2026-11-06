import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
    sqlite.patchSingleUserState({ ignoredShows: [], ignoredSeasons: [seasonRule], report: traktReport(), checkpoint: traktReport() });
    sqlite.patchSingleUserState({ ignoredShows: [{ ...traktShow(1).show, duration: "30d", expiresAt: "2099-01-01T00:00:00.000Z" }] });
    const state = sqlite.readSingleUserState().state!;
    for (const report of [state.report, state.checkpoint] as ReturnType<typeof traktReport>[]) {
      assert.deepEqual(report.shows.map((row) => row.show.ids.trakt), [2]);
      assert.deepEqual(report.missing.map((row) => row.show.ids.trakt), [2]);
      assert.deepEqual(Object.keys(report.scanCache), ["2"]);
    }
    assert.deepEqual(state.ignoredSeasons, [seasonRule]);
    sqlite.patchSingleUserState({ ignoredShows: [] });
    assert.deepEqual((sqlite.readSingleUserState().state!.report as ReturnType<typeof traktReport>).shows.map((row) => row.show.ids.trakt), [2]);
  });

  await t.test("Plex whole-show ignores prune reports and checkpoints while retaining independent season rules", () => {
    const seasonRule = { ratingKey: "one", title: "one", seasons: [2] };
    sqlite.writePlexSettings({ ignoredShows: [], ignoredSeasons: [seasonRule] });
    sqlite.writePlexReport(plexReport());
    sqlite.writePlexCheckpoint(plexReport());
    sqlite.writePlexSettings({ ignoredShows: [{ ratingKey: "one", title: "one" }], ignoredSeasons: [seasonRule] });
    for (const report of [sqlite.readPlexReport(), sqlite.readPlexCheckpoint()] as ReturnType<typeof plexReport>[]) {
      assert.deepEqual(report.shows.map((row) => row.ratingKey), ["two"]);
      assert.deepEqual(Object.keys(report.scanCache), ["two"]);
    }
    assert.deepEqual(sqlite.readPlexSettings().ignoredSeasons, [seasonRule]);
    sqlite.writePlexSettings({ ignoredShows: [], ignoredSeasons: [seasonRule] });
    assert.deepEqual((sqlite.readPlexReport() as ReturnType<typeof plexReport>).shows.map((row) => row.ratingKey), ["two"]);
  });

  await t.test("upgrading a raw legacy Trakt database prunes retained results before reads or a direct Restore", () => {
    const seasonRule = { traktId: 1, title: "Show 1", seasons: [2] };
    for (const restoreFirst of [false, true]) {
      sqlite.readSingleUserState();
      const legacyState = { ignoredShows: [traktShow(1).show], ignoredSeasons: [seasonRule], report: traktReport(), checkpoint: traktReport() };
      cache.__shelfcheckDatabase!.prepare(`INSERT INTO shelfcheck_states (user_id, payload) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload`).run("single-user", JSON.stringify(legacyState));
      cache.__shelfcheckDatabase!.close();
      delete cache.__shelfcheckDatabase;

      if (!restoreFirst) {
        const state = sqlite.readSingleUserState().state!;
        assert.deepEqual((state.report as ReturnType<typeof traktReport>).shows.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual((state.checkpoint as ReturnType<typeof traktReport>).missing.map((row) => row.show.ids.trakt), [2]);
      }
      sqlite.patchSingleUserState({ ignoredShows: [] });
      cache.__shelfcheckDatabase!.close();
      delete cache.__shelfcheckDatabase;
      const restored = sqlite.readSingleUserState().state!;
      assert.deepEqual(restored.ignoredShows, []);
      assert.deepEqual(restored.ignoredSeasons, [seasonRule]);
      for (const report of [restored.report, restored.checkpoint] as ReturnType<typeof traktReport>[]) {
        assert.deepEqual(report.shows.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual(report.missing.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual(Object.keys(report.scanCache), ["2"]);
      }
    }
  });

  await t.test("upgrading a raw legacy Plex database prunes retained results before reads or a direct Restore", () => {
    const seasonRule = { ratingKey: "one", title: "one", seasons: [2] };
    for (const restoreFirst of [false, true]) {
      sqlite.readPlexSettings();
      const settings = { ignoredShows: [{ ratingKey: "one", title: "one" }], ignoredSeasons: [seasonRule] };
      cache.__shelfcheckDatabase!.prepare(`INSERT INTO shelfcheck_plex_state (user_id, settings, report, checkpoint) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, report = excluded.report, checkpoint = excluded.checkpoint`)
        .run("single-user", JSON.stringify(settings), JSON.stringify(plexReport()), JSON.stringify(plexReport()));
      cache.__shelfcheckDatabase!.close();
      delete cache.__shelfcheckDatabase;

      if (!restoreFirst) {
        assert.deepEqual((sqlite.readPlexReport() as ReturnType<typeof plexReport>).shows.map((row) => row.ratingKey), ["two"]);
        assert.deepEqual(Object.keys((sqlite.readPlexCheckpoint() as ReturnType<typeof plexReport>).scanCache), ["two"]);
      }
      sqlite.writePlexSettings({ ignoredShows: [], ignoredSeasons: [seasonRule] });
      cache.__shelfcheckDatabase!.close();
      delete cache.__shelfcheckDatabase;
      assert.deepEqual(sqlite.readPlexSettings(), { ignoredShows: [], ignoredSeasons: [seasonRule] });
      for (const report of [sqlite.readPlexReport(), sqlite.readPlexCheckpoint()] as ReturnType<typeof plexReport>[]) {
        assert.deepEqual(report.shows.map((row) => row.ratingKey), ["two"]);
        assert.deepEqual(Object.keys(report.scanCache), ["two"]);
      }
    }
  });

  await t.test("Ignore then Restore during a Trakt scan cannot resurrect pending report or checkpoint rows", () => {
    sqlite.patchSingleUserState({ ignoredShows: [], report: traktReport(), checkpoint: traktReport() });
    const finish = sqlite.trackScanIgnores("trakt");
    try {
      sqlite.patchSingleUserState({ ignoredShows: [traktShow(1).show] });
      sqlite.patchSingleUserState({ ignoredShows: [] });
      sqlite.patchSingleUserState({ report: traktReport(), checkpoint: traktReport() });
      const state = sqlite.readSingleUserState().state!;
      for (const report of [state.report, state.checkpoint] as ReturnType<typeof traktReport>[]) {
        assert.deepEqual(report.shows.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual(report.missing.map((row) => row.show.ids.trakt), [2]);
        assert.deepEqual(Object.keys(report.scanCache), ["2"]);
      }
    } finally { finish(); }
    sqlite.patchSingleUserState({ report: traktReport() });
    assert.equal((sqlite.readSingleUserState().state!.report as ReturnType<typeof traktReport>).shows.length, 2);
  });

  await t.test("Ignore then Restore during a Plex scan cannot resurrect pending report or checkpoint rows", () => {
    sqlite.writePlexSettings({ ignoredShows: [] });
    const finish = sqlite.trackScanIgnores("plex");
    try {
      sqlite.writePlexSettings({ ignoredShows: [{ ratingKey: "one", title: "one" }] });
      sqlite.writePlexSettings({ ignoredShows: [] });
      sqlite.writePlexReport(plexReport());
      sqlite.writePlexCheckpoint(plexReport());
      for (const report of [sqlite.readPlexReport(), sqlite.readPlexCheckpoint()] as ReturnType<typeof plexReport>[]) {
        assert.deepEqual(report.shows.map((row) => row.ratingKey), ["two"]);
        assert.deepEqual(Object.keys(report.scanCache), ["two"]);
      }
    } finally { finish(); }
    sqlite.writePlexReport(plexReport());
    assert.equal((sqlite.readPlexReport() as ReturnType<typeof plexReport>).shows.length, 2);
  });

  await t.test("a scan retains its initial ignore exclusions after their deadline passes", () => {
    const expiry = "2000-01-01T00:00:01.000Z";
    const started = Date.parse("2000-01-01T00:00:00.000Z");
    sqlite.patchSingleUserState({ ignoredShows: [{ ...traktShow(1).show, expiresAt: expiry }] });
    sqlite.writePlexSettings({ ignoredShows: [{ ratingKey: "one", title: "one", expiresAt: expiry }] });
    const finishTrakt = sqlite.trackScanIgnores("trakt", started);
    const finishPlex = sqlite.trackScanIgnores("plex", started);
    try {
      sqlite.patchSingleUserState({ report: traktReport() });
      sqlite.writePlexReport(plexReport());
      assert.deepEqual((sqlite.readSingleUserState().state!.report as ReturnType<typeof traktReport>).shows.map((row) => row.show.ids.trakt), [2]);
      assert.deepEqual((sqlite.readPlexReport() as ReturnType<typeof plexReport>).shows.map((row) => row.ratingKey), ["two"]);
    } finally { finishTrakt(); finishPlex(); }
    sqlite.patchSingleUserState({ report: traktReport() });
    sqlite.writePlexReport(plexReport());
    assert.equal((sqlite.readSingleUserState().state!.report as ReturnType<typeof traktReport>).shows.length, 2);
    assert.equal((sqlite.readPlexReport() as ReturnType<typeof plexReport>).shows.length, 2);
  });

  await t.test("season ignores retain saved results and expired whole-show ignores allow fresh results", () => {
    const expiry = "2000-01-01T00:00:00.000Z";
    sqlite.patchSingleUserState({ ignoredShows: [{ ...traktShow(1).show, expiresAt: expiry }], ignoredSeasons: [{ traktId: 1, title: "Show 1", seasons: [1] }], report: traktReport() });
    sqlite.writePlexSettings({ ignoredShows: [{ ratingKey: "one", title: "one", expiresAt: expiry }], ignoredSeasons: [{ ratingKey: "one", title: "one", seasons: [1] }] });
    sqlite.writePlexReport(plexReport());
    assert.equal((sqlite.readSingleUserState().state!.report as ReturnType<typeof traktReport>).missing.length, 2);
    assert.equal((sqlite.readPlexReport() as ReturnType<typeof plexReport>).shows.length, 2);
  });

  await t.test("stored deadlines and legacy permanent records survive reopening SQLite", () => {
    const legacy = { ratingKey: "legacy", title: "Legacy" };
    const temporary = { ratingKey: "temporary", title: "Temporary", duration: "90d", expiresAt: "2099-01-01T00:00:00.000Z" };
    sqlite.writePlexSettings({ ignoredShows: [legacy, temporary] });
    const traktIgnore = { ...traktShow(1).show, duration: "6m", expiresAt: "2099-01-01T00:00:00.000Z" };
    sqlite.patchSingleUserState({ ignoredShows: [traktIgnore] });
    cache.__shelfcheckDatabase!.close();
    delete cache.__shelfcheckDatabase;
    assert.deepEqual(sqlite.readPlexSettings().ignoredShows, [legacy, temporary]);
    assert.deepEqual(sqlite.readSingleUserState().state!.ignoredShows, [traktIgnore]);
  });
});
