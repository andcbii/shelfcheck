import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const sqlite = await import("../lib/sqlite");
const plexStateRoute = await import("../app/api/plex/state/route");
const traktStateRoute = await import("../app/api/state/route");
const traktScanRoute = await import("../app/api/scan/route");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync; __shelfcheckScanIgnoreGuards?: object };
const closeCached = () => { cache.__shelfcheckDatabase?.close(); delete cache.__shelfcheckDatabase; };

/** A fresh database in a disposable data directory; no cached handle or scan guard survives into or out of it. */
function freshDatabase(t: TestContext) {
  closeCached();
  delete cache.__shelfcheckScanIgnoreGuards;
  const dir = mkdtempSync(path.join(tmpdir(), "shelfcheck-saved-state-"));
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

test("each mode saves its report, Resume point, scan status and options, read back together in one snapshot", (t) => {
  freshDatabase(t);
  const plex = sqlite.savedScanState("plex");
  const trakt = sqlite.savedScanState("trakt");
  assert.equal(plex.snapshot(), null, "Nothing is saved yet");

  plex.options.patch({ diagnosticsEnabled: false });
  plex.report.write(plexResults());
  plex.resumePoint.write(plexResults("resume"));
  plex.status.write({ status: "running", processed: 1 });
  trakt.report.write(traktResults());

  assert.deepEqual(plex.report.read(), plexResults());
  assert.deepEqual(plex.resumePoint.read(), plexResults("resume"));
  assert.deepEqual(plex.status.read(), { status: "running", processed: 1 });
  assert.deepEqual(plex.options.read(), { diagnosticsEnabled: false });
  const snapshot = plex.snapshot()!;
  assert.deepEqual({ ...snapshot, updatedAt: typeof snapshot.updatedAt }, {
    report: plexResults(), resumePoint: plexResults("resume"), status: { status: "running", processed: 1 }, options: { diagnosticsEnabled: false }, updatedAt: "string",
  });

  assert.deepEqual(trakt.report.read(), traktResults(), "The Trakt row is its own");
  assert.equal(trakt.resumePoint.read(), null);
  assert.equal(trakt.status.read(), null);
  assert.deepEqual(trakt.options.read(), {});
  plex.report.clear();
  plex.resumePoint.clear();
  assert.equal(plex.report.read(), null);
  assert.equal(plex.resumePoint.read(), null);
  assert.deepEqual(trakt.report.read(), traktResults(), "Clearing Plex leaves Trakt");
});

/** A trigger that rejects every update of the saved scan state, as a failing store would. */
const rejectUpdates = (when = "") => cache.__shelfcheckDatabase!.exec(`CREATE TRIGGER reject_saved_state BEFORE UPDATE ${when} ON shelfcheck_scan_state BEGIN SELECT RAISE(ABORT, 'saved state unavailable'); END;`);
const allowUpdates = () => cache.__shelfcheckDatabase!.exec("DROP TRIGGER reject_saved_state");

test("committing a report clears its Resume point in the same write, and a rejected commit keeps both", (t) => {
  freshDatabase(t);
  const plex = sqlite.savedScanState("plex");
  const trakt = sqlite.savedScanState("trakt");
  plex.options.patch({ diagnosticsEnabled: false });
  plex.report.write(plexResults("old"));
  plex.resumePoint.write(plexResults("resume"));
  plex.status.write({ status: "running" });
  trakt.report.write(traktResults());
  trakt.resumePoint.write(traktResults("resume"));

  rejectUpdates();
  assert.throws(() => plex.commitReport(plexResults("new")), /saved state unavailable/);
  assert.throws(() => plex.clearReportAndResumePoint(), /saved state unavailable/);
  allowUpdates();
  assert.deepEqual(plex.report.read(), plexResults("old"), "The previous report stays");
  assert.deepEqual(plex.resumePoint.read(), plexResults("resume"), "The previous Resume point stays");

  plex.commitReport(plexResults("new"));
  assert.deepEqual(plex.report.read(), plexResults("new"));
  assert.equal(plex.resumePoint.read(), null);
  plex.resumePoint.write(plexResults("resume"));
  plex.clearReportAndResumePoint();
  assert.equal(plex.report.read(), null);
  assert.equal(plex.resumePoint.read(), null);
  assert.deepEqual(plex.options.read(), { diagnosticsEnabled: false }, "Options are kept");
  assert.deepEqual(plex.status.read(), { status: "running" }, "Scan status is kept");
  assert.deepEqual([trakt.report.read(), trakt.resumePoint.read()], [traktResults(), traktResults("resume")], "The other mode is untouched");
});

test("report and Resume point writes keep options; status writes keep every other part and the state timestamp", (t) => {
  freshDatabase(t);
  const plex = sqlite.savedScanState("plex");
  plex.options.patch({ diagnosticsEnabled: false, futureOption: { kept: true } });
  plex.report.write(plexResults());
  plex.resumePoint.write(plexResults("resume"));
  assert.deepEqual(plex.options.read(), { diagnosticsEnabled: false, futureOption: { kept: true } });

  cache.__shelfcheckDatabase!.exec("UPDATE shelfcheck_scan_state SET state_updated_at = '2020-01-01 00:00:00'");
  plex.status.write({ status: "running", heartbeatAt: "now" });
  const after = plex.snapshot()!;
  assert.deepEqual(after, { report: plexResults(), resumePoint: plexResults("resume"), status: { status: "running", heartbeatAt: "now" }, options: { diagnosticsEnabled: false, futureOption: { kept: true } }, updatedAt: "2020-01-01 00:00:00" }, "A heartbeat does not move the state timestamp");
  plex.options.patch({ diagnosticsEnabled: true });
  assert.notEqual(plex.snapshot()!.updatedAt, "2020-01-01 00:00:00", "A real state write does");
});

test("a status-only row has no saved options, distinct from empty options", (t) => {
  freshDatabase(t);
  const trakt = sqlite.savedScanState("trakt");
  trakt.status.write({ status: "completed" });
  assert.deepEqual(trakt.snapshot(), { report: null, resumePoint: null, status: { status: "completed" }, options: null, updatedAt: null });
  trakt.options.patch({});
  assert.deepEqual(trakt.snapshot()!.options, {});
});

test("an ordinary options patch writes no report or Resume point; omitted and unknown fields survive", (t) => {
  freshDatabase(t);
  const plex = sqlite.savedScanState("plex");
  const showRule = { ratingKey: "one", title: "one" };
  const seasonRule = { ratingKey: "two", title: "two", seasons: [1] };
  plex.options.patch({ ignoredShows: [showRule], ignoredSeasons: [seasonRule], diagnosticsEnabled: true, futureOption: 3 });
  plex.report.write(plexResults());
  plex.resumePoint.write(plexResults("resume"));

  // An active Ignore is saved, yet a diagnostics save must not rewrite the results.
  rejectUpdates("OF report, resume_point");
  plex.options.patch({ diagnosticsEnabled: false });
  allowUpdates();
  assert.deepEqual(plex.options.read(), { ignoredShows: [showRule], ignoredSeasons: [seasonRule], diagnosticsEnabled: false, futureOption: 3 });

  plex.options.patch({ ignoredShows: [] });
  assert.deepEqual(plex.options.read().ignoredSeasons, [seasonRule], "Season Ignores are independent of show Ignores");
  plex.options.patch({ ignoredSeasons: [] });
  assert.deepEqual(plex.options.read().ignoredShows, [], "Show Ignores are independent of season Ignores");
  assert.deepEqual(sqlite.savedScanState("trakt").snapshot(), null, "The other mode gains nothing");
});

test("an Ignore change prunes the saved report and Resume point, and Restore does not bring results back", (t) => {
  freshDatabase(t);
  const plex = sqlite.savedScanState("plex");
  plex.report.write(plexResults());
  plex.resumePoint.write(plexResults("resume"));
  plex.options.patch({ ignoredShows: [{ ratingKey: "one", title: "one" }] });
  for (const saved of [plex.report.read(), plex.resumePoint.read()] as Results[]) {
    assert.deepEqual(saved.shows.map(row => row.ratingKey), ["two"]);
    assert.deepEqual(Object.keys(saved.scanCache), ["two"]);
  }
  plex.options.patch({ ignoredShows: [] });
  assert.deepEqual((plex.report.read() as Results).shows.map(row => row.ratingKey), ["two"]);

  const trakt = sqlite.savedScanState("trakt");
  trakt.options.patch({ ignoredShows: [{ title: "Show 1", ids: { trakt: 1 } }] });
  trakt.report.write(traktResults());
  assert.deepEqual((trakt.report.read() as Results).shows.map(row => row.show!.ids.trakt), [2], "The Trakt row prunes by its own Ignores");
});

test("store operations join a transaction already open, so its rollback undoes them", (t) => {
  freshDatabase(t);
  const plex = sqlite.savedScanState("plex");
  plex.options.patch({ diagnosticsEnabled: true });
  plex.report.write(plexResults());
  const db = sqlite.database();
  db.exec("BEGIN IMMEDIATE");
  plex.options.patch({ diagnosticsEnabled: false, ignoredShows: [{ ratingKey: "one", title: "one" }] });
  plex.commitReport(plexResults("new"));
  db.exec("ROLLBACK");
  assert.deepEqual(plex.options.read(), { diagnosticsEnabled: true });
  assert.deepEqual(plex.report.read(), plexResults());
});

test("the Plex state route answers as before, and a Settings save through it keeps the report and unknown fields", async (t) => {
  freshDatabase(t);
  const patch = (body: unknown) => plexStateRoute.PATCH(new Request("http://localhost/api/plex/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const empty = await plexStateRoute.GET();
  assert.equal(empty.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await empty.json(), { settings: { ignoredShows: [], ignoredSeasons: [], hideUnairedEpisodes: false, airingOffsetDays: 0, autoCompoundEpisodes: true, diagnosticsEnabled: true } });

  const plex = sqlite.savedScanState("plex");
  plex.options.patch({ ignoredShows: [{ ratingKey: "one", title: "one" }], futureOption: 1 });
  plex.report.write(plexResults());
  rejectUpdates("OF report, resume_point");
  const saved = await patch({ diagnosticsEnabled: false, airingOffsetDays: 2 });
  allowUpdates();
  assert.deepEqual(await saved.json(), { saved: true });
  assert.deepEqual(plex.options.read(), { ignoredShows: [{ ratingKey: "one", title: "one" }], futureOption: 1, diagnosticsEnabled: false, airingOffsetDays: 2 });
  assert.deepEqual((await (await plexStateRoute.GET()).json()).settings, { ignoredShows: [{ ratingKey: "one", title: "one" }], ignoredSeasons: [], hideUnairedEpisodes: false, airingOffsetDays: 2, autoCompoundEpisodes: true, diagnosticsEnabled: false });
});

const traktState = async () => {
  const response = await traktStateRoute.GET();
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  return await response.json() as { state: Record<string, unknown> | null; updatedAt: string | null };
};
const patchTrakt = (body: unknown) => traktStateRoute.PATCH(new Request("http://localhost/api/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

test("the Trakt state route returns no state for an empty or status-only database, distinct from empty options", async (t) => {
  freshDatabase(t);
  assert.deepEqual(await traktState(), { state: null, updatedAt: null });
  sqlite.savedScanState("trakt").status.write({ status: "completed", processed: 1, total: 1 });
  assert.deepEqual(await traktState(), { state: null, updatedAt: null }, "A scan status alone is no saved state");

  assert.deepEqual(await (await patchTrakt({ unknownField: 1 })).json(), { saved: true });
  const saved = await traktState();
  assert.deepEqual(saved.state, { scan: { status: "completed", processed: 1, total: 1 } }, "Empty options are a saved state, with the scan nested");
  assert.equal(typeof saved.updatedAt, "string");
});

test("the Trakt state route nests the report, Resume point and scan in the saved options, as before", async (t) => {
  freshDatabase(t);
  const trakt = sqlite.savedScanState("trakt");
  await patchTrakt({ diagnosticsEnabled: false, airingGraceDays: 4, ignoredShows: [], ignoredSeasons: [] });
  trakt.report.write(traktResults());
  trakt.resumePoint.write(traktResults("resume"));
  const options = { diagnosticsEnabled: false, airingGraceDays: 4, ignoredShows: [], ignoredSeasons: [] };
  assert.deepEqual((await traktState()).state, { ...options, report: traktResults(), checkpoint: traktResults("resume") }, "No scan key without a scan status");

  trakt.status.write({ status: "running", processed: 1, total: 2 });
  trakt.commitReport(traktResults("new"));
  assert.deepEqual((await traktState()).state, { ...options, report: traktResults("new"), scan: { status: "running", processed: 1, total: 2 } });
  assert.deepEqual(sqlite.savedScanState("plex").snapshot(), null, "Trakt saves nothing for Plex");
});

test("a Trakt scan heartbeat does not move the state route's updatedAt, while a real state write does", async (t) => {
  freshDatabase(t);
  const trakt = sqlite.savedScanState("trakt");
  await patchTrakt({ diagnosticsEnabled: true });
  cache.__shelfcheckDatabase!.exec("UPDATE shelfcheck_scan_state SET state_updated_at = '2020-01-01 00:00:00' WHERE mode = 'trakt'");
  trakt.status.write({ status: "running", heartbeatAt: "now" });
  assert.equal((await traktState()).updatedAt, "2020-01-01 00:00:00");
  await patchTrakt({ diagnosticsEnabled: false });
  assert.notEqual((await traktState()).updatedAt, "2020-01-01 00:00:00");
});

test("clearing the Trakt cache empties the report's cache and clears the Resume point in one write; one show's clear removes only that show", async (t) => {
  freshDatabase(t);
  const trakt = sqlite.savedScanState("trakt");
  const clear = async (query = "") => (await traktScanRoute.DELETE(new Request(`http://localhost/api/scan${query}`, { method: "DELETE" }))).json();
  trakt.options.patch({ diagnosticsEnabled: false });
  trakt.report.write(traktResults());
  trakt.resumePoint.write(traktResults("resume"));

  assert.deepEqual(await clear("?traktId=1"), { cleared: 1 });
  assert.deepEqual((trakt.report.read() as Results).scanCache, { "2": 2 }, "The report keeps its results and other cache entries");
  assert.deepEqual(trakt.report.read()!.shows, traktResults().shows);
  assert.deepEqual((trakt.resumePoint.read() as Results).shows.map(row => row.show!.ids.trakt), [2], "The Resume point drops the show, so the next full run rechecks it");

  rejectUpdates("OF resume_point");
  assert.match((await clear()).error, /saved state unavailable/);
  allowUpdates();
  assert.deepEqual((trakt.report.read() as Results).scanCache, { "2": 2 }, "A rejected clear keeps the report's cache");
  assert.notEqual(trakt.resumePoint.read(), null, "and the Resume point");

  assert.deepEqual(await clear(), { cleared: 1 });
  assert.deepEqual(trakt.report.read(), { ...traktResults(), scanCache: {} });
  assert.equal(trakt.resumePoint.read(), null);
  assert.deepEqual(trakt.options.read(), { diagnosticsEnabled: false });
});
