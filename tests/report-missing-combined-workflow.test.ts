import assert from "node:assert/strict";
import test from "node:test";
import { api, flag, harness as workflow, key, type Episode } from "./report-missing-harness";

// One combined episode is the same content as three split episodes, A, B and C.
// The local Plex file is the complete combined episode, so normal matching
// collects every part through the Manual Match. A separate one-to-one Manual
// Match ("other") is unrelated to the combined episode.
const directions = {
  "TMDB combined": {
    combined: { provider: "TMDB", id: 100, season: 1, episode: 1, name: "Whole" },
    parts: [
      { provider: "TVDB", id: 200, season: 2, episode: 1, name: "Part A" },
      { provider: "TVDB", id: 201, season: 2, episode: 2, name: "Part B" },
      { provider: "TVDB", id: 202, season: 2, episode: 3, name: "Part C" },
    ],
    other: [{ provider: "TMDB", id: 101, season: 1, episode: 2, name: "Other" }, { provider: "TVDB", id: 203, season: 2, episode: 4, name: "Other (TVDB)" }],
  },
  "TVDB combined": {
    combined: { provider: "TVDB", id: 300, season: 3, episode: 1, name: "Whole (TVDB)" },
    parts: [
      { provider: "TMDB", id: 110, season: 2, episode: 1, name: "Part A" },
      { provider: "TMDB", id: 111, season: 2, episode: 2, name: "Part B" },
      { provider: "TMDB", id: 112, season: 2, episode: 3, name: "Part C" },
    ],
    other: [{ provider: "TVDB", id: 301, season: 3, episode: 2, name: "Other (TVDB)" }, { provider: "TMDB", id: 113, season: 2, episode: 4, name: "Other" }],
  },
} satisfies Record<string, { combined: Episode; parts: Episode[]; other: Episode[] }>;
type Direction = (typeof directions)[keyof typeof directions];

// Plex owns the complete combined episode and the other mapping's source episode.
const harness = (t: test.TestContext, direction: Direction) => workflow(t, [direction.combined, ...direction.parts, ...direction.other], [direction.combined, direction.other[0]]);

