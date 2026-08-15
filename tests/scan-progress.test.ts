import assert from "node:assert/strict";
import test from "node:test";
import { scanProgressPercent } from "../lib/scan-progress";

test("an active scan cannot report 100 percent", () => {
  assert.equal(scanProgressPercent(10, 10, true), 99);
  assert.equal(scanProgressPercent(11, 10, true), 99);
});

test("a finished scan can report 100 percent", () => {
  assert.equal(scanProgressPercent(10, 10, false), 100);
});

test("scan progress stays within display bounds", () => {
  assert.equal(scanProgressPercent(-1, 10, true), 0);
  assert.equal(scanProgressPercent(1, 3, true), 33);
  assert.equal(scanProgressPercent(0, 0, true), 0);
});
