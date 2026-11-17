import assert from "node:assert/strict";
import test from "node:test";
import { catalogueNotices } from "../lib/catalogue-notice";

const scooby = [{ id: 2150, name: "The Scooby-Doo/Dynomutt Hour" }, { id: 337142, name: "The Scooby-Doo Show" }];
const single = { candidates: [{ id: 20, name: "Example" }], automaticId: 20, preferredId: 20, current: { preferredId: 20, usingId: 20, state: "preferred" as const, selectedAt: "2026-11-11T12:00:00Z" } };
const at = "2026-11-11T12:00:00Z";

test("an automatic choice shows the catalogue in use with its name and ID", () => {
  const notices = catalogueNotices({
    tmdb: { candidates: scooby, automaticId: 2150, preferredId: 2150, current: { preferredId: 2150, usingId: 2150, state: "preferred", selectedAt: at } },
    tvdb: single,
  });
  assert.deepEqual(notices.map((notice) => notice.text), ["Multiple TMDB IDs · Using The Scooby-Doo/Dynomutt Hour (2150)"]);
});

test("a saved override in use is shown as the override", () => {
  const notices = catalogueNotices({
    tmdb: { candidates: scooby, automaticId: 2150, override: 337142, preferredId: 337142, current: { preferredId: 337142, usingId: 337142, state: "preferred", selectedAt: at } },
    tvdb: single,
  });
  assert.deepEqual(notices.map((notice) => notice.text), ["Multiple TMDB IDs · Override: The Scooby-Doo Show (337142)"]);
});

test("a fallback shows the preferred ID and the fallback in use, never as the user's selection", () => {
  const notices = catalogueNotices({
    tmdb: { candidates: scooby, automaticId: 2150, override: 337142, preferredId: 337142, current: { preferredId: 337142, usingId: 2150, state: "fallback", selectedAt: at, preferredFailedAt: at } },
    tvdb: single,
  });
  assert.deepEqual(notices.map((notice) => notice.text), ["Multiple TMDB IDs · Preferred TMDB 337142 · Using fallback The Scooby-Doo/Dynomutt Hour (2150)"]);
});

test("saved data of an unavailable series is identified as the saved catalogue", () => {
  const unavailable = { state: "saved-unavailable" as const, selectedAt: at, preferredFailedAt: at, preferredDownloadedAt: "2026-10-01T12:00:00Z", preferredUsableUntil: "2026-11-30T12:00:00Z" };
  const automatic = catalogueNotices({ tmdb: { candidates: scooby, automaticId: 2150, preferredId: 2150, current: { ...unavailable, preferredId: 2150, usingId: 2150 } }, tvdb: single });
  const override = catalogueNotices({ tmdb: { candidates: scooby, automaticId: 2150, override: 337142, preferredId: 337142, current: { ...unavailable, preferredId: 337142, usingId: 337142 } }, tvdb: single });
  assert.deepEqual(automatic.map((notice) => notice.text), ["Multiple TMDB IDs · Using saved catalogue The Scooby-Doo/Dynomutt Hour (2150) · Series unavailable"]);
  assert.deepEqual(override.map((notice) => notice.text), ["Multiple TMDB IDs · Override: The Scooby-Doo Show (337142) · Using saved catalogue · Series unavailable"]);
});

test("without a usable catalogue the notice names the preferred ID and says none is in use", () => {
  const unavailable = catalogueNotices({ tmdb: { candidates: scooby, automaticId: 2150, override: 337142, preferredId: 337142, current: { preferredId: 337142, state: "unavailable", selectedAt: at } }, tvdb: single });
  const unscanned = catalogueNotices({ tmdb: { candidates: [{ id: 2150 }, { id: 337142 }], automaticId: 2150, preferredId: 2150 }, tvdb: single });
  assert.deepEqual(unavailable.map((notice) => notice.text), ["Multiple TMDB IDs · Preferred TMDB 337142 · No catalogue available"]);
  assert.deepEqual(unscanned.map((notice) => notice.text), ["Multiple TMDB IDs · Preferred TMDB 2150 · Not compared yet"]);
});

test("only providers with several distinct IDs get a notice, each provider separately", () => {
  assert.deepEqual(catalogueNotices(undefined), []);
  assert.deepEqual(catalogueNotices({ tmdb: single, tvdb: single }), []);
  const both = catalogueNotices({
    tmdb: { candidates: scooby, automaticId: 2150, preferredId: 2150, current: { preferredId: 2150, usingId: 2150, state: "preferred", selectedAt: at } },
    tvdb: { candidates: [{ id: 9 }, { id: 10 }], automaticId: 9, override: 10, preferredId: 10, current: { preferredId: 10, usingId: 10, state: "preferred", selectedAt: at } },
  });
  assert.deepEqual(both, [
    { provider: "tmdb", text: "Multiple TMDB IDs · Using The Scooby-Doo/Dynomutt Hour (2150)" },
    { provider: "tvdb", text: "Multiple TVDB IDs · Override: 10" },
  ]);
});

test("a preference changed after a scan with no usable catalogue names the saved preference, not the failed one", () => {
  const notices = catalogueNotices({
    tmdb: { candidates: [{ id: 10 }, { id: 11 }], automaticId: 10, override: 11, preferredId: 11, current: { preferredId: 10, state: "unavailable", selectedAt: at, preferredFailedAt: at } },
    tvdb: single,
  });
  assert.deepEqual(notices.map((notice) => notice.text), ["Multiple TMDB IDs · Preferred TMDB 11 · No catalogue available"]);
});
