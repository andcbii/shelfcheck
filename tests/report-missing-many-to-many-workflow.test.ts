import assert from "node:assert/strict";
import test from "node:test";
import { api, flag, harness as workflow, key, type Episode, type Identity } from "./report-missing-harness";

// The same content is two TMDB episodes and three TVDB episodes, with no
// combined episode on either side. Plex owns both TMDB episodes, so normal
// matching collects every TVDB episode through the complete Manual Match.
// A separate one-to-one Manual Match ("other") is unrelated.
const first: Episode = { provider: "TMDB", id: 100, season: 1, episode: 1, name: "First half" };
const second: Episode = { provider: "TMDB", id: 101, season: 1, episode: 2, name: "Second half" };
const a: Episode = { provider: "TVDB", id: 200, season: 2, episode: 1, name: "Part A" };
const b: Episode = { provider: "TVDB", id: 201, season: 2, episode: 2, name: "Part B" };
const c: Episode = { provider: "TVDB", id: 202, season: 2, episode: 3, name: "Part C" };
const other: Episode[] = [{ provider: "TMDB", id: 102, season: 1, episode: 3, name: "Other" }, { provider: "TVDB", id: 203, season: 2, episode: 4, name: "Other (TVDB)" }];
const manyToMany = [first, second, a, b, c];
const harness = (t: test.TestContext) => workflow(t, [...manyToMany, ...other], [first, second, other[0]]);
type Harness = Awaited<ReturnType<typeof harness>>;

const otherFlag = { [key(other[1])]: "reported-missing" };

/** A manual save that must be rejected, leaving saved mappings, flags and cached results untouched. */
async function rejected(h: Harness, response: Promise<Response>, missingSide: "TMDB" | "TVDB") {
  const mappings = await h.mappings(), report = (await h.status()).report;
  const result = await response;
  assert.equal(result.status, 400);
  const body = await result.json();
  assert.equal(body.code, "report-missing-one-sided");
  assert.match(body.error, new RegExp(`at least one ${missingSide} episode.*or clear Report Missing on every episode`), "The error explains how to repair the selection or clear every flag");
  assert.deepEqual(await h.mappings(), mappings, "The saved mapping and its flags are unchanged");
  assert.deepEqual((await h.status()).report, report, "Cached results are unchanged");
}

const flagOnly = async (h: Harness, id: string, members: Identity[]) => {
  const current = (await h.mappings()).find(mapping => mapping.id === id)!;
  return h.post({ action: "save", id, revision: current.revision, reportMissing: members.map(flag) });
};
const edit = async (h: Harness, id: string, members: Episode[], extra: Record<string, unknown> = {}) => {
  const current = (await h.mappings()).find(mapping => mapping.id === id)!;
  return h.save(members, { id, revision: current.revision, ...extra });
};

test("many-to-many: zero flags keep complete-set matching, one-sided selections are rejected and flags on both sides are saved", async t => {
  const h = await harness(t);
  await rejected(h, h.save(manyToMany, { reportMissing: [flag(c)] }), "TMDB");
  assert.deepEqual(await h.mappings(), [], "A rejected new Manual Match is not created");

  const saved = await h.save(manyToMany);
  assert.equal(saved.status, 201, await saved.clone().text());
  const mapping = (await saved.json()).mapping;
  const unrelated = (await (await h.save(other, { reportMissing: [flag(other[1])] })).json()).mapping;
  let result = await h.rerun();
  assert.deepEqual(h.missing(result), otherFlag, "Owning the complete TMDB set collects every TVDB episode");

  // Either one-sided selection fails, whichever side it is on.
  const before = h.requests.length;
  await rejected(h, flagOnly(h, mapping.id, [second]), "TVDB");
  await rejected(h, flagOnly(h, mapping.id, [a, c]), "TMDB");
  assert.equal(h.requests.length, before, "Rejected saves recheck nothing");

  // Explicit flags on both sides are saved and rechecked without downloads or a full scan.
  await h.setFlags(mapping.id, [second, c]);
  assert.equal(h.requests.length, before, "Saving flags needs no provider download or Plex enumeration");
  result = await h.status();
  const flagged = { [key(second)]: "reported-missing", [key(c)]: "reported-missing", ...otherFlag };
  assert.deepEqual(h.missing(result), flagged,
    "The flagged episodes are Reported missing although directly owned or covered, and no unselected episode is inferred missing");
  assert.deepEqual(h.group(result, mapping.id), { [key(first)]: "direct", [key(second)]: "reported-missing", [key(a)]: "manual", [key(b)]: "manual", [key(c)]: "reported-missing" },
    "Unselected episodes keep their normal matching evidence");
  assert.deepEqual(await h.flags(mapping.id), [key(second), key(c)]);

  // Flags are durable across libraries, scans and restarts.
  h.state.secondLibrary = true;
  assert.deepEqual(h.missing(await h.rerun()), flagged);
  h.restart();
  assert.deepEqual(h.missing(await h.rerun()), flagged);
  h.state.secondLibrary = false;

  await h.setFlags(mapping.id, []);
  assert.deepEqual(h.missing(await h.status()), otherFlag, "Clearing every flag restores normal matching immediately");
  assert.deepEqual(await h.flags(unrelated.id), [key(other[1])], "Unrelated mappings are untouched");
});