for (const [name, direction] of Object.entries(directions)) {
  const { combined, parts: [a, b, c], other } = direction;
  const whole = key(combined);

  test(`${name}: reporting one split episode missing keeps the other parts collected and the combined episode incomplete`, async t => {
    const h = await harness(t, direction);
    const saved = await h.save([combined, a, b, c]);
    assert.equal(saved.status, 201, await saved.clone().text());
    const mapping = (await saved.json()).mapping;
    const unrelated = (await (await h.save(other)).json()).mapping;
    assert.deepEqual(h.missing(await h.rerun()), {}, "The directly owned combined episode covers every part through the complete Manual Match");

    // Flag C only. The save rechecks cached results without HTTP or a full scan.
    const before = h.requests.length;
    await h.setFlags(mapping.id, [c]);
    assert.equal(h.requests.length, before, "Saving a flag needs no provider download or Plex enumeration");
    let result = await h.status();
    assert.equal(result.scan.status, "completed");
    assert.deepEqual(h.missing(result), { [key(c)]: "reported-missing", [whole]: `incomplete because ${key(c)}` },
      "C is Reported missing, the combined episode stays missing although it is directly owned and matched by coordinates, and A/B stay collected");
    assert.deepEqual(h.group(result, mapping.id), { [whole]: `incomplete because ${key(c)}`, [key(a)]: "manual", [key(b)]: "manual", [key(c)]: "reported-missing" },
      "Grouped results show the derived status ahead of direct ownership and name the flagged part responsible");
    assert.deepEqual(await h.flags(mapping.id), [key(c)], "The derived status is never saved as a flag");

    // Explicit flags are durable; derived status is recalculated from them.
    h.state.secondLibrary = true;
    assert.deepEqual(h.missing(await h.rerun()), { [key(c)]: "reported-missing", [whole]: `incomplete because ${key(c)}` }, "Another library reporting the combined episode cannot hide it");
    h.restart();
    assert.deepEqual(await h.flags(mapping.id), [key(c)]);
    assert.deepEqual(h.missing(await h.rerun()), { [key(c)]: "reported-missing", [whole]: `incomplete because ${key(c)}` }, "Flags and derived status survive restarts and full scans");
    h.state.secondLibrary = false;

    // Independent decisions: each flagged part contributes, and clearing one removes only its effect.
    await h.setFlags(mapping.id, [b, c]);
    result = await h.status();
    assert.deepEqual(h.missing(result), { [key(b)]: "reported-missing", [key(c)]: "reported-missing", [whole]: `incomplete because ${key(b)},${key(c)}` });
    await h.setFlags(mapping.id, [b]);
    assert.deepEqual(h.missing(await h.status()), { [key(b)]: "reported-missing", [whole]: `incomplete because ${key(b)}` }, "Another flagged part still keeps the combined episode incomplete");

    // An explicit flag on the combined episode is independent of its parts.
    await h.setFlags(mapping.id, [combined, b]);
    result = await h.status();
    assert.deepEqual(h.missing(result), { [key(b)]: "reported-missing", [whole]: "reported-missing" }, "Explicit status outranks the derived one");
    await h.setFlags(mapping.id, [combined]);
    result = await h.status();
    assert.deepEqual(h.missing(result), { [whole]: "reported-missing" }, "Clearing the part keeps the explicitly flagged combined episode missing and infers no missing part");
    assert.deepEqual(h.group(result, mapping.id), { [whole]: "reported-missing", [key(a)]: "manual", [key(b)]: "manual", [key(c)]: "manual" },
      "The flagged combined episode keeps its source evidence, so every part retains Manual Match coverage");
    assert.deepEqual(h.missing(await h.rerun()), { [whole]: "reported-missing" });

    await h.setFlags(mapping.id, []);
    assert.deepEqual(h.missing(await h.status()), {}, "Clearing every flag restores normal matching immediately");
    assert.deepEqual(await h.flags(unrelated.id), [], "Unrelated mappings are untouched");
  });

  test(`${name}: removing flagged members and deleting the mapping withdraw derived status and keep unrelated flags`, async t => {
    const h = await harness(t, direction);
    const saved = await (await h.save([combined, a, b, c], { reportMissing: [flag(b), flag(c)] })).json();
    assert.deepEqual(await h.flags(saved.mapping.id), [key(b), key(c)].sort(), "Flags can be saved with a reviewed one-to-many preview");
    const unrelated = (await (await h.save(other, { reportMissing: [flag(other[1])] })).json()).mapping;
    assert.deepEqual(h.missing(await h.rerun()), { [key(b)]: "reported-missing", [key(c)]: "reported-missing", [whole]: `incomplete because ${key(b)},${key(c)}`, [key(other[1])]: "reported-missing" });

    // Removing C drops only C's flag and its derived effect; C now follows normal matching outside the mapping.
    const edited = await h.save([combined, a, b], { id: saved.mapping.id, revision: saved.mapping.revision });
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.deepEqual(await h.flags(saved.mapping.id), [key(b)]);
    assert.deepEqual(h.missing(await h.status()), { [key(b)]: "reported-missing", [key(c)]: "missing", [whole]: `incomplete because ${key(b)}`, [key(other[1])]: "reported-missing" },
      "The old and new members are rechecked through the cached path");

    // Bulk deletion withdraws the mapping's flags and derived status; unrelated flags remain.
    const bulk = await api.DELETE(new Request("http://localhost/api/plex/manual-coverage", { method: "DELETE", body: JSON.stringify({ ids: [saved.mapping.id] }) }));
    assert.equal(bulk.status, 200);
    assert.deepEqual(h.missing(await h.status()), { [key(a)]: "missing", [key(b)]: "missing", [key(c)]: "missing", [key(other[1])]: "reported-missing" },
      "The combined episode is collected again; unmapped parts lose Manual Match coverage");
    assert.deepEqual(await h.flags(unrelated.id), [key(other[1])]);

    // Individual deletion behaves the same way.
    const recreated = (await (await h.save([combined, a, b, c], { reportMissing: [flag(a)] })).json()).mapping;
    assert.deepEqual(h.missing(await h.status()), { [key(a)]: "reported-missing", [whole]: `incomplete because ${key(a)}`, [key(other[1])]: "reported-missing" });
    const single = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${recreated.id}`, { method: "DELETE" }));
    assert.equal(single.status, 200);
    assert.deepEqual(h.missing(await h.status()), { [key(a)]: "missing", [key(b)]: "missing", [key(c)]: "missing", [key(other[1])]: "reported-missing" });
    assert.deepEqual(await h.flags(unrelated.id), [key(other[1])]);
  });
}
