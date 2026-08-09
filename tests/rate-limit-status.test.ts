import assert from "node:assert/strict";
import test from "node:test";

import { isActiveRateLimitPause } from "../lib/rate-limit-status";

test("rate-limit pause is visible only while a scan is actively running", () => {
  assert.equal(isActiveRateLimitPause(true, true), true);
  assert.equal(isActiveRateLimitPause(true, false), false);
  assert.equal(isActiveRateLimitPause(false, true), false);
});
