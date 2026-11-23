import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const store = await import("../lib/catalogue-selection-store");
const ignoreResults = await import("../lib/ignore-results");
const { clearPlexInputs } = await import("../lib/plex-catalogues");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
const restart = () => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase; };
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"catalogue-selection-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => { restart(); if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous; rmSync(dir,{recursive:true,force:true}); });
}
const show = "plex://show/scooby";
const rejection = (code: string) => (error: unknown) => (error as {code?: string}).code === code;

test("an override is saved only for a currently reported candidate and survives restarts and cache clearing", t => {
  temporaryDatabase(t);
  assert.throws(() => store.saveCatalogueOverride(show,"tmdb",337142), rejection("validation"), "no candidates observed yet");
  store.observeCatalogueCandidates(show,{tmdb:[337142,2150],tvdb:[73817]},true);
  assert.throws(() => store.saveCatalogueOverride(show,"tmdb",99), rejection("validation"));
  assert.throws(() => store.saveCatalogueOverride(show,"tmdb",73817), rejection("validation"), "a TVDB ID is not a TMDB candidate");
  store.saveCatalogueOverride(show,"tmdb",337142);
  restart();
  clearPlexInputs();
  ignoreResults.savedScanState("plex").options.patch({diagnosticsEnabled:false});
  const saved = store.readCatalogueSelections()[show];
  assert.deepEqual(saved.tmdb.candidates.map(candidate => candidate.id),[2150,337142]);
  assert.equal(saved.tmdb.automaticId,2150);
  assert.equal(saved.tmdb.override,337142);
  assert.equal(saved.tmdb.preferredId,337142);
  assert.equal(saved.tvdb.override,undefined);
  assert.equal(saved.tvdb.preferredId,73817);
  store.saveCatalogueOverride(show,"tmdb",null);
  assert.equal(store.readCatalogueSelections()[show].tmdb.override,undefined);
  assert.equal(store.readCatalogueSelections()[show].tmdb.preferredId,2150);
});

test("the next scan uses the saved override until Plex removes a candidate", t => {
  temporaryDatabase(t);
  store.observeCatalogueCandidates(show,{tmdb:[1,2],tvdb:[7,8]},true);
  store.saveCatalogueOverride(show,"tmdb",2);
  store.saveCatalogueOverride(show,"tvdb",7);
  const added = store.observeCatalogueCandidates(show,{tmdb:[3,2,1,0],tvdb:[8,7]},true);
  assert.equal(added.tmdb.preferredId,2);
  assert.equal(added.tvdb.preferredId,7);
  const failed = store.observeCatalogueCandidates(show,{tmdb:[1],tvdb:[]},false);
  assert.equal(failed.tmdb.preferredId,2,"an incomplete observation is not evidence of removal");
  const removed = store.observeCatalogueCandidates(show,{tmdb:[2,3],tvdb:[8,7]},true);
  assert.equal(removed.tmdb.preferredId,2,"automatic choice of the remaining candidates");
  assert.equal(removed.tmdb.overrideCleared,true);
  assert.equal(removed.tvdb.preferredId,7,"TVDB is independent of a TMDB removal");
  const saved = store.readCatalogueSelections()[show];
  assert.equal(saved.tmdb.override,undefined);
  assert.equal(saved.tvdb.override,7);
  assert.equal(saved.tmdb.current,undefined,"observing candidates never claims a catalogue in use; only a completed comparison does");
});

test("what a removal drops is saved with the observation: if saving it fails, the removal is not committed and is reported again", t => {
  temporaryDatabase(t);
  store.observeCatalogueCandidates(show,{tmdb:[1,2],tvdb:[7]},true);
  assert.throws(() => store.observeCatalogueCandidates(show,{tmdb:[2],tvdb:[7]},true,() => { throw new Error("crash before the drop is saved"); }),/crash/);
  assert.deepEqual(store.readCatalogueSelections()[show].tmdb.candidates.map(candidate=>candidate.id),[1,2],"the candidate set is not committed without the drop");
  let persisted: Record<string,number[]> | undefined;
  const removed = store.observeCatalogueCandidates(show,{tmdb:[2],tvdb:[7]},true,selections => { persisted = {tmdb:selections.tmdb.removed,tvdb:selections.tvdb.removed}; });
  assert.deepEqual(persisted,{tmdb:[1],tvdb:[]},"the next observation reports the removal again, inside its transaction");
  assert.deepEqual(removed.tmdb.removed,[1]);
  let called = false;
  store.observeCatalogueCandidates(show,{tmdb:[2],tvdb:[7]},true,() => { called = true; });
  assert.equal(called,false,"an observation removing nothing has nothing to save");
});

test("candidate names are kept for retained IDs and do not affect the override", t => {
  temporaryDatabase(t);
  store.observeCatalogueCandidates(show,{tmdb:[2150,337142],tvdb:[]},true);
  store.saveCatalogueOverride(show,"tmdb",337142);
  store.recordCatalogueCandidateNames(show,"tmdb",[{id:2150,name:"The Scooby-Doo/Dynomutt Hour"},{id:337142,name:"The Scooby-Doo Show"},{id:5,name:"Not a candidate"}]);
  store.observeCatalogueCandidates(show,{tmdb:[337142,2150,1],tvdb:[]},true);
  store.recordCatalogueCandidateNames(show,"tmdb",[{id:337142,name:"The Scooby-Doo Show (1976)"}]);
  const saved = store.readCatalogueSelections()[show].tmdb;
  assert.deepEqual(saved.candidates,[{id:1},{id:2150,name:"The Scooby-Doo/Dynomutt Hour"},{id:337142,name:"The Scooby-Doo Show (1976)"}]);
  assert.equal(saved.override,337142);
  assert.equal(store.readCatalogueSelections()[show].tvdb.candidates.length,0);
});

test("overrides cannot change while a Plex scan is active", t => {
  temporaryDatabase(t);
  store.observeCatalogueCandidates(show,{tmdb:[1,2],tvdb:[]},true);
  let finish!: () => void;
  const run = scanRuns.start("plex", () => new Promise<void>(resolve => { finish = resolve; }));
  t.after(async () => { finish(); await run.settled; });
  assert.throws(() => store.saveCatalogueOverride(show,"tmdb",2), (error: unknown) => (error as {code?: string; status?: number}).code === "scan-active" && (error as {status?: number}).status === 409);
  assert.equal(store.readCatalogueSelections()[show].tmdb.override,undefined);
});
