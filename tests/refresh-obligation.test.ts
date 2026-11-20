import assert from "node:assert/strict";
import test from "node:test";
import { applyObligationPatch, effectivePatch, patchSavedObligation, PREFERRED_REQUIRED, savedObligation, unionObligations, type SavedRefreshObligations } from "../lib/refresh-obligation";

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
