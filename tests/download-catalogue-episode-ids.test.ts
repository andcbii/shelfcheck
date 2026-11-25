import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { CatalogueRequests } from "../lib/download-catalogue-source";
import { episodeIdEnumeration, type EpisodeIdUniverse } from "../lib/episode-id-universe";
import type { ProviderEpisode } from "../lib/plex-comparison";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { downloadCatalogueSource } = await import("../lib/download-catalogue-source");
const { readPlexInputs } = await import("../lib/plex-catalogues");
const { seriesNotFoundHistory } = await import("../lib/series-not-found-history");
const { createScanLogger } = await import("../lib/scan-log");
hook.deregister();

const global = globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync };
function temporaryDatabase(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "download-episode-ids-"));
  const previous = process.env.SHELFCHECK_DATA_DIR;
  process.env.SHELFCHECK_DATA_DIR = dir;
  t.after(() => {
    global.__shelfcheckDatabase?.close(); delete global.__shelfcheckDatabase;
    if (previous === undefined) delete process.env.SHELFCHECK_DATA_DIR; else process.env.SHELFCHECK_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

const NOW = new Date().toISOString();
const episode = (source: "TMDB" | "TVDB", id: number): ProviderEpisode => ({ season: 1, episode: id % 100, providerEpisodeId: id, source });
const evidence = (provider: "TMDB" | "TVDB", showId: number, ids: number[]): EpisodeIdUniverse => {
  const enumeration = episodeIdEnumeration(provider, showId);
  enumeration.add(ids.map(id => ({ id })));
  return enumeration.complete()!;
};

function source(requests: Partial<CatalogueRequests>, options: { targeted?: boolean } = {}) {
  const inputs = readPlexInputs();
  const unexpected = () => Promise.reject(new Error("unexpected request"));
  const catalogueSource = downloadCatalogueSource({
    inputs, now: NOW, targeted: options.targeted ?? true, tmdbChanges: new Set(), tvdbChanges: new Set(),
    requests: { tmdbShow: unexpected, tmdbShowForTvdb: unexpected, tmdbEpisodes: unexpected, tvdbSeries: unexpected, tvdbEnglishTitle: unexpected, ...requests },
    show: { ratingKey: "1", title: "Target" }, titles: { autoCompoundEpisodes: false, localEpisodes: [] },
    logger: createScanLogger(false), seriesNotFound: seriesNotFoundHistory(),
  });
  return { inputs, catalogueSource };
}

test("a fresh complete TMDB download carries its episode-ID evidence; its saved record and saved copy carry none", async t => {
  temporaryDatabase(t);
  const universe = evidence("TMDB", 10, [101, 102, 900]);
  const { inputs, catalogueSource } = source({
    tmdbShow: async id => ({ id, seasons: [{ season_number: 1 }] }),
    tmdbEpisodes: async () => ({ episodes: [episode("TMDB", 101), episode("TMDB", 102)], malformed: [], episodeIds: universe }),
  });

  const load = await catalogueSource.loadCatalogue("tmdb", 10, { mandatory: true });
  assert.equal(load.outcome, "downloaded");
  assert.deepEqual(load.outcome === "downloaded" && load.episodeIds, universe);
  assert.equal(load.outcome === "downloaded" && "episodeIds" in load.catalogue, false, "the evidence is not part of the catalogue payload");
  assert.equal(JSON.stringify(inputs.tmdb["10"]).includes("episodeIds"), false);
  assert.equal(JSON.stringify(readPlexInputs().tmdb["10"]).includes("episodeIds"), false);
  assert.equal(catalogueSource.savedCatalogue("tmdb", 10) && "episodeIds" in catalogueSource.savedCatalogue("tmdb", 10)!, false);

  // The next scan reuses that saved copy: no evidence.
  const reused = await source({}, { targeted: false }).catalogueSource.loadCatalogue("tmdb", 10, { mandatory: false });
  assert.equal(reused.outcome, "reused");
  assert.equal("episodeIds" in reused, false);
});

test("a fresh complete TVDB download carries its episode-ID evidence; a reused one carries none", async t => {
  temporaryDatabase(t);
  const universe = evidence("TVDB", 20, [201, 202]);
  const { catalogueSource } = source({ tvdbSeries: async () => ({ episodes: [episode("TVDB", 201)], malformed: [], episodeIds: universe }) });

  const load = await catalogueSource.loadCatalogue("tvdb", 20, { mandatory: true });
  assert.equal(load.outcome, "downloaded");
  assert.deepEqual(load.outcome === "downloaded" && load.episodeIds, universe);

  const reused = await source({}, { targeted: false }).catalogueSource.loadCatalogue("tvdb", 20, { mandatory: false });
  assert.equal(reused.outcome, "reused");
  assert.equal("episodeIds" in reused, false);
});

test("a download whose enumeration is incomplete carries no evidence", async t => {
  temporaryDatabase(t);
  // An incomplete enumeration yields no evidence; the download is still compared.
  const { catalogueSource } = source({
    tmdbShow: async id => ({ id, seasons: [{ season_number: 1 }] }),
    tmdbEpisodes: async () => ({ episodes: [episode("TMDB", 101)], malformed: [] }),
    tvdbSeries: async () => ({ episodes: [episode("TVDB", 201)], malformed: [] }),
  });
  for (const [provider, id] of [["tmdb", 10], ["tvdb", 20]] as const) {
    const load = await catalogueSource.loadCatalogue(provider, id, { mandatory: true });
    assert.equal(load.outcome, "downloaded");
    assert.equal("episodeIds" in load, false, `${provider} ${id}`);
  }
});

test("a failed download carries no evidence", async t => {
  temporaryDatabase(t);
  const { catalogueSource } = source({ tvdbSeries: () => Promise.reject(new Error("TVDB episode catalogue exceeded the safe pagination limit.")) });
  const load = await catalogueSource.loadCatalogue("tvdb", 20, { mandatory: true });
  assert.equal(load.outcome, "failed");
  assert.equal("episodeIds" in load, false);
});