test("membership edits that change mapping shape enforce both sides or none", async t => {
  const h = await harness(t);
  const oneToMany = [first, a, b, c];
  const mapping = (await (await h.save(oneToMany, { reportMissing: [flag(c)] })).json()).mapping;
  await h.save(other);
  const incomplete = { [key(c)]: "reported-missing", [key(first)]: `incomplete because ${key(c)}` };
  assert.deepEqual(h.missing(await h.rerun()), incomplete);

  // Adding a second TMDB episode makes the mapping many-to-many: its retained TVDB flag alone is one-sided.
  await rejected(h, edit(h, mapping.id, manyToMany), "TMDB");
  await rejected(h, edit(h, mapping.id, manyToMany, { reportMissing: [flag(c)] }), "TMDB");
  assert.deepEqual((await h.mappings())[0].members.map(key), oneToMany.map(key), "The saved membership is unchanged");
  assert.deepEqual(h.missing(await h.status()), incomplete);

  const repaired = await edit(h, mapping.id, manyToMany, { reportMissing: [flag(second), flag(c)] });
  assert.equal(repaired.status, 200, await repaired.clone().text());
  assert.deepEqual(h.missing(await h.status()), { [key(second)]: "reported-missing", [key(c)]: "reported-missing" },
    "A many-to-many mapping has no combined episode, so the first TMDB episode is no longer incomplete");

  // Removing the only flagged TVDB episode while both sides keep several episodes is one-sided too.
  await rejected(h, edit(h, mapping.id, [first, second, a, b]), "TVDB");
  // Removing the flagged TMDB episode leaves a valid one-to-many mapping with its retained TVDB flag.
  const narrowed = await edit(h, mapping.id, oneToMany);
  assert.equal(narrowed.status, 200, await narrowed.clone().text());
  assert.deepEqual(await h.flags(mapping.id), [key(c)]);
  assert.deepEqual(h.missing(await h.status()), incomplete, "The removed episode is rechecked and collected by its own ownership");

  const cleared = await edit(h, mapping.id, manyToMany, { reportMissing: [] });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.deepEqual(h.missing(await h.status()), {}, "A many-to-many edit that clears every flag is saved");
});

test("one-sided flags left by automatic cleanup stay active until the next manual save repairs or clears them", async t => {
  const h = await harness(t);
  const mapping = (await (await h.save(manyToMany, { reportMissing: [flag(second), flag(c)] })).json()).mapping;
  await h.save(other);
  // Automatic Ignore cleanup may delete the flags on one side without a manual save.
  h.writeFlags(mapping.id, [c]);
  const listed = await api.GET(new Request("http://localhost/api/plex/manual-coverage"));
  assert.equal(listed.status, 200, "Reading persisted one-sided state never fails");
  assert.deepEqual(await h.flags(mapping.id), [key(c)]);
  assert.deepEqual(h.missing(await h.rerun()), { [key(c)]: "reported-missing" }, "The remaining flag stays active in comparisons");

  await rejected(h, flagOnly(h, mapping.id, [c]), "TMDB");
  await rejected(h, edit(h, mapping.id, manyToMany), "TMDB");

  await h.setFlags(mapping.id, [first, c]);
  assert.deepEqual(h.missing(await h.status()), { [key(first)]: "reported-missing", [key(c)]: "reported-missing" }, "Repairing the selection saves it");
  h.writeFlags(mapping.id, [first]);
  await h.setFlags(mapping.id, []);
  assert.deepEqual(h.missing(await h.status()), {}, "Clearing every flag saves it");

  h.writeFlags(mapping.id, [c]);
  const deleted = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${mapping.id}`, { method: "DELETE" }));
  assert.equal(deleted.status, 200, "Deleting a mapping with one-sided flags is not blocked");
});
