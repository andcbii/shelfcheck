import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SeriesAssociation } from "../lib/comparison-catalogue-resolver";
import { applyObligationPatch, type RefreshObligation } from "../lib/refresh-obligation";
import { inMemoryCatalogueSource } from "./in-memory-catalogue-source";

// The resolver builds Coverage Issue values with the production lookup helper, a server-only module.
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { resolveComparisonCatalogues, ProgressPersistenceError } = await import("../lib/comparison-catalogue-resolver");
const { ProviderHttpError } = await import("../lib/provider-client");
hook.deregister();

const NOW = "2026-06-01T12:00:00.000Z";
const DAY = 86400_000;
const before = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const show = { ratingKey: "show-1", title: "Example Show" };
const TVDB_NOT_LOOKED_UP = "Not looked up: the TMDB catalogue, which names the TVDB series, could not be loaded";

/** `refreshObligation: true` is the preferred requirement, as a saved per-provider flag reads. */
type ProviderSetup = { candidates: number[]; preferredId?: number; refreshObligation?: boolean | RefreshObligation };
const obligationOf = (value: ProviderSetup["refreshObligation"]): RefreshObligation => value === true ? { preferred: true } : value || {};
/** Obligation patches: the preferred requirement added, removed, or nothing changed. */
const ADDS_PREFERRED = { add: { preferred: true } }, SATISFIES_PREFERRED = { remove: { preferred: true } }, UNCHANGED = {};
function request(tmdb: ProviderSetup, tvdb: ProviderSetup) {
  const provider = (setup: ProviderSetup, kind: "TMDB show" | "TVDB series") => ({
    candidates: setup.candidates, preferredId: setup.preferredId, refreshObligation: obligationOf(setup.refreshObligation),
    lookupSource: setup.preferredId ? [{ provider: "Plex" as const, kind, id: setup.preferredId }] : [],
  });
  return { context: { kind: "live-scan" as const }, show, resolvedAt: NOW, tmdb: provider(tmdb, "TMDB show"), tvdb: provider(tvdb, "TVDB series") };
}

test("a preferred catalogue that loads is compared, with no catalogue Coverage Issue", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: { 1: before(DAY), 3: before(DAY) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [11, 10], preferredId: 11 }, { candidates: [3, 1], preferredId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(resolved.tmdb.catalogue, { id: 11, origin: "reused", downloadedAt: before(DAY), catalogue: { provider: "tmdb", id: 11, downloadedAt: before(DAY) } });
  assert.equal(resolved.tmdb.identity, 11);
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 11, state: "preferred", preferredDownloadedAt: before(DAY), preferredUsableUntil: new Date(Date.parse(before(DAY)) + 60 * DAY).toISOString(), usingDownloadedAt: before(DAY) } });
  assert.deepEqual(resolved.tmdb.issues, [{ action: "resolve", id: "catalogue-refresh:TMDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" }]);
  assert.equal(resolved.tvdb.catalogue?.id, 1);
  assert.deepEqual(resolved.tvdb.issues, [{ action: "resolve", id: "catalogue-refresh:TVDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TVDB:show-1" }]);
});

const usableUntil = (downloadedAt: string) => new Date(Date.parse(downloadedAt) + 60 * DAY).toISOString();
const notFound = (id: number) => ({ error: new ProviderHttpError("TMDB", 404, { provider: "TMDB", kind: "show", id }) });
const tvdbOnly = { candidates: [1, 3], preferredId: 1 };
const tvdbSaved = { 1: before(DAY), 3: before(DAY) };
/** A cached recheck, or a series not yet resolvable, keeps both catalogue issues as they are. */
const preserved = (provider: "tmdb" | "tvdb") => {
  const name = provider.toUpperCase();
  return [{ action: "preserve", id: `catalogue-refresh:${name}:show-1` }, { action: "preserve", id: `catalogue-fallback-refresh:${name}:show-1` }];
};

for (const [label, age, expected] of [
  ["one millisecond under 60 days", 60 * DAY - 1, "saved-unavailable"],
  ["exactly 60 days", 60 * DAY, "saved-unavailable"],
  ["one millisecond over 60 days", 60 * DAY + 1, "fallback"],
] as const) {
  test(`a preferred catalogue that cannot load and whose saved copy is ${label} old: ${expected}`, async () => {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(age), 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
    const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

    assert.equal(resolved.outcome, "comparable");
    if (expected === "saved-unavailable") {
      assert.deepEqual(resolved.tmdb.catalogue, { id: 11, origin: "saved", downloadedAt: before(age), catalogue: { provider: "tmdb", id: 11, downloadedAt: before(age) } });
      assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 11, state: "saved-unavailable", preferredDownloadedAt: before(age), preferredUsableUntil: usableUntil(before(age)), preferredFailedAt: NOW, usingDownloadedAt: before(age) } });
    } else {
      assert.equal(resolved.tmdb.catalogue?.id, 10);
      assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 10, state: "fallback", preferredDownloadedAt: before(age), preferredUsableUntil: usableUntil(before(age)), preferredFailedAt: NOW, usingDownloadedAt: before(DAY) } });
    }
    assert.equal(resolved.tmdb.identity, expected === "fallback" ? 10 : 11);
  });
}

test("an unloadable preferred catalogue is a catalogue-refresh Coverage Issue with the scan's existing identity, failure time, provenance and impact", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.deepEqual(resolved.tmdb.issues, [
    { action: "set", issue: {
      id: "catalogue-refresh:TMDB:show-1", failedAt: NOW, operation: "catalogue-refresh", provider: "TMDB", scope: "show",
      show: { ratingKey: "show-1", title: "Example Show", tmdbId: 11, tvdbId: 1 },
      // The age of the catalogue in use, fallback 10; the preferred series is listed with its own.
      catalogueRefresh: { checkedAt: NOW, downloadedAt: before(DAY) },
      category: "Provider Lookup",
      lookup: { source: [{ provider: "Plex", kind: "TMDB show", id: 11 }], requested: { provider: "TMDB", kind: "show", id: 11 }, impact: "Preferred: 11 · Currently using: 10 · 11 unavailable; no saved catalogue. TMDB series 11 is retried every scan; the preference is kept.", status: 404, failureKind: "http" },
      cause: "404 — record not found", action: "Check the Plex provider ID reference; retry after checking or correcting the reference.",
      candidates: [{ id: 11, cause: "404 — record not found", catalogueRefresh: { checkedAt: NOW } }],
    } },
    { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" },
  ]);
  assert.equal(resolved.tmdb.warning, undefined, "a compared fallback raises no warning");
});

test("fallback candidates are tried in numeric order, and a fallback compared from its saved copy is listed in the provider's one Coverage Issue", async () => {
  const { source, requests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 20: before(30 * DAY) }, tvdb: tvdbSaved },
    failing: { tmdb: { 100: notFound(100), 3: notFound(3), 20: notFound(20) } },
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [100, 20, 3], preferredId: 100 }, tvdbOnly), { source });

  assert.deepEqual(requests.filter(r => r.provider === "tmdb").map(r => r.id), [100, 3, 20]);
  assert.deepEqual(resolved.tmdb.catalogue, { id: 20, origin: "saved", downloadedAt: before(30 * DAY), catalogue: { provider: "tmdb", id: 20, downloadedAt: before(30 * DAY) } });
  const use = { preferredId: 100, usingId: 20, state: "fallback", preferredFailedAt: NOW, usingDownloadedAt: before(30 * DAY), usingFailedAt: NOW };
  assert.deepEqual(resolved.tmdb.use, { action: "set", use });
  // One entry per failing provider (ADR-0006): the fallback's own failure is a listed candidate, not a second entry.
  assert.deepEqual(resolved.tmdb.issues, [{ action: "set", issue: {
    id: "catalogue-refresh:TMDB:show-1", failedAt: NOW, operation: "catalogue-refresh", provider: "TMDB", scope: "show",
    show: { ratingKey: "show-1", title: "Example Show", tmdbId: 100, tvdbId: 1 },
    // The age of the catalogue in use: 20's saved copy.
    catalogueRefresh: { checkedAt: NOW, downloadedAt: before(30 * DAY) },
    category: "Provider Lookup",
    lookup: { source: [{ provider: "Plex", kind: "TMDB show", id: 100 }], requested: { provider: "TMDB", kind: "show", id: 100 }, impact: `Preferred: 100 · Currently using: 20 · 100 unavailable; no saved catalogue · 20 could not be refreshed either; its saved catalogue, downloaded ${before(30 * DAY).slice(0, 10)}, is in use. TMDB series 100 is retried every scan; the preference is kept.`, status: 404, failureKind: "http" },
    cause: "404 — record not found", action: "Check the Plex provider ID reference; retry after checking or correcting the reference.",
    candidates: [{ id: 100, cause: "404 — record not found", catalogueRefresh: { checkedAt: NOW } }, { id: 3, cause: "404 — record not found", catalogueRefresh: { checkedAt: NOW } }, { id: 20, cause: "404 — record not found", catalogueRefresh: { checkedAt: NOW, downloadedAt: before(30 * DAY) } }],
  } }, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" }]);
});

test("a series-request 404 puts the series' counted 404 days and catalogue age on its catalogue-refresh issue; other failures put the age only", async () => {
  const seriesNotFound = { ...notFound(11), kind: "series-not-found" as const, seriesNotFoundDays: 7 };
  for (const [failure, expected] of [
    [seriesNotFound, { checkedAt: NOW, downloadedAt: before(74 * DAY), seriesNotFoundDays: 7 }],
    [{ error: new ProviderHttpError("TMDB", 503, { provider: "TMDB", kind: "show", id: 11 }) }, { checkedAt: NOW, downloadedAt: before(74 * DAY) }],
  ] as const) {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(74 * DAY) }, tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: failure } } });
    const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11 }, { candidates: [1], preferredId: 1 }), { source });
    const set = resolved.tmdb.issues.find(action => action.action === "set");
    assert.deepEqual(set?.action === "set" && set.issue.catalogueRefresh, expected);
  }
  // Several candidates: the entry shows the age of the catalogue in use, the fallback 10; the preferred
  // series, never downloaded, is listed with its own counted days.
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: { ...seriesNotFound, seriesNotFoundDays: 3 } } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });
  const set = resolved.tmdb.issues.find(action => action.action === "set");
  assert.deepEqual(set?.action === "set" && set.issue.catalogueRefresh, { checkedAt: NOW, downloadedAt: before(DAY) });
  assert.deepEqual(set?.action === "set" && set.issue.candidates, [{ id: 11, cause: "404 — record not found", catalogueRefresh: { checkedAt: NOW, seriesNotFoundDays: 3 } }]);
});

test("no candidate with a usable catalogue leaves the provider unavailable, and the show is compared with the other provider", async () => {
  // Changed (SHELFCHECK-120): 10's catalogue over 60 days old is now compared as the last resort unless 10 is gone.
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 10: notFound(10), 11: notFound(11) } }, seriesNotFoundDays: { tmdb: { 10: 15 } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.showStatus, "partially-matched");
  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.equal(resolved.tmdb.identity, 11);
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, state: "unavailable", preferredFailedAt: NOW } });
  assert.equal(resolved.tmdb.unavailableCause, "catalogue-refresh:TMDB:show-1");
  assert.equal(resolved.tmdb.warning, "TMDB request failed (404).");
  assert.equal(resolved.tvdb.catalogue?.id, 1, "the other provider is still resolved");
});

for (const [label, age, origin] of [
  ["one millisecond under 20 days", 20 * DAY - 1, "reused"],
  ["exactly 20 days", 20 * DAY, "reused"],
  ["one millisecond over 20 days", 20 * DAY + 1, "downloaded"],
] as const) {
  test(`a catalogue in use ${label} old is ${origin}, under the production reuse policy`, async () => {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(age), 11: before(DAY) }, tvdb: tvdbSaved } });
    const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 10 }, tvdbOnly), { source });

    assert.equal(resolved.tmdb.catalogue?.origin, origin);
    // Reuse keeps the original download time; only a download renews it.
    assert.equal(resolved.tmdb.catalogue?.downloadedAt, origin === "reused" ? before(age) : NOW);
    assert.equal(resolved.tmdb.use.action === "set" && resolved.tmdb.use.use.usingDownloadedAt, origin === "reused" ? before(age) : NOW);
  });
}

test("every candidate load asks for the 20-day refresh, and the preferred requirement makes only the preferred catalogue mandatory", async () => {
  for (const refreshObligation of [false, true]) {
    const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
    await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation }, tvdbOnly), { source });
    assert.deepEqual(requests.filter(r => r.provider === "tmdb"), [
      { provider: "tmdb", id: 11, mandatory: refreshObligation, refreshAfter: 20 * DAY },
      { provider: "tmdb", id: 10, mandatory: false, refreshAfter: 20 * DAY },
    ]);
  }
});

test("a failed early refresh keeps comparing the preferred catalogue's saved copy", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(25 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.deepEqual(resolved.tmdb.catalogue, { id: 11, origin: "saved", downloadedAt: before(25 * DAY), catalogue: { provider: "tmdb", id: 11, downloadedAt: before(25 * DAY) } });
  assert.equal(resolved.tmdb.use.action === "set" && resolved.tmdb.use.use.state, "saved-unavailable");
  assert.equal(resolved.tmdb.issues[0].action, "set");
});

