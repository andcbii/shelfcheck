import assert from "node:assert/strict";
import test from "node:test";
import { ignoredPlexKeys, ignoredTraktIds } from "../lib/ignored-shows";

test("extracts valid ignored Trakt IDs and skips malformed settings", () => {
  assert.deepEqual([...ignoredTraktIds([{ ids: { trakt: 12 } }, null, { ids: { trakt: "13" } }, { ids: { trakt: 14 } }])], [12, 14]);
});

test("extracts valid ignored Plex identity keys", () => {
  assert.deepEqual([...ignoredPlexKeys([{ ratingKey: "plex://show/one" }, { ratingKey: "" }, {}, { ratingKey: "ratingKey:2" }])], ["plex://show/one", "ratingKey:2"]);
});
