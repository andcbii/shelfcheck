import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
const hook = registerHooks({resolve(s,c,next) { return s === "server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c); }});
const { seriesNotFoundHistory } = await import("../lib/series-not-found-history");
const { clearPlexInputs } = await import("../lib/plex-catalogues");
hook.deregister();

const global = globalThis as typeof globalThis & {__shelfcheckDatabase?: DatabaseSync};
const restart = () => { global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase; };
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(),"series-not-found-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => { restart(); if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous; rmSync(dir,{recursive:true,force:true}); });
}

test("an ID with no history has counted no 404 days", t => {
  temporaryDatabase(t);
  assert.equal(seriesNotFoundHistory().countedDays("tmdb", 323094), 0);
});

test("404s count once per UTC day of the series request, across UTC midnight", t => {
  temporaryDatabase(t);
  const history = seriesNotFoundHistory();
  for (const at of ["2026-11-20T00:00:00.000Z", "2026-11-20T08:00:00.000Z", "2026-11-20T12:00:00.000Z", "2026-11-20T20:00:00.000Z", "2026-11-20T23:59:59.999Z"])
    history.recordNotFound("tmdb", 323094, at);
  assert.equal(history.countedDays("tmdb", 323094), 1, "five 404s on one UTC day count once");
  assert.equal(history.recordNotFound("tmdb", 323094, "2026-11-21T00:00:00.000Z"), 2, "the next UTC day counts again");
  assert.equal(history.recordNotFound("tmdb", 323094, "2026-11-21T23:00:00.000Z"), 2);
});

test("the count is per provider and series ID", t => {
  temporaryDatabase(t);
  const history = seriesNotFoundHistory();
  history.recordNotFound("tmdb", 7, "2026-11-20T00:00:00.000Z");
  assert.equal(history.countedDays("tvdb", 7), 0, "the same number at the other provider is another record");
  assert.equal(history.countedDays("tmdb", 8), 0);
});

test("only a complete download resets the count to 0, and counting starts again after it", t => {
  temporaryDatabase(t);
  const history = seriesNotFoundHistory();
  history.recordNotFound("tvdb", 82643, "2026-11-20T00:00:00.000Z");
  history.recordNotFound("tvdb", 82643, "2026-11-21T00:00:00.000Z");
  history.resetAfterCompleteDownload("tvdb", 82643);
  assert.equal(history.countedDays("tvdb", 82643), 0);
  assert.equal(history.recordNotFound("tvdb", 82643, "2026-11-21T10:00:00.000Z"), 1, "a 404 after the reset counts, even on an already counted day");
});

test("the count survives a restart and both a single-show and a full Clear cache", t => {
  temporaryDatabase(t);
  seriesNotFoundHistory().recordNotFound("tmdb", 323094, "2026-11-20T00:00:00.000Z");
  restart();
  clearPlexInputs("ratingKey:1");
  clearPlexInputs();
  restart();
  assert.equal(seriesNotFoundHistory().countedDays("tmdb", 323094), 1);
});