test("a failure caused by provider authentication names that cause, and the other provider's identity is the one resolved", async () => {
  const authentication = new Error("TVDB authentication failed.");
  const { source } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: { 3: before(DAY) } },
    failing: { tmdb: { 11: notFound(11) }, tvdb: { 1: { error: authentication, causedBy: ["provider-authentication:TVDB"] } } },
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, { candidates: [1, 3], preferredId: 1 }), { source });

  const issue = resolved.tvdb.issues[0];
  assert.equal(issue.action, "set");
  if (issue.action !== "set") return;
  assert.deepEqual(issue.issue.causedBy, ["provider-authentication:TVDB"]);
  assert.deepEqual(issue.issue.show, { ratingKey: "show-1", title: "Example Show", tvdbId: 1, tmdbId: 11 });
  assert.deepEqual(issue.issue.lookup?.requested, { provider: "TVDB", kind: "series", id: 1 });
  assert.equal(resolved.tvdb.catalogue?.id, 3);
});

test("a preferred failure sets the refresh obligation only after candidate choice, so the first fallback reuses its recent saved copy", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.deepEqual(requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, false], [10, false]]);
  assert.equal(resolved.tmdb.catalogue?.origin, "reused");
  assert.deepEqual(resolved.tmdb.obligation, ADDS_PREFERRED);
  assert.deepEqual(resolved.tvdb.obligation, UNCHANGED);
});

test("the preferred requirement forces only the preferred catalogue, and only its complete successful download satisfies it", async () => {
  const preferredDownloads = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved } });
  const cleared = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: preferredDownloads.source });
  assert.equal(cleared.tmdb.catalogue?.origin, "downloaded");
  assert.deepEqual(cleared.tmdb.obligation, SATISFIES_PREFERRED);

  const fallbackDownloads = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const kept = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: fallbackDownloads.source });
  assert.deepEqual(fallbackDownloads.requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, true]]);
  assert.equal(kept.tmdb.catalogue?.id, 11, "the preferred saved copy is still within 60 days");
  assert.deepEqual(kept.tmdb.obligation, UNCHANGED);

  const youngFallback = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const reused = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: youngFallback.source });
  assert.deepEqual(youngFallback.requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, true], [10, false]]);
  assert.deepEqual([reused.tmdb.catalogue?.id, reused.tmdb.catalogue?.origin], [10, "reused"], "a young fallback is not downloaded again");
  assert.deepEqual(reused.tmdb.obligation, UNCHANGED, "the preferred requirement stays open");

  const oldFallback = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(21 * DAY), 11: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const fallback = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: oldFallback.source });
  assert.deepEqual([fallback.tmdb.catalogue?.id, fallback.tmdb.catalogue?.origin], [10, "downloaded"], "a fallback older than 20 days is downloaded");
  assert.deepEqual(fallback.tmdb.obligation, UNCHANGED, "a fallback download does not satisfy the preferred requirement");
});

/** Preferred B (11) has no usable copy and fails; fallback A (10) is the catalogue in use, its download decided by the production reuse policy. */
async function fallbackUnderPreferredRequirement(options: { savedAt?: string; changed?: boolean; targeted?: boolean }) {
  const { source, requests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: options.savedAt ? { 10: options.savedAt } : {}, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } },
    ...(options.changed ? { changed: { tmdb: [10] } } : {}), ...(options.targeted ? { targeted: true } : {}),
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source });
  assert.equal(resolved.tmdb.catalogue?.id, 10);
  assert.deepEqual(requests.filter(r => r.provider === "tmdb" && r.id === 10).map(r => r.mandatory), [false], "the preferred requirement never forces the fallback");
  assert.deepEqual(resolved.tmdb.obligation, UNCHANGED, "the fallback satisfies nothing, downloaded or not");
  return resolved.tmdb.catalogue?.origin;
}

for (const [label, age, origin] of [
  ["one millisecond under 20 days", 20 * DAY - 1, "reused"],
  ["exactly 20 days", 20 * DAY, "reused"],
  ["one millisecond over 20 days", 20 * DAY + 1, "downloaded"],
] as const) {
  test(`with the preferred requirement open, a fallback ${label} old is ${origin} under the production reuse policy`, async () => {
    assert.equal(await fallbackUnderPreferredRequirement({ savedAt: before(age) }), origin);
  });
}

test("with the preferred requirement open, a fallback flagged changed keeps today's freshness rules, including TMDB's same-day reuse", async () => {
  assert.equal(await fallbackUnderPreferredRequirement({ savedAt: before(60_000), changed: true }), "reused", "downloaded earlier the same UTC day");
  assert.equal(await fallbackUnderPreferredRequirement({ savedAt: before(DAY), changed: true }), "downloaded", "downloaded on an earlier UTC day");
});

test("with the preferred requirement open, a fallback with no saved copy is downloaded, and a targeted scan downloads a young one", async () => {
  assert.equal(await fallbackUnderPreferredRequirement({}), "downloaded");
  assert.equal(await fallbackUnderPreferredRequirement({ savedAt: before(DAY), targeted: true }), "downloaded");
});

test("a preferred failure adds the preferred requirement and its download removes only that, keeping every other part of the obligation", async () => {
  const others: RefreshObligation = { specificIds: [99] };
  const failing = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const failed = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: others }, tvdbOnly), { source: failing.source });
  assert.deepEqual(failed.tmdb.obligation, ADDS_PREFERRED);
  assert.deepEqual(applyObligationPatch(others, failed.tmdb.obligation), { preferred: true, specificIds: [99] });

  const loading = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved } });
  const loaded = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: { ...others, preferred: true } }, tvdbOnly), { source: loading.source });
  assert.equal(loaded.tmdb.catalogue?.origin, "downloaded");
  assert.deepEqual(loaded.tmdb.obligation, SATISFIES_PREFERRED);
  assert.deepEqual(applyObligationPatch({ ...others, preferred: true }, loaded.tmdb.obligation), others);
});

test("a reused preferred catalogue never clears a refresh obligation", async () => {
  const { source: reusing } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved } });
  // A source whose own freshness policy reuses the preferred catalogue despite the mandatory setting.
  const source = { ...reusing, async loadCatalogue(provider: "tmdb" | "tvdb", id: number) { const saved = reusing.savedCatalogue(provider, id)!; return { outcome: "reused" as const, ...saved }; } };
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: source as typeof reusing });
  assert.equal(resolved.tmdb.catalogue?.origin, "reused");
  assert.deepEqual(resolved.tmdb.obligation, UNCHANGED);
});

test("a specific requirement forces its own catalogue, preferred work coexisting, and its complete successful download satisfies only that ID", async () => {
  // Preferred B (11) is unavailable; fallback A (10) was downloaded earlier the same UTC day.
  const both: RefreshObligation = { preferred: true, specificIds: [10] };
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(60_000), 11: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: both }, tvdbOnly), { source });
  assert.deepEqual(requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, true], [10, true]]);
  assert.deepEqual([resolved.tmdb.catalogue?.id, resolved.tmdb.catalogue?.origin], [10, "downloaded"]);
  assert.deepEqual(resolved.tmdb.obligation, { remove: { specificIds: [10] } });
  assert.deepEqual(applyObligationPatch(both, resolved.tmdb.obligation), { preferred: true }, "the preferred requirement stays open");
});

test("a specific requirement for another catalogue forces nothing, and its target's failed download satisfies nothing", async () => {
  const other = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved } });
  const untargeted = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: { specificIds: [99] } }, tvdbOnly), { source: other.source });
  assert.deepEqual(other.requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, false]]);
  assert.equal(untargeted.tmdb.catalogue?.origin, "reused");
  assert.deepEqual(untargeted.tmdb.obligation, UNCHANGED, "reuse satisfies nothing");

  const failing = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(60_000), 11: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 10: notFound(10), 11: notFound(11) } } });
  const failed = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: { specificIds: [10] } }, tvdbOnly), { source: failing.source });
  assert.deepEqual(failing.requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, false], [10, true]]);
  assert.deepEqual(applyObligationPatch({ specificIds: [10] }, failed.tmdb.obligation), { preferred: true, specificIds: [10] }, "the failed target keeps its requirement");
});

test("one complete successful download of a catalogue both preferred and targeted satisfies both requirements", async () => {
  const both: RefreshObligation = { preferred: true, specificIds: [11] };
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(60_000) }, tvdb: tvdbSaved } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: both }, tvdbOnly), { source });
  assert.deepEqual(requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, true]]);
  assert.deepEqual(resolved.tmdb.obligation, { remove: { preferred: true, specificIds: [11] } });
  assert.deepEqual(applyObligationPatch(both, resolved.tmdb.obligation), {});
});

test("a specific requirement forces a single Plex ID's or derived series' download, and only that download satisfies it", async () => {
  const single = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(60_000) }, tvdb: { 1: before(DAY) } } });
  const loaded = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11, refreshObligation: { specificIds: [11] } }, { candidates: [1], preferredId: 1, refreshObligation: { specificIds: [9] } }), { source: single.source });
  assert.deepEqual(single.requests.map(r => [r.provider, r.id, r.mandatory]), [["tmdb", 11, true], ["tvdb", 1, false]]);
  assert.deepEqual(loaded.tmdb.obligation, { remove: { specificIds: [11] } });
  assert.deepEqual(loaded.tvdb.obligation, UNCHANGED, "a requirement for another series is not satisfied by reuse");

  const derived = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved, tvdb: { 7: before(60_000) } }, tvdbOfTmdb: { 11: 7 } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, { candidates: [], refreshObligation: { specificIds: [7] } }), { source: derived.source });
  assert.equal(resolved.tvdb.catalogue?.origin, "downloaded");
  assert.deepEqual(resolved.tvdb.obligation, { remove: { specificIds: [7] } });
});

test("a specific requirement names the catalogue a provider reports, even when it answers a requested series as another", async () => {
  // TMDB answers series 11 as series 21: the comparison, the change feed and the safeguard name 21.
  const single = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(60_000) }, tvdb: tvdbSaved }, reports: { tmdb: { 11: 21 } } });
  const loaded = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11, refreshObligation: { specificIds: [21] } }, tvdbOnly), { source: single.source });
  assert.deepEqual(single.requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, true]], "the saved copy of 11 reports 21, so the requirement forces it");
  assert.deepEqual([loaded.tmdb.identity, loaded.tmdb.catalogue?.origin], [21, "downloaded"]);
  assert.deepEqual(loaded.tmdb.obligation, { remove: { specificIds: [21] } }, "the download satisfies the requirement it was forced by");

  // A preferred catalogue answered as another series is still the preferred catalogue.
  const several = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved }, reports: { tmdb: { 11: 21 } } });
  const preferred = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: { preferred: true, everyAttempted: true } }, tvdbOnly), { source: several.source });
  assert.deepEqual([preferred.tmdb.identity, preferred.tmdb.catalogue?.origin], [21, "downloaded"]);
  assert.deepEqual(preferred.tmdb.obligation, { remove: { preferred: true, everyAttempted: true } });
});

test("a specific requirement for a catalogue not compared is on hold: it forces nothing and reports nothing, and applies when that catalogue is compared again", async () => {
  // A reported fallback (10) on hold while preferred B (11) loads.
  const reported = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(60_000), 11: before(DAY) }, tvdb: tvdbSaved } });
  const held = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: { specificIds: [10] } }, tvdbOnly), { source: reported.source });
  assert.deepEqual(reported.requests.map(r => [r.provider, r.id, r.mandatory]), [["tmdb", 11, false], ["tvdb", 1, false]], "neither B nor the other provider is forced");
  assert.equal(held.outcome, "comparable");
  assert.deepEqual([held.tmdb.obligation, held.tvdb.obligation, held.warnings], [UNCHANGED, UNCHANGED, []]);
  assert.ok(held.tmdb.issues.every(issue => issue.action === "resolve"), "no active failure");

  // A derived TMDB series (50) on hold while TVDB 2's association names 60, applied when 50 is derived again.
  const derived = () => inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 50: before(60_000), 60: before(60_000) }, tvdb: { 1: before(DAY), 2: before(DAY) } }, savedAssociations: { 1: 50, 2: 60 },
  }).source;
  const elsewhere = await resolveComparisonCatalogues(request({ candidates: [], refreshObligation: { specificIds: [50] } }, { candidates: [2], preferredId: 2 }), { source: derived() });
  assert.deepEqual([elsewhere.tmdb.identity, elsewhere.tmdb.catalogue?.origin, elsewhere.tmdb.obligation, elsewhere.warnings], [60, "reused", UNCHANGED, []]);
  const back = await resolveComparisonCatalogues(request({ candidates: [], refreshObligation: { specificIds: [50] } }, { candidates: [1], preferredId: 1 }), { source: derived() });
  assert.deepEqual([back.tmdb.identity, back.tmdb.catalogue?.origin, back.tmdb.obligation], [50, "downloaded", { remove: { specificIds: [50] } }], "derived again, its same-day saved copy is downloaded");
});


