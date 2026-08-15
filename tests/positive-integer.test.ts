import assert from "node:assert/strict";
import test from "node:test";
import { positiveInteger } from "../lib/positive-integer";

test("positive integer parsing rejects cache-wide sentinel values", () => {
  assert.equal(positiveInteger("12"), 12);
  assert.equal(positiveInteger("0"), undefined);
  assert.equal(positiveInteger(-1), undefined);
  assert.equal(positiveInteger(1.5), undefined);
  assert.equal(positiveInteger(null), undefined);
});
