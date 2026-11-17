import assert from "node:assert/strict";
import test from "node:test";
import { multipleProviderIdsHref } from "../lib/multiple-provider-ids-link";

test("the review link targets the show's entry in the Multiple Provider IDs report", () => {
  assert.equal(multipleProviderIdsHref("plex://show/5d9c"), "/reports/multiple-provider-ids#show-plex%3A%2F%2Fshow%2F5d9c");
  assert.equal(multipleProviderIdsHref("ratingKey:12"), "/reports/multiple-provider-ids#show-ratingKey%3A12");
});
