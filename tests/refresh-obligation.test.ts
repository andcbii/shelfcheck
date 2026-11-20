import assert from "node:assert/strict";
import test from "node:test";
import { applyObligationPatch, effectivePatch, patchSavedObligation, PREFERRED_REQUIRED, requiresDownload, satisfiedByDownload, savedObligation, unionObligations, type SavedRefreshObligations } from "../lib/refresh-obligation";

test("a provider flag saved before requirements existed reads as the preferred requirement alone", () => {
  // Whatever wrote it (a safeguard, a single-show Clear cache), only the preferred part survives the upgrade.
  const saved: SavedRefreshObligations = { tmdb: true, tvdb: false };
  assert.deepEqual(savedObligation(saved, "tmdb"), { preferred: true });
  assert.deepEqual(savedObligation(saved, "tvdb"), {});
  assert.deepEqual(savedObligation(undefined, "tmdb"), {});
});

test("requirements merge by union, and a patch removes only the parts it names", () => {
  assert.deepEqual(unionObligations({ preferred: true, specificIds: [7, 3] }, { specificIds: [3, 5], everyAttempted: true }), { preferred: true, specificIds: [3, 5, 7], everyAttempted: true });
  const obligation = { preferred: true as const, specificIds: [3, 5], everyAttempted: true as const };
  assert.deepEqual(applyObligationPatch(obligation, { remove: { preferred: true } }), { specificIds: [3, 5], everyAttempted: true });
  assert.deepEqual(applyObligationPatch(obligation, { remove: { specificIds: [5] } }), { preferred: true, specificIds: [3], everyAttempted: true });
  assert.deepEqual(applyObligationPatch({}, {}), {});
});

test("an effective patch holds only what changes the obligation", () => {
  assert.deepEqual(effectivePatch({ preferred: true }, PREFERRED_REQUIRED), {});
  assert.deepEqual(effectivePatch({}, PREFERRED_REQUIRED), PREFERRED_REQUIRED);
  assert.deepEqual(effectivePatch({ specificIds: [3] }, { add: { specificIds: [3, 4] }, remove: { preferred: true, specificIds: [3] } }), { add: { specificIds: [4] }, remove: { specificIds: [3] } });
});

test("a saved obligation is patched in place for one provider, keeping the other provider and every other part", () => {
  const saved: SavedRefreshObligations = { tvdb: true, specificIds: { tmdb: [4], tvdb: [9] }, everyAttempted: { tvdb: true } };
  assert.equal(patchSavedObligation(saved, "tmdb", PREFERRED_REQUIRED), saved);
  assert.deepEqual(saved, { tmdb: true, tvdb: true, specificIds: { tmdb: [4], tvdb: [9] }, everyAttempted: { tvdb: true } });
  patchSavedObligation(saved, "tvdb", { remove: { preferred: true, specificIds: [9], everyAttempted: true } });
  assert.deepEqual(saved, { tmdb: true, specificIds: { tmdb: [4] } }, "emptied parts are left out of the stored value");
});

test("saved specific IDs are read as positive, de-duplicated integers", () => {
  const saved = { specificIds: { tmdb: [5, 5, 0, -1, 2.5, "7", 3] } } as unknown as SavedRefreshObligations;
  assert.deepEqual(savedObligation(saved, "tmdb"), { specificIds: [3, 5] });
});

test("specific IDs are validated when written: only positive integers are stored, once each", () => {
  const saved: SavedRefreshObligations = { specificIds: { tmdb: [4] } };
  patchSavedObligation(saved, "tmdb", { add: { specificIds: [9, 4, 9, 0, -3, 1.5, Number.NaN] } });
  assert.deepEqual(saved, { specificIds: { tmdb: [4, 9] } });
  patchSavedObligation(saved, "tvdb", { add: { specificIds: [0, -1] } });
  assert.deepEqual(saved, { specificIds: { tmdb: [4, 9] } }, "an add of only invalid IDs stores nothing");
});

test("a specific requirement forces only the catalogue with its ID, and that catalogue's download satisfies only its own requirement", () => {
  const obligation = { preferred: true as const, specificIds: [10] };
  assert.equal(requiresDownload(obligation, { id: 10, preferred: false }), true);
  assert.equal(requiresDownload(obligation, { id: 12, preferred: false }), false);
  assert.equal(requiresDownload(obligation, { id: 11, preferred: true }), true);
  assert.deepEqual(applyObligationPatch(obligation, satisfiedByDownload({ id: 10, preferred: false })), { preferred: true });
  assert.deepEqual(applyObligationPatch(obligation, satisfiedByDownload({ id: 11, preferred: true })), { specificIds: [10] });
  assert.deepEqual(applyObligationPatch({ preferred: true, specificIds: [11] }, satisfiedByDownload({ id: 11, preferred: true })), {});
});

test("the every-attempted requirement forces every attempted catalogue, the preferred requirement only the preferred one", () => {
  const preferred = { id: 11, preferred: true }, fallback = { id: 10, preferred: false };
  assert.equal(requiresDownload({ everyAttempted: true }, preferred), true);
  assert.equal(requiresDownload({ everyAttempted: true }, fallback), true);
  assert.equal(requiresDownload({ preferred: true }, fallback), false);
  assert.equal(requiresDownload({}, preferred), false);
});

test("the every-attempted requirement is satisfied with the preferred one: by a preferred download, never by a fallback download", () => {
  assert.deepEqual(satisfiedByDownload({ id: 11, preferred: true }), { remove: { preferred: true, everyAttempted: true, specificIds: [11] } });
  assert.deepEqual(satisfiedByDownload({ id: 10, preferred: false }), { remove: { specificIds: [10] } }, "only its own specific requirement");
  // A single catalogue (single Plex ID or derived series) is the preferred one.
  assert.deepEqual(applyObligationPatch({ everyAttempted: true, specificIds: [4] }, satisfiedByDownload({ preferred: true })), { specificIds: [4] });
});

test("a specific requirement matches a catalogue by its requested or its reported ID, and a download satisfies both names", () => {
  const attempt = { id: 11, reportedId: 21, preferred: false };
  assert.equal(requiresDownload({ specificIds: [21] }, attempt), true, "named by the ID the provider reports");
  assert.equal(requiresDownload({ specificIds: [11] }, attempt), true, "named by the ID requested");
  assert.equal(requiresDownload({ specificIds: [12] }, attempt), false);
  assert.deepEqual(applyObligationPatch({ specificIds: [11, 12, 21] }, satisfiedByDownload(attempt)), { specificIds: [12] });
});