test("each provider's obligation change is acknowledged by the progress sink before the other provider's work starts", async () => {
  const { source: inner } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const events: string[] = [];
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
  const source: typeof inner = { ...inner, loadCatalogue: async (provider, id, settings) => { events.push(`load ${provider} ${id}`); return inner.loadCatalogue(provider, id, settings); } };
  const resolving = resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), {
    source,
    onProviderResolved: async ({ provider, obligation }) => {
      events.push(`patch ${provider} ${JSON.stringify(obligation)}`);
      if (provider === "tmdb") await acknowledged;
      events.push(`acknowledged ${provider}`);
    },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ["load tmdb 11", "load tmdb 10", 'patch tmdb {"add":{"preferred":true}}'], "TVDB waits for the TMDB patch to be acknowledged");

  acknowledge();
  const resolved = await resolving;
  assert.deepEqual(events, ["load tmdb 11", "load tmdb 10", 'patch tmdb {"add":{"preferred":true}}', "acknowledged tmdb", "load tvdb 1", "patch tvdb {}", "acknowledged tvdb"]);
  assert.deepEqual(resolved.tmdb.obligation, ADDS_PREFERRED);
});

test("a rejecting progress sink fails the resolution as a persistence failure, not a provider failure", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved } });
  const persistence = new Error("database is locked");
  await assert.rejects(
    resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source, onProviderResolved: async () => { throw persistence; } }),
    error => error instanceof ProgressPersistenceError && error.cause === persistence && error.provider === "tmdb",
  );
  assert.deepEqual(requests.map(r => [r.provider, r.id]), [["tmdb", 11]], "no other candidate is tried and TVDB's work never starts");
});

test("a provider with no usable catalogue leaves acknowledged obligation changes as they were sent, once each", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 10: notFound(10), 11: notFound(11) } } });
  const patches: unknown[] = [];
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source, onProviderResolved: async ({ provider, obligation }) => { patches.push({ provider, obligation }); } });

  assert.equal(resolved.outcome, "comparable", "TVDB is still compared (ADR-0006)");
  assert.deepEqual(patches, [{ provider: "tmdb", obligation: ADDS_PREFERRED }, { provider: "tvdb", obligation: UNCHANGED }]);
  assert.deepEqual([resolved.tmdb.obligation, resolved.tvdb.obligation], [ADDS_PREFERRED, UNCHANGED]);
});

const noTvdb = { candidates: [] };
const noTmdb = { candidates: [] };

test("a show with no Plex TVDB ID compares the TVDB series named by the TMDB catalogue in use", async () => {
  const { source, requests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(70 * DAY) }, tvdb: { 7: before(DAY) } },
    failing: { tmdb: { 11: notFound(11) } }, tvdbOfTmdb: { 10: 7, 11: 8 },
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, noTvdb), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.catalogue?.id, 10, "the TMDB fallback is the catalogue in use");
  assert.equal(resolved.tvdb.identity, 7);
  assert.deepEqual(resolved.tvdb.catalogue, { id: 7, origin: "reused", downloadedAt: before(DAY), catalogue: { provider: "tvdb", id: 7, downloadedAt: before(DAY) } });
  assert.deepEqual(resolved.tvdb.use, { action: "set", use: { usingId: 7, state: "derived", derivedFrom: 10, usingDownloadedAt: before(DAY) } });
  assert.deepEqual(resolved.tvdb.issues, [{ action: "resolve", id: "catalogue-refresh:TVDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TVDB:show-1" }]);
  assert.deepEqual(requests.filter(r => r.provider === "tvdb"), [{ provider: "tvdb", id: 7, mandatory: false }], "a derived series loads under the single-catalogue reuse policy");
});

const tmdbSaved = { 10: before(DAY), 11: before(DAY) };

test("a show with no Plex TMDB ID chooses its TVDB catalogue first, fallback included, and compares the TMDB series TMDB associates with it", async () => {
  const { source, requests, associationRequests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: { 1: before(61 * DAY), 3: before(DAY) } },
    failing: { tvdb: { 1: notFound(1) } }, associations: { 1: { outcome: "found", id: 40, cached: false }, 3: { outcome: "found", id: 50, cached: false } },
  });
  const resolved = await resolveComparisonCatalogues(request(noTmdb, { candidates: [1, 3], preferredId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(requests.map(r => [r.provider, r.id]), [["tvdb", 1], ["tvdb", 3], ["tmdb", 50]]);
  assert.deepEqual(associationRequests, [{ tvdbId: 3, mandatory: false }], "derived from the TVDB fallback compared, never the unavailable preference");
  assert.equal(resolved.tvdb.catalogue?.id, 3);
  assert.equal(resolved.tmdb.identity, 50);
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { usingId: 50, state: "derived", derivedFrom: 3, usingDownloadedAt: before(DAY) } });
  assert.deepEqual(resolved.tmdb.issues, [{ action: "resolve", id: "catalogue-refresh:TMDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" }]);
});

test("a Plex-reported ID always beats a derived one", async () => {
  const { source, requests, associationRequests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: tmdbSaved, tvdb: tvdbSaved }, tvdbOfTmdb: { 11: 99 }, associations: { 1: { outcome: "found", id: 77, cached: false } },
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.deepEqual([resolved.tmdb.identity, resolved.tvdb.identity], [11, 1]);
  assert.equal(resolved.tvdb.use.action === "set" && resolved.tvdb.use.use.state, "preferred");
  assert.deepEqual(associationRequests, []);
  assert.ok(!requests.some(r => r.id === 99 || r.id === 77));
});

// Changed (ADR-0006): a provider with no Plex ID and none found through the other provider is a
// Total Provider Lookup Failure for a missing ID, with no catalogue, instead of having no series to look up.
const missingTvdbIssue = {
  id: "catalogue-refresh:TVDB:show-1", operation: "catalogue-refresh", provider: "TVDB", scope: "show",
  show: { ...show, tmdbId: 11, tvdbId: undefined }, category: "Provider Lookup",
  lookup: { source: [{ provider: "Plex", kind: "TMDB show", id: 11 }], failureKind: "missing-id", impact: "TVDB episode coverage could not be verified: no TVDB series ID was found for this show. It is compared with the catalogues that remain usable." },
  cause: "No TVDB series ID from Plex or TMDB",
  action: "Fix the show's Plex match so Plex reports a TVDB ID, or add the TVDB ID to its TMDB record, then run a Plex scan.",
};

test("a TMDB catalogue that names no TVDB series leaves TVDB without a series: a Total Provider Lookup Failure for a missing ID", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, noTvdb), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.showStatus, "partially-matched");
  assert.equal(resolved.tvdb.identity, undefined);
  assert.deepEqual(resolved.tvdb.status, { state: "total-failure", catalogue: "none", cause: "No TVDB series ID from Plex or TMDB" });
  assert.deepEqual(resolved.tvdb.use, { action: "clear" });
  assert.deepEqual(resolved.tvdb.obligation, UNCHANGED);
  assert.deepEqual(resolved.tvdb.issues, [{ action: "set", issue: missingTvdbIssue }, { action: "resolve", id: "catalogue-fallback-refresh:TVDB:show-1" }]);
  assert.equal(resolved.tvdb.unavailableCause, "catalogue-refresh:TVDB:show-1");
  assert.deepEqual(resolved.warnings, [], "a missing ID adds no result warning, so the comparison stays complete");
  assert.ok(!requests.some(r => r.provider === "tvdb"));
});

test("a known-empty association is a Total Provider Lookup Failure for a missing TMDB ID, while one missing even when requested leaves the comparison pending", async () => {
  const empty = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: tvdbSaved }, associations: { 1: { outcome: "known-empty" } } });
  const none = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source: empty.source });
  assert.equal(none.outcome, "comparable", "TVDB alone is compared");
  assert.equal(none.showStatus, "partially-matched");
  assert.equal(none.tmdb.identity, undefined);
  assert.deepEqual(none.tmdb.status, { state: "total-failure", catalogue: "none", cause: "No TMDB series ID from Plex or TVDB" });
  assert.deepEqual(none.tmdb.use, { action: "clear" });
  assert.deepEqual(none.tmdb.obligation, UNCHANGED);
  const [refresh, fallback] = none.tmdb.issues;
  assert.equal(refresh.action === "set" && refresh.issue.id, "catalogue-refresh:TMDB:show-1");
  assert.deepEqual(refresh.action === "set" && refresh.issue.lookup?.requested, { provider: "TMDB", kind: "TVDB ID search", id: 1 }, "the search that found nothing is named");
  assert.deepEqual(fallback, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" });
  assert.deepEqual(none.warnings, []);
  assert.ok(!empty.requests.some(r => r.provider === "tmdb"));

  const missing = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: tvdbSaved } });
  const pending = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source: missing.source });
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.tmdb.identity, undefined);
  assert.deepEqual(pending.tmdb.use, { action: "unchanged" });
  assert.deepEqual(pending.tmdb.issues, preserved("tmdb"));
  assert.deepEqual(pending.tmdb.obligation, UNCHANGED);
  assert.equal(pending.tmdb.warning, "TMDB's association for TVDB series 1 is not saved, so its TMDB series could not be resolved from saved inputs. Last-good results were kept until the next Plex scan.");
});

test("a failed association is a catalogue-refresh Coverage Issue, and the TMDB series last compared for that TVDB series is kept", async () => {
  const error = new ProviderHttpError("TMDB", 503, { provider: "TMDB", kind: "TVDB ID search", id: 1 });
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 40: before(90 * DAY) }, tvdb: tvdbSaved }, associations: { 1: { outcome: "failed", error } } });
  const resolved = await resolveComparisonCatalogues({ ...request(noTmdb, tvdbOnly), previousComparison: { tmdbId: 40, tvdbId: 1, complete: true } }, { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(resolved.tmdb.catalogue, { id: 40, origin: "saved", downloadedAt: before(90 * DAY), catalogue: { provider: "tmdb", id: 40, downloadedAt: before(90 * DAY) } });
  assert.equal(resolved.tmdb.identity, 40);
  assert.deepEqual(resolved.tmdb.use, { action: "clear" });
  assert.deepEqual(resolved.tmdb.obligation, ADDS_PREFERRED);
  assert.equal(resolved.tmdb.warning, "TMDB request failed (503).");
  const issue = resolved.tmdb.issues[0];
  assert.equal(issue.action, "set");
  if (issue.action !== "set") return;
  assert.equal(issue.issue.id, "catalogue-refresh:TMDB:show-1");
  assert.deepEqual(issue.issue.show, { ratingKey: "show-1", title: "Example Show", tmdbId: undefined, tvdbId: 1 });
  assert.deepEqual(issue.issue.lookup?.source, [{ provider: "Plex", kind: "TVDB series", id: 1 }]);
  assert.deepEqual(issue.issue.lookup?.requested, { provider: "TMDB", kind: "TVDB ID search", id: 1 });
  assert.equal(issue.issue.lookup?.impact, "TMDB episode coverage could not be fully verified. Last-good catalogue data was retained. Last-good comparison results remain available.");
  assert.deepEqual(resolved.tmdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }, { provider: "TMDB", kind: "resolved show", id: 40, cached: true }], "the kept series is the one resolved before, from saved evidence");
});

// Changed (ADR-0006): an empty show for a Plex-reported (or derived) ID is treated like a 404:
// a Total Provider Lookup Failure with no catalogue, and the show is compared with the other provider.
// It is not a series-request 404, so it never counts toward the series' 404 days.
test("a single Plex ID the provider answers with no series for is a Total Provider Lookup Failure with no catalogue: the show is compared with the other provider", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY) }, tvdb: tvdbSaved }, noSeries: { tmdb: [11] } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11, refreshObligation: true }, { candidates: [1], preferredId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.showStatus, "partially-matched");
  assert.equal(resolved.tmdb.identity, 11);
  assert.equal(resolved.tmdb.catalogue, undefined, "the saved copy is not compared");
  assert.deepEqual(resolved.tmdb.status, { state: "total-failure", catalogue: "none", cause: "TMDB returned an incomplete or unreadable response" });
  assert.equal(resolved.tvdb.catalogue?.id, 1);
  assert.deepEqual(resolved.tmdb.lookupSource, [{ provider: "Plex", kind: "TMDB show", id: 11 }]);
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, state: "unavailable", preferredFailedAt: NOW } });
  assert.deepEqual(resolved.tmdb.obligation, UNCHANGED, "the open requirement stays open, as after any failed download");
  const [refresh, fallback] = resolved.tmdb.issues;
  assert.equal(refresh.action === "set" && refresh.issue.id, "catalogue-refresh:TMDB:show-1");
  assert.deepEqual(refresh.action === "set" && refresh.issue.catalogueRefresh, { checkedAt: NOW, downloadedAt: before(DAY) }, "an empty show is not a counted 404");
  assert.deepEqual(fallback, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" });
  assert.deepEqual([resolved.unavailableCauses, resolved.warnings], [["catalogue-refresh:TMDB:show-1"], ["TMDB returned no show 11."]]);
});

