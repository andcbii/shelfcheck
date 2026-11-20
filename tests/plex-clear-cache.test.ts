import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const sqlite = await import("../lib/sqlite");
const plex = await import("../lib/plex-catalogues");
hook.deregister();

const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
const restart = () => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase; };
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"plex-clear-cache-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => { restart(); if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous; rmSync(dir,{recursive:true,force:true}); });
}
const saved = (keys: string[]) => keys.filter(key => sqlite.readPlexGeneratedInputs(key) !== null);

test("storage deletes every generated input except the keys it is given", t => {
  temporaryDatabase(t);
  const keys = ["a", "b'); DROP TABLE x; --", "c", "c%"];
  for (const key of keys) sqlite.writePlexGeneratedInputs(key, {key});
  sqlite.deletePlexGeneratedInputsExcept(["b'); DROP TABLE x; --", "c%"]);
  assert.deepEqual(saved(keys), ["b'); DROP TABLE x; --", "c%"], "keys are matched exactly, never as SQL or patterns");
});

test("storage deletes every generated input when no key is kept", t => {
  temporaryDatabase(t);
  for (const key of ["a", "b"]) sqlite.writePlexGeneratedInputs(key, {key});
  sqlite.deletePlexGeneratedInputsExcept([]);
  assert.deepEqual(saved(["a", "b"]), []);
});

const catalogue = (id: number) => ({version: 1 as const, downloadedAt: "2026-11-01T00:00:00Z", show: {id}, episodes: []});
const comparison = (ratingKey: string) => ({
  group: {ratingKey}, details: [], localMetadata: [], complete: true, tmdbAliases: [], tvdbAliases: [],
  relationships: {"tmdb:1": {provider: "TMDB", value: {id: 1}, receivedAt: "2026-11-01T00:00:00Z"}},
}) as unknown as import("../lib/plex-catalogues").SavedPlexComparison;
function saveEveryGeneratedInput() {
  plex.savePlexCatalogue("tmdb", 1, catalogue(1));
  plex.savePlexCatalogue("tvdb", 2, catalogue(2));
  plex.savePlexComparison("show-1", comparison("show-1"));
  plex.savePlexComparison("show-2", comparison("show-2"));
  plex.savePlexInventory({capturedAt: "2026-11-01T00:00:00Z", complete: true, groups: [], items: {}, evidence: []});
  plex.saveDeferredTmdbChanges({"1": true});
  plex.savePendingTvdbChanges({"2": true});
  plex.savePendingSafeguards({"2026-11-01": true});
  plex.saveProviderVerification({tmdb: "2026-11-01T00:00:00Z", tvdb: "2026-11-02T00:00:00Z"});
  plex.saveCompletedFullScan("2026-11-03T00:00:00Z", {utcDate: "2026-11-03", count: 4});
  plex.saveSharedTmdbCrosswalk(77, {value: {id: 5}, receivedAt: "2026-11-01T00:00:00Z"});
  // Databases from before completed-scan counting still hold the legacy full-scan row.
  sqlite.writePlexGeneratedInputs("full-scan", {startedAt: "2026-10-01T00:00:00Z", successfulFullScans: {utcDate: "2026-10-01", count: 1}});
}

test("full catalogue Clear cache keeps scan accounting, verification positions and pending safeguards and removes everything else", t => {
  temporaryDatabase(t);
  saveEveryGeneratedInput();
  assert.deepEqual(plex.clearPlexInputs(), []);
  const inputs = plex.readPlexInputs();
  assert.deepEqual(inputs.tmdb, {});
  assert.deepEqual(inputs.tvdb, {});
  assert.deepEqual(inputs.comparisons, {});
  assert.equal(inputs.inventory, undefined);
  assert.deepEqual(inputs.deferredTmdbChanges, {});
  assert.deepEqual(inputs.pendingTvdbChanges, {});
  assert.equal(plex.readSharedTmdbCrosswalk(77), null);
  assert.deepEqual(inputs.pendingSafeguards, {"2026-11-01": true});
  assert.deepEqual(inputs.verification, {tmdb: "2026-11-01T00:00:00Z", tvdb: "2026-11-02T00:00:00Z"});
  assert.equal(inputs.completedFullScanAt, "2026-11-03T00:00:00Z");
  assert.deepEqual(inputs.completedFullScans, {utcDate: "2026-11-03", count: 4});
  assert.deepEqual(sqlite.readPlexGeneratedInputs("full-scan"), {startedAt: "2026-10-01T00:00:00Z", successfulFullScans: {utcDate: "2026-10-01", count: 1}});
});

test("clearing one show marks only its comparison for refresh and keeps every other generated input", t => {
  temporaryDatabase(t);
  saveEveryGeneratedInput();
  assert.deepEqual(plex.clearPlexInputs("show-1"), ["tmdb:1"]);
  const inputs = plex.readPlexInputs();
  assert.deepEqual(inputs.comparisons["show-1"].relationships, {});
  assert.deepEqual(inputs.comparisons["show-1"].refresh, {tmdb: true, tvdb: true});
  assert.equal(inputs.comparisons["show-1"].complete, false);
  assert.deepEqual(inputs.comparisons["show-2"], comparison("show-2"));
  assert.deepEqual(Object.keys(inputs.tmdb), ["1"]);
  assert.deepEqual(Object.keys(inputs.tvdb), ["2"]);
  assert.notEqual(inputs.inventory, undefined);
  assert.deepEqual(inputs.deferredTmdbChanges, {"1": true});
  assert.deepEqual(inputs.pendingTvdbChanges, {"2": true});
  assert.deepEqual(plex.readSharedTmdbCrosswalk(77), {value: {id: 5}, receivedAt: "2026-11-01T00:00:00Z"});
  assert.deepEqual(plex.clearPlexInputs("never-saved"), []);
});
