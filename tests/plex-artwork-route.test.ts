import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import test from "node:test";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const route = await import("../app/api/plex/artwork/route");
const { savedScanState } = await import("../lib/ignore-results");
hook.deregister();

const cache = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };

function useDataDirectory(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "plex-artwork-route-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  // Any provider, Plex or image request from the route fails the test.
  const originalFetch = globalThis.fetch;
  const outgoing: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { outgoing.push(String(input)); throw new Error("no network"); }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    cache.__shelfcheckDatabase?.close();
    delete cache.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return outgoing;
}

test("the Plex artwork index is empty, private and uncached when no Plex report is saved", async (t) => {
  const outgoing = useDataDirectory(t);
  assert.equal(route.dynamic, "force-dynamic");
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), { shows: [] });
  assert.deepEqual(outgoing, []);
});

test("the Plex artwork index carries only each saved show's GUIDs, TMDB and TVDB IDs and allowed thumbnail", async (t) => {
  const outgoing = useDataDirectory(t);
  const report = {
    lastScan: "2026-11-24T12:00:00.000Z",
    scanCache: { "10": { plexUrl: "http://plex.local:32400", token: "secret-token" } },
    shows: [
      {
        ratingKey: "10", plexGuid: "plex://show/5d9c083cffd9ef001e990367", plexGuids: ["plex://show/5d9c083cffd9ef001e990367", "plex://show/6e9c083cffd9ef001e990368"],
        plexRatingKeys: ["10", "11"], title: "Nirvanna the Band the Show", year: 2017, thumb: "/library/metadata/10/thumb/1795468641",
        tmdbId: 70123, tvdbId: 330000, tvdbSlug: "nirvanna", plexEpisodes: 8, missing: [{ season: 1, episode: 1 }], warning: "w",
      },
      { ratingKey: "20", title: "No identities", thumb: "/library/sections/1", plexEpisodes: 1, missing: [] },
      { ratingKey: "30", plexGuid: "not-a-guid", title: "Bad thumb", thumb: "http://plex.local:32400/library/metadata/30/thumb?X-Plex-Token=secret-token", tmdbId: -1, tvdbId: 0, plexEpisodes: 1, missing: [] },
    ],
  };
  savedScanState("plex").commitReport(report);

  const response = await route.GET();
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body, {
    shows: [
      { ratingKey: "10", plexGuids: ["plex://show/5d9c083cffd9ef001e990367", "plex://show/6e9c083cffd9ef001e990368"], tmdbId: 70123, tvdbId: 330000, thumb: "/library/metadata/10/thumb/1795468641" },
      { ratingKey: "20", plexGuids: [] },
      { ratingKey: "30", plexGuids: [] },
    ],
  });
  assert.doesNotMatch(JSON.stringify(body), /secret-token|plex\.local/);
  assert.deepEqual(outgoing, [], "the index reads saved data only");
  assert.deepEqual(savedScanState("plex").report.read(), report, "reading the index does not change the saved report");
});