test("a derived TMDB series the provider answers with no series for is a Total Provider Lookup Failure with no catalogue: the series last compared is not kept", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 40: before(DAY) }, tvdb: tvdbSaved }, associations: { 1: { outcome: "found", id: 50, cached: false } }, noSeries: { tmdb: [50] } });
  const resolved = await resolveComparisonCatalogues({ ...request(noTmdb, tvdbOnly), previousComparison: { tmdbId: 40, tvdbId: 1, complete: true } }, { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.showStatus, "partially-matched");
  assert.equal(resolved.tmdb.identity, 50);
  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.equal(resolved.tmdb.status.state === "total-failure" && resolved.tmdb.status.catalogue, "none");
  assert.deepEqual(resolved.tmdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }, { provider: "TMDB", kind: "resolved show", id: 50, cached: false }]);
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { usingId: 50, state: "derived", derivedFrom: 1 } });
  assert.deepEqual(resolved.tmdb.obligation, ADDS_PREFERRED);
  assert.equal(resolved.tmdb.issues[0].action === "set" && resolved.tmdb.issues[0].issue.id, "catalogue-refresh:TMDB:show-1");
  assert.deepEqual([resolved.unavailableCauses, resolved.warnings], [["catalogue-refresh:TMDB:show-1"], ["TMDB returned no show 50."]]);
});

test("a candidate among several that the provider answers with no series for is unavailable, as a failed load is", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, noSeries: { tmdb: [11] } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.catalogue?.id, 10);
  assert.equal((resolved.tmdb.use as { use: { state: string } }).use.state, "fallback");
  assert.deepEqual(resolved.tmdb.obligation, ADDS_PREFERRED);
  const issue = resolved.tmdb.issues[0];
  assert.equal(issue.action, "set");
  if (issue.action !== "set") return;
  assert.equal(issue.issue.id, "catalogue-refresh:TMDB:show-1");
  assert.equal(issue.issue.lookup?.failureKind, "invalid-response");

  const { source: noneLoad } = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: tvdbSaved }, noSeries: { tmdb: [10, 11] } });
  const unavailable = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source: noneLoad });
  assert.equal(unavailable.outcome, "comparable", "TVDB is still compared (ADR-0006)");
  assert.deepEqual(unavailable.warnings, ["TMDB returned no show 11."]);
});

test("a TMDB series resolved before its download fails is kept, with its provenance, in the Coverage Issue", async () => {
  for (const resolvedId of [undefined, 51]) {
    const { source } = inMemoryCatalogueSource({
      now: NOW, saved: { tvdb: tvdbSaved }, associations: { 1: { outcome: "found", id: 50, cached: true } },
      failing: { tmdb: { 50: { ...notFound(resolvedId ?? 50), ...(resolvedId ? { resolvedId } : {}) } } },
    });
    const resolved = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source });
    const id = resolvedId ?? 50;

    assert.equal(resolved.outcome, "comparable", "TVDB is still compared");
    assert.equal(resolved.tmdb.identity, id);
    assert.equal(resolved.tmdb.catalogue, undefined);
    assert.equal(resolved.tmdb.unavailableCause, "catalogue-refresh:TMDB:show-1");
    const issue = resolved.tmdb.issues[0];
    assert.equal(issue.action, "set");
    if (issue.action !== "set") return;
    assert.deepEqual(issue.issue.show, { ratingKey: "show-1", title: "Example Show", tmdbId: id, tvdbId: 1 });
    assert.deepEqual(issue.issue.lookup?.source, [{ provider: "Plex", kind: "TVDB series", id: 1 }, { provider: "TMDB", kind: "resolved show", id: 50, cached: true }]);
    assert.deepEqual(issue.issue.lookup?.requested, { provider: "TMDB", kind: "show", id });
    assert.equal(issue.issue.lookup?.impact, "TMDB episode coverage could not be fully verified. No previous catalogue data is available. No previous comparison results are available.");
  }
});

test("a derived TVDB series that cannot be loaded keeps its saved catalogue at any age, and records the derived use", async () => {
  const tvdbNotFound = { error: new ProviderHttpError("TVDB", 404, { provider: "TVDB", kind: "series", id: 7 }) };
  for (const savedAt of [before(200 * DAY), undefined]) {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved, tvdb: savedAt ? { 7: savedAt } : {} }, tvdbOfTmdb: { 11: 7 }, failing: { tvdb: { 7: tvdbNotFound } } });
    const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, { candidates: [], refreshObligation: true }), { source });

    assert.equal(resolved.tvdb.identity, 7);
    assert.deepEqual(resolved.tvdb.obligation, UNCHANGED, "an obligation already open stays open");
    assert.deepEqual(resolved.tvdb.use, { action: "set", use: { usingId: 7, state: "derived", derivedFrom: 11, ...(savedAt ? { usingDownloadedAt: savedAt } : {}) } });
    assert.equal(resolved.outcome, "comparable", "TMDB is compared whether or not TVDB keeps a saved catalogue");
    assert.equal(resolved.tvdb.catalogue?.origin, savedAt ? "saved" : undefined);
    const issue = resolved.tvdb.issues[0];
    assert.equal(issue.action, "set");
    if (issue.action !== "set") return;
    assert.deepEqual(issue.issue.show, { ratingKey: "show-1", title: "Example Show", tvdbId: 7, tmdbId: 11 });
    assert.deepEqual(issue.issue.lookup?.source, [{ provider: "Plex", kind: "TMDB show", id: 11 }, { provider: "TMDB", kind: "external TVDB ID", id: 7, cached: true }]);
    assert.equal(issue.issue.lookup?.impact, `TVDB episode coverage could not be fully verified. ${savedAt ? "Last-good catalogue data was retained." : "No previous catalogue data is available."} No previous comparison results are available.`);
  }
});

test("a derived series that fails with no obligation open sets one", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved }, tvdbOfTmdb: { 11: 7 }, failing: { tvdb: { 7: { error: new Error("TVDB is down.") } } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, noTvdb), { source });
  assert.deepEqual(resolved.tvdb.obligation, ADDS_PREFERRED);
  assert.equal(resolved.tvdb.warning, "TVDB is down.");
});

test("a downloaded derived series clears its open refresh obligation; a reused one does not", async () => {
  for (const obligation of [true, false]) {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved, tvdb: { 7: before(DAY) } }, tvdbOfTmdb: { 11: 7 } });
    // The production reuse policy reuses a young saved copy unless the obligation makes the load mandatory.
    const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, { candidates: [], refreshObligation: obligation }), { source });
    assert.equal(resolved.tvdb.catalogue?.origin, obligation ? "downloaded" : "reused");
    assert.deepEqual(resolved.tvdb.obligation, obligation ? SATISFIES_PREFERRED : UNCHANGED);
  }
});

test("in the TVDB-first case, TVDB's patch is acknowledged by the progress sink before TMDB's work starts", async () => {
  const { source: inner } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: { 3: before(DAY) } }, failing: { tvdb: { 1: notFound(1) } }, associations: { 3: { outcome: "found", id: 50, cached: false } } });
  const events: string[] = [];
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
  const source: typeof inner = {
    ...inner,
    loadCatalogue: async (provider, id, settings) => { events.push(`load ${provider} ${id}`); return inner.loadCatalogue(provider, id, settings); },
    tmdbSeriesForTvdb: async (tvdbId, settings) => { events.push(`association ${tvdbId}`); return inner.tmdbSeriesForTvdb(tvdbId, settings); },
  };
  const resolving = resolveComparisonCatalogues(request(noTmdb, tvdbOnly), {
    source,
    onProviderResolved: async ({ provider, obligation }) => {
      events.push(`patch ${provider} ${JSON.stringify(obligation)}`);
      if (provider === "tvdb") await acknowledged;
      events.push(`acknowledged ${provider}`);
    },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ["load tvdb 1", "load tvdb 3", 'patch tvdb {"add":{"preferred":true}}'], "TMDB waits for the TVDB patch to be acknowledged");

  acknowledge();
  await resolving;
  assert.deepEqual(events, ["load tvdb 1", "load tvdb 3", 'patch tvdb {"add":{"preferred":true}}', "acknowledged tvdb", "association 3", "load tmdb 50", "patch tmdb {}", "acknowledged tmdb"]);
});

test("the progress sink receives each provider's chosen catalogue before the other provider loads, so the second load can depend on it", async () => {
  const { source: inner } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const events: string[] = [];
  const source: typeof inner = { ...inner, loadCatalogue: async (provider, id, settings) => { events.push(`load ${provider} ${id}`); return inner.loadCatalogue(provider, id, settings); } };
  await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), {
    source, onProviderResolved: async ({ provider, catalogue }) => { events.push(`${provider} chose ${catalogue ? `${catalogue.id} ${catalogue.origin}` : "nothing"}`); },
  });
  assert.deepEqual(events, ["load tmdb 11", "load tmdb 10", "tmdb chose 10 reused", "load tvdb 1", "tvdb chose 1 reused"]);

  const unavailable = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: { 1: before(30 * DAY) } }, failing: { tvdb: { 1: notFound(1), 3: notFound(3) } }, associations: { 1: { outcome: "known-empty" } } });
  const chosen: unknown[] = [];
  await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source: unavailable.source, onProviderResolved: async ({ provider, catalogue }) => { chosen.push([provider, catalogue?.id, catalogue?.origin]); } });
  assert.deepEqual(chosen, [["tvdb", 1, "saved"], ["tmdb", undefined, undefined]], "TVDB first: its saved copy, then TMDB with no series");
});

test("each provider reports the provenance of its identity: Plex for a reported ID, the derivation chain for a derived one", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: { 7: before(DAY) } }, failing: { tmdb: { 11: notFound(11) } }, tvdbOfTmdb: { 10: 7 } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, noTvdb), { source });
  assert.deepEqual(resolved.tmdb.lookupSource, [{ provider: "Plex", kind: "TMDB show", id: 11 }], "a fallback keeps the provenance of the preference");
  assert.deepEqual(resolved.tvdb.lookupSource, [{ provider: "Plex", kind: "TMDB show", id: 11 }, { provider: "TMDB", kind: "external TVDB ID", id: 7, cached: true }]);

  const derivedTmdb = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: { 3: before(DAY) } }, failing: { tvdb: { 1: notFound(1) } }, associations: { 3: { outcome: "found", id: 50, cached: true } } });
  const tvdbFirst = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source: derivedTmdb.source });
  assert.deepEqual(tvdbFirst.tvdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }]);
  assert.deepEqual(tvdbFirst.tmdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 3 }, { provider: "TMDB", kind: "resolved show", id: 50, cached: true }], "derived from the TVDB fallback compared");

  const empty = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: tvdbSaved }, associations: { 1: { outcome: "known-empty" } } });
  const none = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source: empty.source });
  assert.deepEqual(none.tmdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }]);
  const noName = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved } });
  assert.deepEqual((await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, noTvdb), { source: noName.source })).tvdb.lookupSource, []);
});

test("with TVDB chosen first and unavailable, TMDB is still derived from the preferred TVDB series and the show is compared with it", async () => {
  const { source, associationRequests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: { 1: before(61 * DAY) } },
    // Changed (SHELFCHECK-120): TVDB 1 is gone, else its catalogue over 60 days old would be compared as the last resort.
    failing: { tvdb: { 1: notFound(1), 3: notFound(3) } }, associations: { 1: { outcome: "found", id: 50, cached: false } }, seriesNotFoundDays: { tvdb: { 1: 15 } },
  });
  const patches: unknown[] = [];
  const resolved = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source, onProviderResolved: async ({ provider, obligation }) => { patches.push({ provider, obligation }); } });

  assert.equal(resolved.outcome, "comparable", "TMDB is compared without TVDB");
  assert.deepEqual(associationRequests, [{ tvdbId: 1, mandatory: false }]);
  assert.deepEqual([resolved.tvdb.identity, resolved.tvdb.catalogue], [1, undefined]);
  assert.deepEqual(resolved.tvdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }]);
  assert.equal(resolved.tvdb.issues[0].action, "set");
  assert.deepEqual(resolved.tvdb.use, { action: "set", use: { preferredId: 1, state: "unavailable", preferredDownloadedAt: before(61 * DAY), preferredUsableUntil: usableUntil(before(61 * DAY)), preferredFailedAt: NOW } });
  assert.deepEqual([resolved.tmdb.identity, resolved.tmdb.catalogue?.id], [50, 50], "TMDB's independent work still happens");
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { usingId: 50, state: "derived", derivedFrom: 1, usingDownloadedAt: before(DAY) } });
  assert.deepEqual(resolved.tmdb.issues, [{ action: "resolve", id: "catalogue-refresh:TMDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" }]);
  assert.deepEqual(resolved.unavailableCauses, ["catalogue-refresh:TVDB:show-1"]);
  assert.deepEqual(patches, [{ provider: "tvdb", obligation: ADDS_PREFERRED }, { provider: "tmdb", obligation: UNCHANGED }]);
});

