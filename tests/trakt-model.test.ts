import assert from "node:assert/strict";
import test from "node:test";

import { compactTraktShow } from "../lib/trakt-model";

test("shared Trakt compaction keeps scan and UI fields while dropping expanded payload data", () => {
  const show = compactTraktShow({
    title: "Example",
    year: 2026,
    ids: { trakt: 1, slug: "example", tmdb: 2 },
    images: { poster: ["poster", "unused"] },
    aired_episodes: 4,
    updated_at: "2026-08-09T00:00:00Z",
  });
  assert.deepEqual(show.images, { poster: ["poster"] });
  assert.equal(show.aired_episodes, 4);
  assert.equal(show.updated_at, "2026-08-09T00:00:00Z");
});
