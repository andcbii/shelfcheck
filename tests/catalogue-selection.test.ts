import assert from "node:assert/strict";
import test from "node:test";
import { removedCandidates, selectComparisonCatalogue } from "../lib/catalogue-selection";

test("automatic choice is the lowest numeric candidate", () => {
  assert.deepEqual(selectComparisonCatalogue({ observed: [10, 9], complete: true }), { candidates: [9, 10], commit: true, overrideCleared: false, automaticId: 9, preferredId: 9 });
  assert.equal(selectComparisonCatalogue({ observed: [], complete: true }).preferredId, undefined);
});

test("a newly added lower ID changes the automatic choice when there is no override", () => {
  assert.equal(selectComparisonCatalogue({ previous: [2150, 337142], observed: [1, 2150, 337142], complete: true }).preferredId, 1);
});

test("an override survives additions, including a lower ID", () => {
  const selected = selectComparisonCatalogue({ previous: [2150, 337142], observed: [337142, 1, 2150], complete: true, override: 337142 });
  assert.deepEqual(selected, { candidates: [1, 2150, 337142], commit: true, override: 337142, overrideCleared: false, automaticId: 1, preferredId: 337142 });
});

test("removing an unchosen candidate clears the override and selects automatically", () => {
  const selected = selectComparisonCatalogue({ previous: [1, 2], observed: [1], complete: true, override: 1 });
  assert.deepEqual(selected, { candidates: [1], commit: true, overrideCleared: true, automaticId: 1, preferredId: 1 });
});

test("removing the chosen candidate clears the override and selects the remaining one", () => {
  const selected = selectComparisonCatalogue({ previous: [1, 2], observed: [2], complete: true, override: 1 });
  assert.deepEqual(selected, { candidates: [2], commit: true, overrideCleared: true, automaticId: 2, preferredId: 2 });
});

test("an incomplete observation keeps the last observed set and the override", () => {
  const selected = selectComparisonCatalogue({ previous: [1, 2], observed: [1], complete: false, override: 2 });
  assert.deepEqual(selected, { candidates: [1, 2], commit: false, override: 2, overrideCleared: false, automaticId: 1, preferredId: 2 });
});

test("an incomplete first observation selects from what was seen without committing it", () => {
  assert.deepEqual(selectComparisonCatalogue({ observed: [20, 3], complete: false }), { candidates: [3, 20], commit: false, overrideCleared: false, automaticId: 3, preferredId: 3 });
});

test("only a complete observation removes candidates, and only ones the committed set contained", () => {
  assert.deepEqual(removedCandidates({ previous: [1, 2, 3], observed: [3, 4], complete: true }), [1, 2]);
  assert.deepEqual(removedCandidates({ previous: [1, 2], observed: [], complete: true }), [1, 2], "Plex reporting none removes every committed candidate");
  assert.deepEqual(removedCandidates({ previous: [1, 2], observed: [], complete: false }), [], "an incomplete observation is not evidence of removal");
  assert.deepEqual(removedCandidates({ observed: [], complete: true }), [], "an empty set that never held an ID removes nothing");
});