test("a missing catalogue lists the comparison-inputs issue's causes and the warnings in resolution order, while comparison order stays TMDB then TVDB", async () => {
  const tmdbDown = { error: new Error("TMDB is down.") };
  const { source } = inMemoryCatalogueSource({
    now: NOW, saved: { tvdb: { 3: before(DAY) } },
    failing: { tvdb: { 1: { error: new Error("TVDB is down.") } }, tmdb: { 50: tmdbDown } }, associations: { 3: { outcome: "found", id: 50, cached: false } },
  });
  const tvdbFirst = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source });
  assert.equal(tvdbFirst.outcome, "comparable", "TVDB's fallback is compared without TMDB");
  assert.deepEqual(tvdbFirst.resolutionOrder, ["tvdb", "tmdb"]);
  assert.deepEqual(tvdbFirst.unavailableCauses, ["catalogue-refresh:TMDB:show-1"], "the TVDB fallback is compared, so only TMDB is a cause");
  assert.deepEqual(tvdbFirst.warnings, ["TMDB is down."]);

  const both = inMemoryCatalogueSource({ now: NOW, failing: { tvdb: { 1: { error: new Error("TVDB is down.") }, 3: { error: new Error("TVDB is down.") } }, tmdb: { 50: tmdbDown } }, associations: { 1: { outcome: "found", id: 50, cached: false } } });
  const neither = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source: both.source });
  assert.deepEqual(neither.unavailableCauses, ["catalogue-refresh:TVDB:show-1", "catalogue-refresh:TMDB:show-1"]);
  assert.deepEqual(neither.warnings, ["TVDB is down.", "TMDB is down."]);
  assert.deepEqual(neither.resolutionOrder, ["tvdb", "tmdb"]);

  const { source: tmdbFirstSource } = inMemoryCatalogueSource({ now: NOW, failing: { tmdb: { 10: notFound(10), 11: notFound(11) }, tvdb: { 1: { error: new Error("TVDB is down.") }, 3: { error: new Error("TVDB is down.") } } } });
  const tmdbFirst = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source: tmdbFirstSource });
  assert.deepEqual(tmdbFirst.resolutionOrder, ["tmdb", "tvdb"]);
  assert.deepEqual(tmdbFirst.unavailableCauses, ["catalogue-refresh:TMDB:show-1", "catalogue-refresh:TVDB:show-1"]);
  assert.deepEqual(tmdbFirst.warnings, ["TMDB request failed (404).", "TVDB is down."]);
});

test("whatever the resolution order, the comparison runs TMDB's catalogue then TVDB's", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: tvdbSaved }, associations: { 1: { outcome: "found", id: 50, cached: false } } });
  const resolved = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source });
  assert.deepEqual(resolved.resolutionOrder, ["tvdb", "tmdb"]);
  assert.deepEqual(resolved.comparisonOrder.map(provider => resolved[provider].catalogue?.catalogue.provider), ["tmdb", "tvdb"]);
});

// A cached recheck: saved inputs only, with each provider's prior-selection history.
function cachedRequest(tmdb: ProviderSetup, tvdb: ProviderSetup, history: { tmdb?: object; tvdb?: object } = {}, previousComparison?: { tmdbId?: number; tvdbId?: number }) {
  return { ...request(tmdb, tvdb), context: { kind: "cached-recheck" as const, history: { tmdb: history.tmdb || {}, tvdb: history.tvdb || {} } }, previousComparison: { ...previousComparison, complete: true } };
}

test("a cached recheck compares an untried preference's usable saved copy, loading nothing and changing no obligation or catalogue issue", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(60 * DAY) }, tvdb: tvdbSaved } });
  const resolved = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly, { tmdb: { recordedUse: { preferredId: 10, usingId: 10, state: "preferred" } } }, { tmdbId: 10, tvdbId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(requests, [], "a cached recheck never loads a catalogue");
  assert.deepEqual(resolved.tmdb.catalogue, { id: 11, origin: "reused", downloadedAt: before(60 * DAY), catalogue: { provider: "tmdb", id: 11, downloadedAt: before(60 * DAY) } });
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 11, state: "preferred", preferredDownloadedAt: before(60 * DAY), preferredUsableUntil: usableUntil(before(60 * DAY)), usingDownloadedAt: before(60 * DAY) } });
  assert.deepEqual(resolved.tmdb.lookupSource, [{ provider: "Plex", kind: "TMDB show", id: 11 }]);
  for (const provider of ["tmdb", "tvdb"] as const) {
    assert.deepEqual(resolved[provider].obligation, UNCHANGED);
    assert.deepEqual(resolved[provider].issues, preserved(provider));
  }
});

test("a cached recheck keeps last-good results for an untried preference without a usable saved copy, never comparing a fallback", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(60 * DAY + 1) }, tvdb: tvdbSaved } });
  const history = { tmdb: { recordedUse: { preferredId: 10, usingId: 10, state: "preferred" as const }, refreshIssue: { seriesId: 11, failedAt: before(2 * DAY) } } };
  const resolved = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11 }, tvdbOnly, history, { tmdbId: 10, tvdbId: 1 }), { source });

  assert.equal(resolved.outcome, "pending", "issue evidence never authorises a cached fallback");
  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.equal(resolved.tmdb.identity, 11);
  assert.deepEqual(resolved.tmdb.use, { action: "unchanged" });
  assert.deepEqual(resolved.tmdb.issues, preserved("tmdb"));
  assert.equal(resolved.tmdb.unavailableCause, undefined, "no download failure is invented");
  assert.deepEqual(resolved.unavailableCauses, []);
  assert.deepEqual(resolved.warnings, ["TMDB series 11 has no saved catalogue from the last 60 days, so it could not be compared yet. Results from the previously compared catalogue were kept."]);
  assert.deepEqual(requests, []);
});

test("a cached recheck of a tried preference compares the lowest usable fallback's saved copy, keeping the recorded failure provenance", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(60 * DAY), 11: before(61 * DAY), 12: before(DAY) }, tvdb: tvdbSaved } });
  const recordedUse = { preferredId: 11, usingId: 10, state: "fallback" as const, preferredDownloadedAt: before(61 * DAY), preferredFailedAt: before(3 * DAY), usingDownloadedAt: before(60 * DAY), usingFailedAt: before(3 * DAY) };
  const resolved = await resolveComparisonCatalogues(cachedRequest({ candidates: [12, 11, 10], preferredId: 11 }, tvdbOnly, { tmdb: { recordedUse } }, { tmdbId: 10, tvdbId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.catalogue?.id, 10, "a saved copy exactly 60 days old is still usable");
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 10, state: "fallback", preferredDownloadedAt: before(61 * DAY), preferredUsableUntil: usableUntil(before(61 * DAY)), preferredFailedAt: before(3 * DAY), usingDownloadedAt: before(60 * DAY), usingFailedAt: before(3 * DAY) } });

  // Changed (SHELFCHECK-120): with no saved catalogue 60 days old or less, the newest that is not gone is compared, so only gone copies leave it pending.
  const none = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(61 * DAY), 11: before(61 * DAY) }, tvdb: tvdbSaved }, seriesNotFoundDays: { tmdb: { 10: 15, 11: 15 } } });
  const pending = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11 }, tvdbOnly, { tmdb: { recordedUse } }, { tmdbId: 10, tvdbId: 1 }), { source: none.source });
  assert.equal(pending.outcome, "pending");
  assert.deepEqual(pending.warnings, ["No reported TMDB series has a saved catalogue from the last 60 days, so this show could not be rechecked from saved inputs. Last-good results were kept."]);
});

test("a cached recheck that switches from A to a previously failed B keeps B's failure and failure time; an issue naming another series supplies nothing", async () => {
  const saved = { tmdb: { 10: before(DAY), 11: before(5 * DAY) }, tvdb: tvdbSaved };
  const recordedUse = { preferredId: 10, usingId: 10, state: "preferred" as const, usingDownloadedAt: before(DAY) };
  const switched = (refreshIssue: { seriesId: number; failedAt: string }) =>
    resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11 }, tvdbOnly, { tmdb: { recordedUse, refreshIssue } }, { tmdbId: 10, tvdbId: 1 }), { source: inMemoryCatalogueSource({ now: NOW, saved }).source });

  const failedB = await switched({ seriesId: 11, failedAt: before(4 * DAY) });
  assert.equal(failedB.tmdb.catalogue?.id, 11);
  assert.deepEqual(failedB.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 11, state: "saved-unavailable", preferredDownloadedAt: before(5 * DAY), preferredUsableUntil: usableUntil(before(5 * DAY)), preferredFailedAt: before(4 * DAY), usingDownloadedAt: before(5 * DAY) } });
  assert.deepEqual(failedB.tmdb.issues, preserved("tmdb"), "the recorded catalogue-refresh issue is neither set again nor resolved");

  const otherSeries = await switched({ seriesId: 12, failedAt: before(4 * DAY) });
  assert.deepEqual(otherSeries.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 11, state: "preferred", preferredDownloadedAt: before(5 * DAY), preferredUsableUntil: usableUntil(before(5 * DAY)), usingDownloadedAt: before(5 * DAY) } });
});

test("a cached recheck keeps a single Plex ID's series last compared, pending when its saved catalogue is missing", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(400 * DAY) }, tvdb: tvdbSaved } });
  const kept = await resolveComparisonCatalogues(cachedRequest({ candidates: [10], preferredId: 10 }, tvdbOnly, {}, { tmdbId: 10, tvdbId: 1 }), { source });
  assert.equal(kept.outcome, "comparable");
  assert.deepEqual(kept.tmdb.catalogue, { id: 10, origin: "reused", downloadedAt: before(400 * DAY), catalogue: { provider: "tmdb", id: 10, downloadedAt: before(400 * DAY) } });
  assert.deepEqual(kept.tmdb.use, { action: "unchanged" });
  assert.deepEqual(kept.tmdb.lookupSource, [{ provider: "Plex", kind: "TMDB show", id: 10 }]);
  assert.deepEqual(requests, []);

  const missing = await resolveComparisonCatalogues(cachedRequest({ candidates: [12], preferredId: 12 }, tvdbOnly, {}, { tmdbId: 12, tvdbId: 1 }), { source });
  assert.equal(missing.outcome, "pending");
  assert.equal(missing.tmdb.identity, 12);
  assert.deepEqual(missing.tmdb.issues, preserved("tmdb"));
  assert.deepEqual(missing.warnings, ["Saved TMDB catalogue 12 is missing or incomplete. Run a Plex scan to download the TMDB catalogue."]);
});

test("a pending cached recheck reports a several-ID provider's warning first, then TMDB's before TVDB's", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: {}, tvdb: { 1: before(DAY) } } });
  const severalTvdb = await resolveComparisonCatalogues(cachedRequest({ candidates: [10], preferredId: 10 }, { candidates: [1, 3], preferredId: 3 }, { tvdb: { recordedUse: { preferredId: 1, usingId: 1, state: "preferred" } } }, { tmdbId: 10, tvdbId: 1 }), { source });
  assert.equal(severalTvdb.outcome, "pending");
  assert.deepEqual(severalTvdb.warnings, [
    "Saved TMDB catalogue 10 is missing or incomplete. Run a Plex scan to download the TMDB catalogue.",
    "TVDB series 3 has no saved catalogue from the last 60 days, so it could not be compared yet. Results from the previously compared catalogue were kept.",
  ]);
  assert.equal(severalTvdb.pendingWarning, severalTvdb.warnings[1]);

  const singleIds = await resolveComparisonCatalogues(cachedRequest({ candidates: [10], preferredId: 10 }, { candidates: [4], preferredId: 4 }, {}, { tmdbId: 10, tvdbId: 4 }), { source });
  assert.equal(singleIds.pendingWarning, "Saved TMDB catalogue 10 is missing or incomplete. Run a Plex scan to download the TMDB catalogue.");

  const comparable = await resolveComparisonCatalogues(cachedRequest({ candidates: [] }, { candidates: [1], preferredId: 1 }, {}, { tvdbId: 1 }), { source });
  assert.equal(comparable.pendingWarning, undefined);
});

test("a cached recheck keeps a derived TVDB series while the TMDB series compared is unchanged, and derives it again from saved data when it changes", async () => {
  const saved = { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: { 7: before(DAY), 8: before(DAY) } };
  const recordedUse = { preferredId: 10, usingId: 10, state: "preferred" as const };
  const { source } = inMemoryCatalogueSource({ now: NOW, saved, tvdbOfTmdb: { 11: 8 } });
  const unchanged = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 10 }, noTvdb, { tmdb: { recordedUse } }, { tmdbId: 10, tvdbId: 7 }), { source });
  assert.equal(unchanged.outcome, "comparable");
  assert.equal(unchanged.tvdb.identity, 7, "kept without new evidence: TMDB catalogue 10 names no TVDB series here");
  assert.deepEqual(unchanged.tvdb.use, { action: "unchanged" });
  assert.deepEqual(unchanged.tvdb.lookupSource, [{ provider: "Plex", kind: "TMDB show", id: 10 }, { provider: "TMDB", kind: "external TVDB ID", id: 7, cached: true }]);

  const changed = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11 }, noTvdb, { tmdb: { recordedUse } }, { tmdbId: 10, tvdbId: 7 }), { source });
  assert.equal(changed.tvdb.identity, 8);
  assert.deepEqual(changed.tvdb.use, { action: "set", use: { usingId: 8, state: "derived", derivedFrom: 11, usingDownloadedAt: before(DAY) } });
  assert.deepEqual(changed.tvdb.issues, preserved("tvdb"));
  assert.deepEqual(changed.tvdb.obligation, UNCHANGED);

  const unnamed = inMemoryCatalogueSource({ now: NOW, saved });
  const cleared = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11 }, noTvdb, { tmdb: { recordedUse } }, { tmdbId: 10, tvdbId: 7 }), { source: unnamed.source });
  assert.equal(cleared.outcome, "comparable");
  assert.equal(cleared.tvdb.identity, undefined, "an old derived TVDB link is never kept after switching to a catalogue naming none");
  assert.deepEqual(cleared.tvdb.use, { action: "clear" });
  assert.deepEqual(cleared.tvdb.issues, preserved("tvdb"));

  const notSaved = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: saved.tmdb }, tvdbOfTmdb: { 11: 8 } });
  const pending = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11 }, noTvdb, { tmdb: { recordedUse } }, { tmdbId: 10, tvdbId: 7 }), { source: notSaved.source });
  assert.equal(pending.outcome, "pending");
  assert.deepEqual(pending.warnings, ["Saved TVDB catalogue 8 is missing or incomplete. Run a Plex scan to download the TVDB catalogue."]);
});

