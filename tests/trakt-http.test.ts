import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalTraktError, TraktHttpError } from "../lib/trakt-http";

test("expired and forbidden Trakt responses fail without message-text matching", () => {
  assert.equal(isTerminalTraktError(new TraktHttpError(401, "copy may change")), true);
  assert.equal(isTerminalTraktError(new TraktHttpError(403, "different copy")), true);
  assert.equal(isTerminalTraktError(new TraktHttpError(500, "retryable")), false);
  assert.equal(isTerminalTraktError(new Error("access token")), false);
});
