import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedPlexThumbPath } from "../lib/plex-poster";

test("Plex poster proxy accepts only metadata thumbnail paths", () => {
  assert.equal(isAllowedPlexThumbPath("/library/metadata/123/thumb"), true);
  assert.equal(isAllowedPlexThumbPath("/library/metadata/123/thumb/456"), true);
  assert.equal(isAllowedPlexThumbPath("/library/sections"), false);
  assert.equal(isAllowedPlexThumbPath("/library/metadata/123/thumb?download=1"), false);
  assert.equal(isAllowedPlexThumbPath("//attacker.invalid/image"), false);
});