test("a cached recheck derives TMDB again only for a changed TVDB series: a missing association is pending and a known-empty one clears it", async () => {
  const saved = { tmdb: { 40: before(DAY), 50: before(DAY) }, tvdb: tvdbSaved };
  const recordedUse = { preferredId: 1, usingId: 1, state: "preferred" as const };
  const resolve = (preferredId: number, associations: Record<number, SeriesAssociation>) => {
    const fixture = inMemoryCatalogueSource({ now: NOW, saved, associations });
    return resolveComparisonCatalogues(cachedRequest(noTmdb, { candidates: [1, 3], preferredId }, { tvdb: { recordedUse } }, { tmdbId: 40, tvdbId: 1 }), { source: fixture.source }).then(resolved => ({ resolved, fixture }));
  };

  const unchanged = await resolve(1, {});
  assert.equal(unchanged.resolved.outcome, "comparable");
  assert.equal(unchanged.resolved.tmdb.identity, 40, "kept without asking for the association again");
  assert.deepEqual(unchanged.resolved.tmdb.use, { action: "unchanged" });
  assert.deepEqual(unchanged.fixture.associationRequests, []);

  const found = await resolve(3, { 3: { outcome: "found", id: 50, cached: true } });
  assert.equal(found.resolved.outcome, "comparable");
  assert.deepEqual(found.resolved.resolutionOrder, ["tvdb", "tmdb"]);
  assert.deepEqual(found.resolved.tmdb.use, { action: "set", use: { usingId: 50, state: "derived", derivedFrom: 3, usingDownloadedAt: before(DAY) } });
  assert.deepEqual(found.resolved.tmdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 3 }, { provider: "TMDB", kind: "resolved show", id: 50, cached: true }]);
  assert.deepEqual(found.resolved.tmdb.issues, preserved("tmdb"));
  assert.deepEqual(found.fixture.requests, []);

  const missing = await resolve(3, {});
  assert.equal(missing.resolved.outcome, "pending");
  assert.deepEqual(missing.resolved.tmdb.use, { action: "unchanged" });
  assert.deepEqual(missing.resolved.warnings, ["TMDB's association for TVDB series 3 is not saved, so its TMDB series could not be resolved from saved inputs. Last-good results were kept until the next Plex scan."]);

  const empty = await resolve(3, { 3: { outcome: "known-empty" } });
  assert.equal(empty.resolved.outcome, "comparable");
  assert.equal(empty.resolved.tmdb.identity, undefined);
  assert.deepEqual(empty.resolved.tmdb.use, { action: "clear" });
  assert.deepEqual(empty.resolved.tmdb.issues, preserved("tmdb"));
});

test("a cached recheck reports no obligation change to the progress sink, even with refresh obligations open", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved, tvdb: tvdbSaved } });
  const progress: unknown[] = [];
  const resolved = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, { ...tvdbOnly, refreshObligation: true }, {}, { tmdbId: 10, tvdbId: 1 }), { source, onProviderResolved: async ({ provider, obligation }) => { progress.push({ provider, obligation }); } });
  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(progress, [{ provider: "tmdb", obligation: UNCHANGED }, { provider: "tvdb", obligation: UNCHANGED }]);
});

test("a provider with one Plex ID compares its catalogue under the single-catalogue reuse policy and records the scan's existing single-ID use", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(30 * DAY) }, tvdb: { 1: before(DAY) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11 }, { candidates: [1], preferredId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(requests, [{ provider: "tmdb", id: 11, mandatory: false }, { provider: "tvdb", id: 1, mandatory: false }], "no 20-day refresh for a single Plex ID");
  assert.deepEqual(resolved.tmdb.catalogue, { id: 11, origin: "reused", downloadedAt: before(30 * DAY), catalogue: { provider: "tmdb", id: 11, downloadedAt: before(30 * DAY) } });
  assert.equal(resolved.tmdb.identity, 11);
  assert.deepEqual(resolved.tmdb.lookupSource, [{ provider: "Plex", kind: "TMDB show", id: 11 }]);
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 11, state: "preferred", preferredDownloadedAt: before(30 * DAY), usingDownloadedAt: before(30 * DAY) } });
  assert.deepEqual(resolved.tvdb.use, { action: "set", use: { preferredId: 1, usingId: 1, state: "preferred", preferredDownloadedAt: before(DAY), usingDownloadedAt: before(DAY) } });
  assert.deepEqual(resolved.tmdb.issues, [{ action: "resolve", id: "catalogue-refresh:TMDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" }]);
  assert.deepEqual(resolved.tvdb.issues, [{ action: "resolve", id: "catalogue-refresh:TVDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TVDB:show-1" }]);
  assert.deepEqual([resolved.tmdb.obligation, resolved.tvdb.obligation], [UNCHANGED, UNCHANGED]);
  assert.deepEqual([resolved.unavailableCauses, resolved.warnings], [[], []]);
});

test("a provider with one Plex ID keeps its saved catalogue at any age after a failed lookup, and is unavailable without one", async () => {
  for (const savedAt of [before(60 * DAY + 1), before(400 * DAY), undefined]) {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: savedAt ? { 11: savedAt } : {}, tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: notFound(11) } } });
    const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11 }, { candidates: [1], preferredId: 1 }), { source });

    assert.equal(resolved.outcome, "comparable", "TVDB is compared whether or not TMDB keeps a saved catalogue");
    assert.equal(resolved.tmdb.identity, 11);
    assert.deepEqual(resolved.tmdb.catalogue, savedAt ? { id: 11, origin: "saved", downloadedAt: savedAt, catalogue: { provider: "tmdb", id: 11, downloadedAt: savedAt } } : undefined);
    assert.deepEqual(resolved.tmdb.use, { action: "set", use: savedAt
      ? { preferredId: 11, usingId: 11, preferredDownloadedAt: savedAt, usingDownloadedAt: savedAt, state: "saved-unavailable", preferredFailedAt: NOW }
      : { preferredId: 11, state: "unavailable", preferredFailedAt: NOW } });
    assert.deepEqual(resolved.tmdb.obligation, ADDS_PREFERRED);
    assert.deepEqual(resolved.tmdb.issues, [
      { action: "set", issue: {
        id: "catalogue-refresh:TMDB:show-1", operation: "catalogue-refresh", provider: "TMDB", scope: "show",
        show: { ratingKey: "show-1", title: "Example Show", tmdbId: 11, tvdbId: 1 },
        catalogueRefresh: { checkedAt: NOW, ...(savedAt ? { downloadedAt: savedAt } : {}) },
        category: "Provider Lookup",
        lookup: { source: [{ provider: "Plex", kind: "TMDB show", id: 11 }], requested: { provider: "TMDB", kind: "show", id: 11 }, impact: `TMDB episode coverage could not be fully verified. ${savedAt ? "Last-good catalogue data was retained." : "No previous catalogue data is available."} No previous comparison results are available.`, status: 404, failureKind: "http" },
        cause: "404 — record not found", action: "Check the Plex provider ID reference; retry after checking or correcting the reference.",
      } },
      { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" },
    ], "a single-ID issue states no failure time");
    assert.equal(resolved.tmdb.unavailableCause, savedAt ? undefined : "catalogue-refresh:TMDB:show-1");
    assert.deepEqual(resolved.unavailableCauses, savedAt ? [] : ["catalogue-refresh:TMDB:show-1"]);
    assert.equal(resolved.warnings.length, 1, "a failed single-ID lookup warns even when its saved catalogue is kept");
    assert.equal(resolved.tvdb.catalogue?.id, 1, "the other provider is still resolved");
  }
});

test("a single TVDB ID failing on provider authentication names that cause, and the TMDB identity resolved before it", async () => {
  const { source } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 11: before(DAY) } },
    failing: { tvdb: { 1: { error: new Error("TVDB authentication failed."), causedBy: ["provider-authentication:TVDB"] } } },
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11 }, { candidates: [1], preferredId: 1, refreshObligation: true }), { source });

  assert.equal(resolved.outcome, "comparable", "TMDB is still compared");
  assert.deepEqual(resolved.tvdb.obligation, UNCHANGED, "an obligation already open stays open");
  const issue = resolved.tvdb.issues[0];
  assert.equal(issue.action, "set");
  if (issue.action !== "set") return;
  assert.deepEqual(issue.issue.causedBy, ["provider-authentication:TVDB"]);
  assert.deepEqual(issue.issue.show, { ratingKey: "show-1", title: "Example Show", tmdbId: 11, tvdbId: 1 });
  assert.deepEqual(issue.issue.lookup?.requested, { provider: "TVDB", kind: "series", id: 1 });
  assert.deepEqual(resolved.unavailableCauses, ["catalogue-refresh:TVDB:show-1"]);
  assert.deepEqual(resolved.warnings, ["TVDB authentication failed."]);
});

test("any successful download from a single-ID provider clears its open refresh obligation; reuse never does", async () => {
  for (const obligation of [true, false]) {
    const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY) }, tvdb: { 1: before(DAY) } } });
    const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11, refreshObligation: obligation }, { candidates: [1], preferredId: 1 }), { source });
    assert.deepEqual(requests[0], { provider: "tmdb", id: 11, mandatory: obligation });
    assert.equal(resolved.tmdb.catalogue?.origin, obligation ? "downloaded" : "reused");
    assert.deepEqual(resolved.tmdb.obligation, obligation ? SATISFIES_PREFERRED : UNCHANGED);
    assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 11, state: "preferred", preferredDownloadedAt: obligation ? NOW : before(DAY), usingDownloadedAt: obligation ? NOW : before(DAY) } });
  }
});

test("with no Plex TMDB ID and one Plex TVDB ID, TMDB is derived from that ID before TVDB loads", async () => {
  const { source, requests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: { 1: before(DAY) } }, associations: { 1: { outcome: "found", id: 50, cached: false } },
  });
  const resolved = await resolveComparisonCatalogues(request(noTmdb, { candidates: [1], preferredId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(resolved.resolutionOrder, ["tmdb", "tvdb"]);
  assert.deepEqual(requests.map(r => [r.provider, r.id]), [["tmdb", 50], ["tvdb", 1]]);
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { usingId: 50, state: "derived", derivedFrom: 1, usingDownloadedAt: before(DAY) } });
  assert.deepEqual(resolved.tvdb.use, { action: "set", use: { preferredId: 1, usingId: 1, state: "preferred", preferredDownloadedAt: before(DAY), usingDownloadedAt: before(DAY) } });
});

test("a derived TMDB series in a live scan answers its association from saved evidence unless a refresh obligation is open", async () => {
  for (const refreshObligation of [false, true]) {
    const { source, associationRequests } = inMemoryCatalogueSource({
      now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: { 1: before(DAY) } },
      savedAssociations: { 1: 50 }, associations: { 1: { outcome: "found", id: 50, cached: false } },
    });
    const resolved = await resolveComparisonCatalogues(request({ candidates: [], refreshObligation }, { candidates: [1], preferredId: 1 }), { source });

    assert.equal(resolved.outcome, "comparable");
    assert.deepEqual(associationRequests, [{ tvdbId: 1, mandatory: refreshObligation }]);
    assert.deepEqual(resolved.tmdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }, { provider: "TMDB", kind: "resolved show", id: 50, cached: !refreshObligation }]);
    assert.equal(resolved.tmdb.catalogue?.origin, refreshObligation ? "downloaded" : "reused");
  }
});

test("a live scan requests an association that saved evidence cannot answer, instead of leaving the comparison pending", async () => {
  const { source: inner } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: { 1: before(DAY) } } });
  const asked: boolean[] = [];
  const source: typeof inner = {
    ...inner,
    tmdbSeriesForTvdb: async (_tvdbId, { mandatory }) => { asked.push(mandatory); return mandatory ? { outcome: "found", id: 50, cached: false } : { outcome: "missing" }; },
  };
  const resolved = await resolveComparisonCatalogues(request(noTmdb, { candidates: [1], preferredId: 1 }), { source });

  assert.deepEqual(asked, [false, true]);
  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.identity, 50);
  assert.deepEqual(resolved.warnings, []);
});

test("a preferred series' download time comes from its saved record even when that record is too incomplete to compare", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, unusable: { tmdb: { 11: before(5 * DAY) } }, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.equal(resolved.tmdb.catalogue?.id, 10, "the incomplete record is never compared");
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 10, state: "fallback", preferredDownloadedAt: before(5 * DAY), preferredUsableUntil: usableUntil(before(5 * DAY)), preferredFailedAt: NOW, usingDownloadedAt: before(DAY) } });
});

