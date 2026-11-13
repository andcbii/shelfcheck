import assert from "node:assert/strict";
import test from "node:test";
import { harness as workflow, key, type Episode } from "./report-missing-harness";

// A one-to-one Manual Match between an owned TMDB episode and a TVDB special
// (S00E01). An unmapped TVDB special stays out of missing results as before.
const owned: Episode = { provider: "TMDB", id: 100, season: 1, episode: 5, name: "Christmas special" };
const special: Episode = { provider: "TVDB", id: 900, season: 0, episode: 1, name: "Christmas special (TVDB)" };
const unmapped: Episode = { provider: "TVDB", id: 901, season: 0, episode: 2, name: "Behind the scenes" };
const harness = (t: test.TestContext) => workflow(t, [owned, special, unmapped], [owned]);

test("Report Missing on a TVDB special keeps it in the missing results and its coverage group", async t => {
  const h = await harness(t);
  const mapping = (await (await h.save([owned, special])).json()).mapping;
  let result = await h.rerun();
  assert.deepEqual(h.missing(result), {}, "Unflagged specials stay out of missing results");

  const before = h.requests.length;
  await h.setFlags(mapping.id, [special]);
  assert.equal(h.requests.length, before, "The flag is evaluated from the saved catalogue without downloads");
  result = await h.status();
  assert.deepEqual(h.missing(result), { [key(special)]: "reported-missing" }, "The flagged TVDB special is Reported missing");
  assert.deepEqual(h.group(result, mapping.id), { [key(owned)]: "direct", [key(special)]: "reported-missing" });

  await h.setFlags(mapping.id, []);
  assert.deepEqual(h.missing(await h.status()), {}, "Clearing the flag hides the special again");
});

test("a TVDB catalogue saved without specials is downloaded again by the next scan after a flag is saved", async t => {
  const h = await harness(t);
  const mapping = (await (await h.save([owned, special])).json()).mapping;
  await h.rerun();
  // Simulate a catalogue saved before specials were kept.
  const catalogues = await import("../lib/plex-catalogues");
  const saved = catalogues.readPlexInputs().tvdb["20"];
  catalogues.savePlexCatalogue("tvdb", 20, { ...saved, episodes: saved.episodes.filter(episode => episode.season > 0) });
  // Saving the flag records a TVDB refresh obligation for the affected show (ADR-0003).
  await h.setFlags(mapping.id, [special]);
  assert.deepEqual(h.missing(await h.status()), {}, "The old catalogue cannot show the special yet");

  const before = h.requests.length;
  const result = await h.rerun();
  assert.ok(h.requests.slice(before).includes("/v4/series/20/episodes/default"), "The next scan downloads the TVDB catalogue again");
  assert.deepEqual(h.missing(result), { [key(special)]: "reported-missing" });

  const again = h.requests.length;
  await h.rerun();
  assert.ok(!h.requests.slice(again).includes("/v4/series/20/episodes/default"), "Once refreshed, the catalogue is reused");
});