test("a load's provenance is the provider's lookup provenance when the load reports one", async () => {
  const { source: inner } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY) }, tvdb: { 1: before(DAY) } } });
  const provenance = [{ provider: "Plex" as const, kind: "TMDB show" as const, id: 11 }, { provider: "TMDB" as const, kind: "resolved show" as const, id: 11, cached: true }];
  const source: typeof inner = { ...inner, loadCatalogue: async (provider, id, settings) => { const load = await inner.loadCatalogue(provider, id, settings); return provider === "tmdb" && load.outcome !== "failed" ? { ...load, lookupSource: provenance } : load; } };
  const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11 }, { candidates: [1], preferredId: 1 }), { source });

  assert.deepEqual(resolved.tmdb.lookupSource, provenance);
  assert.deepEqual(resolved.tvdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }]);
});

// Each provider is judged from the catalogue in use (ADR-0006): working, a Total Provider Lookup
// Failure using a saved catalogue, or one with no catalogue. One provider's failure never blocks the other's comparison.
const tmdbSingle = { candidates: [11], preferredId: 11 }, tvdbSingle = { candidates: [1], preferredId: 1 };

test("a TMDB 404 with no saved data never blocks TVDB's comparison: the show is compared and TMDB is a Total Provider Lookup Failure with no catalogue", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.showStatus, "partially-matched");
  assert.deepEqual(resolved.tmdb.status, { state: "total-failure", catalogue: "none", cause: "404 — record not found" });
  assert.deepEqual(resolved.tvdb.status, { state: "working" });
  assert.equal(resolved.tmdb.issues[0].action, "set", "the failing provider keeps its Scan Issues entry");
});

test("a provider comparing a saved copy kept after a failed attempt is a Total Provider Lookup Failure using that catalogue", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(400 * DAY) }, tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: { error: new Error("TMDB is down.") } } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.showStatus, "partially-matched");
  assert.deepEqual(resolved.tmdb.status, { state: "total-failure", catalogue: "saved", cause: "TMDB returned an incomplete or unreadable response" });
});

test("a show whose providers both fail with no saved data is unmatched, with each provider's cause; either provider downloading matches it again", async () => {
  const failing = { tmdb: { 11: notFound(11) }, tvdb: { 1: { error: new Error("TVDB is down.") } } };
  const { source } = inMemoryCatalogueSource({ now: NOW, failing });
  const unmatched = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source });

  assert.equal(unmatched.outcome, "unmatched");
  assert.equal(unmatched.showStatus, "unmatched");
  assert.deepEqual(unmatched.tmdb.status, { state: "total-failure", catalogue: "none", cause: "404 — record not found" });
  assert.deepEqual(unmatched.tvdb.status, { state: "total-failure", catalogue: "none", cause: "TVDB returned an incomplete or unreadable response" });
  assert.deepEqual(unmatched.unavailableCauses, ["catalogue-refresh:TMDB:show-1", "catalogue-refresh:TVDB:show-1"]);

  const { source: tvdbBack } = inMemoryCatalogueSource({ now: NOW, failing: { tmdb: failing.tmdb } });
  const partial = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source: tvdbBack });
  assert.equal(partial.outcome, "comparable");
  assert.equal(partial.showStatus, "partially-matched");
});

test("both providers working is a matched show", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY) }, tvdb: { 1: before(DAY) } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source });

  assert.equal(resolved.showStatus, "matched");
  assert.deepEqual([resolved.tmdb.status, resolved.tvdb.status], [{ state: "working" }, { state: "working" }]);
});

test("a TVDB catalogue loaded through TMDB's external IDs is working, though Plex reports no TVDB ID", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY) } }, tvdbOfTmdb: { 11: 7 } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, noTvdb), { source });

  assert.deepEqual(resolved.tvdb.status, { state: "working" });
  assert.equal(resolved.showStatus, "matched");
});

test("a provider with no Plex ID and none found through the other provider is a Total Provider Lookup Failure, so the show is Partially matched", async () => {
  // Changed (ADR-0006): this provider used to have no series to look up, and the show was matched.
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY) } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, noTvdb), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(resolved.tvdb.status, { state: "total-failure", catalogue: "none", cause: "No TVDB series ID from Plex or TMDB" });
  assert.equal(resolved.showStatus, "partially-matched");
  assert.equal(resolved.tvdb.issues.filter(action => action.action === "set").length, 1, "one Scan Issues entry for TVDB");
});

test("a show with only a TMDB ID that fails with no saved data, and no TVDB found, is unmatched", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, noTvdb), { source });

  assert.equal(resolved.outcome, "unmatched");
  assert.equal(resolved.showStatus, "unmatched");
  // TVDB was never asked, since its ID could only come from the TMDB catalogue: it is not looked up, not failing.
  assert.deepEqual(resolved.tvdb.status, { state: "not-looked-up", cause: TVDB_NOT_LOOKED_UP });
  assert.ok(resolved.tvdb.issues.every(action => action.action === "resolve"), "no missing-ID Scan Issue for TVDB");
  assert.deepEqual(resolved.unavailableCauses, ["catalogue-refresh:TMDB:show-1"]);
});

test("several candidates: a fallback that loads is working, and untried candidates never count as failing", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: tvdbSaved }, failing: { tmdb: { 30: notFound(30) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 20, 30], preferredId: 30 }, tvdbOnly), { source });

  assert.deepEqual(requests.filter(r => r.provider === "tmdb").map(r => r.id), [30, 10], "20 is never tried");
  assert.deepEqual(resolved.tmdb.status, { state: "working" });
  assert.equal(resolved.showStatus, "matched");
});

test("several candidates failing: one catalogue-refresh entry lists each tried candidate's ID, cause, catalogue age and 404 progress, and no separate fallback entry is set", async () => {
  const { source } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 20: before(30 * DAY) }, tvdb: tvdbSaved },
    failing: { tmdb: { 100: { ...notFound(100), kind: "series-not-found", seriesNotFoundDays: 4 }, 3: { error: new Error("TMDB is down.") }, 20: { ...notFound(20), kind: "series-not-found", seriesNotFoundDays: 2 } } },
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [100, 20, 3], preferredId: 100 }, tvdbOnly), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(resolved.tmdb.status, { state: "total-failure", catalogue: "saved", cause: "404 — record not found" });
  const [refresh, fallback] = resolved.tmdb.issues;
  assert.equal(refresh.action === "set" && refresh.issue.id, "catalogue-refresh:TMDB:show-1");
  assert.deepEqual(refresh.action === "set" && refresh.issue.catalogueRefresh, { checkedAt: NOW, downloadedAt: before(30 * DAY), seriesNotFoundDays: 2 }, "the age and 404 progress of 20, the saved catalogue in use");
  assert.deepEqual(refresh.action === "set" && refresh.issue.candidates, [
    { id: 100, cause: "404 — record not found", catalogueRefresh: { checkedAt: NOW, seriesNotFoundDays: 4 } },
    { id: 3, cause: "TMDB returned an incomplete or unreadable response", catalogueRefresh: { checkedAt: NOW } },
    { id: 20, cause: "404 — record not found", catalogueRefresh: { checkedAt: NOW, downloadedAt: before(30 * DAY), seriesNotFoundDays: 2 } },
  ]);
  assert.deepEqual(fallback, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" });
});

test("a live scan of a show Plex reports no TMDB or TVDB ID for is unmatched with a warning saying so", async () => {
  const { source, requests, associationRequests } = inMemoryCatalogueSource({ now: NOW });
  const resolved = await resolveComparisonCatalogues(request(noTmdb, noTvdb), { source });

  assert.equal(resolved.outcome, "unmatched");
  assert.equal(resolved.showStatus, "unmatched");
  assert.deepEqual(resolved.warnings, ["No TMDB or TVDB ID was exposed by Plex."]);
  assert.deepEqual([requests, associationRequests], [[], []]);
  // With no ID at all there is no other provider to search: the one warning says so, and no catalogue issue is set.
  assert.deepEqual([resolved.tmdb.status, resolved.tvdb.status], [{ state: "not-looked-up" }, { state: "not-looked-up" }]);
  assert.deepEqual(resolved.unavailableCauses, []);
  assert.ok([...resolved.tmdb.issues, ...resolved.tvdb.issues].every(action => action.action === "resolve"));
});

test("a cached recheck keeps each provider's status from the last scan rather than judging it again", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(400 * DAY) }, tvdb: { 1: before(DAY) } } });
  const lastScan = { tmdb: { state: "total-failure" as const, catalogue: "saved" as const, cause: "TMDB is down." }, tvdb: { state: "working" as const } };
  const resolved = await resolveComparisonCatalogues({ ...cachedRequest(tmdbSingle, tvdbSingle, {}, { tmdbId: 11, tvdbId: 1 }), previousComparison: { tmdbId: 11, tvdbId: 1, complete: true, status: lastScan } }, { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual([resolved.tmdb.status, resolved.tvdb.status], [lastScan.tmdb, lastScan.tvdb]);
  assert.equal(resolved.showStatus, "partially-matched");
});

test("a cached recheck compares a Partially matched show without the provider the last scan had no catalogue for, keeping that status", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: { 1: before(DAY) } } });
  const lastScan = { tmdb: { state: "total-failure" as const, catalogue: "none" as const, cause: "404 — record not found" }, tvdb: { state: "working" as const } };
  const resolved = await resolveComparisonCatalogues({ ...cachedRequest(tmdbSingle, tvdbSingle, {}, { tmdbId: 11, tvdbId: 1 }), previousComparison: { tmdbId: 11, tvdbId: 1, complete: true, status: lastScan } }, { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.equal(resolved.tvdb.catalogue?.id, 1);
  assert.deepEqual(resolved.tmdb.status, lastScan.tmdb);
  assert.equal(resolved.pendingWarning, undefined);
});

// Gone provider records (ADR-0006): 15 counted 404 days and a saved catalogue more than 60 days old.
const seriesNotFound = (id: number, days: number) => ({ ...notFound(id), kind: "series-not-found" as const, seriesNotFoundDays: days });

test("a single Plex ID that is a Gone provider record keeps its saved catalogue but never compares it: the show is compared with the other provider", async () => {
  const { source, saved } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(61 * DAY) }, tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: seriesNotFound(11, 15) } }, seriesNotFoundDays: { tmdb: { 11: 15 } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.equal(resolved.tmdb.identity, 11);
  assert.deepEqual(resolved.tmdb.status, { state: "total-failure", catalogue: "gone", cause: "404 — record not found" });
  assert.equal(resolved.showStatus, "partially-matched");
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, state: "unavailable", preferredFailedAt: NOW } });
  assert.deepEqual(resolved.tmdb.obligation, ADDS_PREFERRED, "the series is still retried every scan");
  assert.deepEqual(resolved.unavailableCauses, ["catalogue-refresh:TMDB:show-1"]);
  const [refresh] = resolved.tmdb.issues;
  assert.deepEqual(refresh.action === "set" && refresh.issue.catalogueRefresh, { checkedAt: NOW, downloadedAt: before(61 * DAY), seriesNotFoundDays: 15, gone: true });
  assert.match(refresh.action === "set" ? refresh.issue.lookup?.impact || "" : "", /gone provider record/i);
  assert.equal(saved.tmdb.get(11), before(61 * DAY), "the saved catalogue is kept");
});

test("a gone record failing with something other than a 404 is still gone: the count and age decide, not today's failure", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(90 * DAY) }, tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: { error: new Error("TMDB is down.") } } }, seriesNotFoundDays: { tmdb: { 11: 15 } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source });

  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.equal(resolved.tmdb.status.state === "total-failure" && resolved.tmdb.status.catalogue, "gone");
  const [refresh] = resolved.tmdb.issues;
  assert.deepEqual(refresh.action === "set" && refresh.issue.catalogueRefresh, { checkedAt: NOW, downloadedAt: before(90 * DAY), seriesNotFoundDays: 15, gone: true });
});

for (const [label, days, age] of [["14 counted days and a catalogue 400 days old", 14, 400 * DAY], ["15 counted days and a catalogue exactly 60 days old", 15, 60 * DAY]] as const) {
  test(`${label} is not gone: its saved catalogue is compared after a failed attempt`, async () => {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(age) }, tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: seriesNotFound(11, days) } }, seriesNotFoundDays: { tmdb: { 11: days } } });
    // An open obligation makes the load a download attempt even where the copy could be reused.
    const resolved = await resolveComparisonCatalogues(request({ ...tmdbSingle, refreshObligation: true }, tvdbSingle), { source });

    assert.equal(resolved.tmdb.catalogue?.origin, "saved");
    assert.deepEqual(resolved.tmdb.status, { state: "total-failure", catalogue: "saved", cause: "404 — record not found" });
  });
}

test("a single-ID provider's 503, network, rate-limit and sign-in failures keep the last-good catalogue at any age", async () => {
  for (const error of [new ProviderHttpError("TMDB", 503, { provider: "TMDB", kind: "show", id: 11 }), new TypeError("fetch failed"), new ProviderHttpError("TMDB", 429, { provider: "TMDB", kind: "show", id: 11 }), new ProviderHttpError("TMDB", 401, { provider: "TMDB", kind: "show", id: 11 })]) {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(500 * DAY) }, tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: { error } } }, seriesNotFoundDays: { tmdb: { 11: 14 } } });
    const resolved = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source });
    assert.equal(resolved.tmdb.catalogue?.origin, "saved", String(error));
  }
});

test("one complete download makes a gone record usable again", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(61 * DAY) }, tvdb: { 1: before(DAY) } }, seriesNotFoundDays: { tmdb: { 11: 15 } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, tvdbSingle), { source });

  assert.equal(resolved.tmdb.catalogue?.origin, "downloaded");
  assert.deepEqual(resolved.tmdb.status, { state: "working" });
  assert.equal(resolved.showStatus, "matched");
});

test("a show whose only provider is a gone record is unmatched", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(61 * DAY) } }, failing: { tmdb: { 11: seriesNotFound(11, 15) } }, seriesNotFoundDays: { tmdb: { 11: 15 } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, noTvdb), { source });

  assert.equal(resolved.outcome, "unmatched");
  assert.equal(resolved.showStatus, "unmatched");
});

test("a derived TVDB series that is a gone record is never compared; TMDB still is", async () => {
  const tvdbNotFound = { error: new ProviderHttpError("TVDB", 404, { provider: "TVDB", kind: "series", id: 7 }), kind: "series-not-found" as const, seriesNotFoundDays: 15 };
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY) }, tvdb: { 7: before(61 * DAY) } }, tvdbOfTmdb: { 11: 7 }, failing: { tvdb: { 7: tvdbNotFound } }, seriesNotFoundDays: { tvdb: { 7: 15 } } });
  const resolved = await resolveComparisonCatalogues(request(tmdbSingle, noTvdb), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tvdb.catalogue, undefined);
  assert.equal(resolved.tvdb.identity, 7);
  assert.deepEqual(resolved.tvdb.status, { state: "total-failure", catalogue: "gone", cause: "404 — record not found" });
  assert.deepEqual(resolved.tvdb.use, { action: "set", use: { usingId: 7, state: "derived", derivedFrom: 11 } });
  assert.equal(resolved.showStatus, "partially-matched");
});

test("a derived TMDB series last compared for the same TVDB series is not kept once it is a gone record", async () => {
  for (const failure of ["association", "load"] as const) {
    const { source } = inMemoryCatalogueSource({
      now: NOW, saved: { tmdb: { 40: before(61 * DAY) }, tvdb: tvdbSaved }, seriesNotFoundDays: { tmdb: { 40: 15 } },
      associations: { 1: failure === "association" ? { outcome: "failed", error: new Error("TMDB is down.") } : { outcome: "found", id: 40, cached: false } },
      failing: { tmdb: { 40: seriesNotFound(40, 15) } },
    });
    const resolved = await resolveComparisonCatalogues({ ...request(noTmdb, tvdbOnly), previousComparison: { tmdbId: 40, tvdbId: 1, complete: true } }, { source });

    assert.equal(resolved.tmdb.catalogue, undefined, failure);
    assert.equal(resolved.tvdb.catalogue?.id, 1, failure);
    assert.equal(resolved.showStatus, "partially-matched", failure);
    if (failure === "load") assert.deepEqual(resolved.tmdb.status, { state: "total-failure", catalogue: "gone", cause: "404 — record not found" });
  }
});

// A cached recheck never compares a gone record and never counts: it reads the counted days only.
// A recheck never judges a provider again, so a record the last scan already judged gone stays
// uncompared under that status; a copy the last scan compared that has since become gone (its
// catalogue aged past 60 days) is treated as missing: the recheck is pending and last-good results
// stay until the next scan judges it, so the recheck never changes the show's status by itself.
test("a cached recheck keeps a provider the last scan judged gone uncompared, with that status", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(61 * DAY) }, tvdb: { 1: before(DAY) } }, seriesNotFoundDays: { tmdb: { 11: 15 } } });
  const lastScan = { tmdb: { state: "total-failure" as const, catalogue: "gone" as const, cause: "404 — record not found" }, tvdb: { state: "working" as const } };
  const resolved = await resolveComparisonCatalogues({ ...cachedRequest(tmdbSingle, tvdbSingle, {}, { tmdbId: 11, tvdbId: 1 }), previousComparison: { tmdbId: 11, tvdbId: 1, complete: true, status: lastScan } }, { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.equal(resolved.tvdb.catalogue?.id, 1);
  assert.deepEqual(resolved.tmdb.status, lastScan.tmdb);
  assert.equal(resolved.showStatus, "partially-matched");
});

test("a cached recheck never compares a copy that has become gone since the last scan: it is pending and last-good results stay", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(61 * DAY) }, tvdb: { 1: before(DAY) } }, seriesNotFoundDays: { tmdb: { 11: 15 } } });
  const lastScan = { tmdb: { state: "total-failure" as const, catalogue: "saved" as const, cause: "404 — record not found" }, tvdb: { state: "working" as const } };
  const resolved = await resolveComparisonCatalogues({ ...cachedRequest(tmdbSingle, tvdbSingle, {}, { tmdbId: 11, tvdbId: 1 }), previousComparison: { tmdbId: 11, tvdbId: 1, complete: true, status: lastScan } }, { source });

  assert.equal(resolved.outcome, "pending");
  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.deepEqual(resolved.tmdb.status, { state: "pending" });
  assert.deepEqual(resolved.tmdb.issues, preserved("tmdb"));
  assert.deepEqual(resolved.tmdb.use, { action: "unchanged" });
  assert.equal(resolved.pendingWarning, "TMDB series 11 is a gone provider record, so its saved catalogue is no longer compared. Last-good results were kept until the next Plex scan.");
  assert.deepEqual(requests, [], "a recheck loads nothing and never counts");
});

test("a cached recheck compares a saved copy that is not gone, whatever its age", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(400 * DAY) }, tvdb: { 1: before(DAY) } }, seriesNotFoundDays: { tmdb: { 11: 14 } } });
  const resolved = await resolveComparisonCatalogues(cachedRequest(tmdbSingle, tvdbSingle, {}, { tmdbId: 11, tvdbId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.catalogue?.id, 11);
});

test("a cached recheck deriving a series again never compares a derived series that is gone", async () => {
  // TMDB now compares series 12, so TVDB is derived again, from 12's catalogue: series 8.
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY), 12: before(DAY) }, tvdb: { 7: before(DAY), 8: before(61 * DAY) } }, tvdbOfTmdb: { 11: 7, 12: 8 }, seriesNotFoundDays: { tvdb: { 8: 15 } } });
  const resolved = await resolveComparisonCatalogues(cachedRequest({ candidates: [11, 12], preferredId: 12 }, noTvdb, {}, { tmdbId: 11, tvdbId: 7 }), { source });

  assert.equal(resolved.tmdb.catalogue?.id, 12);

  assert.equal(resolved.outcome, "pending");
  assert.equal(resolved.tvdb.catalogue, undefined);
  assert.equal(resolved.pendingWarning, "TVDB series 8 is a gone provider record, so its saved catalogue is no longer compared. Last-good results were kept until the next Plex scan.");
});

// Several candidates (ADR-0006 amending ADR-0005): selection is unchanged while any candidate works
// or has a saved catalogue 60 days old or less. Only when none does is the most recently saved
// catalogue that is not gone compared, at any age; the provider is gone only when every candidate is.
test("an expired preferred candidate failing with 503 while another works compares the working candidate, whatever its 404 days", async () => {
  const unavailable = { error: new ProviderHttpError("TMDB", 503, { provider: "TMDB", kind: "show", id: 11 }) };
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(61 * DAY), 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: unavailable } }, seriesNotFoundDays: { tmdb: { 11: 14 } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.equal(resolved.tmdb.catalogue?.id, 10);
  assert.equal(resolved.tmdb.catalogue?.origin, "reused");
  assert.deepEqual(resolved.tmdb.status, { state: "working" });
});

test("when every candidate fails and no saved catalogue is 60 days old or less, a scan compares the most recently saved one that is not gone", async () => {
  const { source } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 10: before(70 * DAY), 11: before(61 * DAY), 12: before(90 * DAY) }, tvdb: tvdbSaved },
    failing: { tmdb: { 10: seriesNotFound(10, 3), 11: seriesNotFound(11, 15), 12: { error: new Error("TMDB is down.") } } }, seriesNotFoundDays: { tmdb: { 10: 3, 11: 15 } },
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11, 12], preferredId: 11 }, tvdbOnly), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(resolved.tmdb.catalogue, { id: 10, origin: "saved", downloadedAt: before(70 * DAY), catalogue: { provider: "tmdb", id: 10, downloadedAt: before(70 * DAY) } }, "11 is newer but gone; 10 is newer than 12");
  assert.equal(resolved.tmdb.identity, 10);
  assert.deepEqual(resolved.tmdb.status, { state: "total-failure", catalogue: "saved", cause: "404 — record not found" });
  assert.equal(resolved.showStatus, "partially-matched");
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 10, state: "fallback", preferredDownloadedAt: before(61 * DAY), preferredUsableUntil: usableUntil(before(61 * DAY)), preferredFailedAt: NOW, usingDownloadedAt: before(70 * DAY), usingFailedAt: NOW } });
  assert.equal(resolved.tmdb.unavailableCause, undefined);
  const [refresh] = resolved.tmdb.issues;
  assert.deepEqual(refresh.action === "set" && refresh.issue.candidates?.map(candidate => [candidate.id, candidate.catalogueRefresh]), [
    [11, { checkedAt: NOW, downloadedAt: before(61 * DAY), seriesNotFoundDays: 15, gone: true }],
    [10, { checkedAt: NOW, downloadedAt: before(70 * DAY), seriesNotFoundDays: 3 }],
    [12, { checkedAt: NOW, downloadedAt: before(90 * DAY) }],
  ], "each candidate's entry shows its gone progress");
});

test("the last resort keeps the preferred series' own saved copy when it is the newest that is not gone", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(80 * DAY), 11: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 10: notFound(10), 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.equal(resolved.tmdb.catalogue?.id, 11);
  assert.equal((resolved.tmdb.use as { use: { state: string } }).use.state, "saved-unavailable");
});

test("every candidate gone is reported as gone; a never-downloaded candidate alongside gone ones is no usable catalogue, not gone", async () => {
  const gone = { saved: { tmdb: { 10: before(61 * DAY), 11: before(90 * DAY) }, tvdb: tvdbSaved }, seriesNotFoundDays: { tmdb: { 10: 15, 11: 20 } } };
  const failing = { tmdb: { 10: seriesNotFound(10, 15), 11: seriesNotFound(11, 20), 12: notFound(12) } };
  const allGone = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source: inMemoryCatalogueSource({ now: NOW, ...gone, failing }).source });

  assert.equal(allGone.outcome, "comparable");
  assert.equal(allGone.tmdb.catalogue, undefined);
  assert.equal(allGone.tmdb.gone, true);
  assert.deepEqual(allGone.tmdb.status, { state: "total-failure", catalogue: "gone", cause: "404 — record not found" });
  assert.equal(allGone.showStatus, "partially-matched");

  const withNew = await resolveComparisonCatalogues(request({ candidates: [10, 11, 12], preferredId: 11 }, tvdbOnly), { source: inMemoryCatalogueSource({ now: NOW, ...gone, failing }).source });
  assert.equal(withNew.tmdb.catalogue, undefined);
  assert.equal(withNew.tmdb.gone, undefined);
  assert.deepEqual(withNew.tmdb.status, { state: "total-failure", catalogue: "none", cause: "404 — record not found" });
});

test("a cached recheck of a tried preference with no saved catalogue 60 days old or less compares the most recently saved one that is not gone", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(70 * DAY), 11: before(61 * DAY), 12: before(90 * DAY) }, tvdb: tvdbSaved }, seriesNotFoundDays: { tmdb: { 11: 15 } } });
  const recordedUse = { preferredId: 11, usingId: 10, state: "fallback" as const, preferredDownloadedAt: before(61 * DAY), preferredFailedAt: before(DAY), usingDownloadedAt: before(70 * DAY), usingFailedAt: before(DAY) };
  const resolved = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11, 12], preferredId: 11 }, tvdbOnly, { tmdb: { recordedUse } }, { tmdbId: 10, tvdbId: 1 }), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(requests, []);
  assert.deepEqual(resolved.tmdb.catalogue, { id: 10, origin: "reused", downloadedAt: before(70 * DAY), catalogue: { provider: "tmdb", id: 10, downloadedAt: before(70 * DAY) } });
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { ...recordedUse, preferredUsableUntil: usableUntil(before(61 * DAY)) } });
});

test("a cached recheck whose candidates are all gone keeps the provider the last scan judged gone uncompared, with that status", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(61 * DAY), 11: before(90 * DAY) }, tvdb: tvdbSaved }, seriesNotFoundDays: { tmdb: { 10: 15, 11: 15 } } });
  const recordedUse = { preferredId: 11, state: "unavailable" as const, preferredDownloadedAt: before(90 * DAY), preferredFailedAt: before(DAY) };
  const lastScan = { tmdb: { state: "total-failure" as const, catalogue: "gone" as const, cause: "404 — record not found" }, tvdb: { state: "working" as const } };
  const resolved = await resolveComparisonCatalogues({ ...cachedRequest({ candidates: [10, 11], preferredId: 11 }, tvdbOnly, { tmdb: { recordedUse } }, { tmdbId: 11, tvdbId: 1 }), previousComparison: { tmdbId: 11, tvdbId: 1, complete: true, status: lastScan } }, { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tmdb.catalogue, undefined);
  assert.deepEqual(resolved.tmdb.status, lastScan.tmdb);
  assert.equal(resolved.pendingWarning, undefined);
});
