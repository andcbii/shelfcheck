import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { inMemoryCatalogueSource } from "./in-memory-catalogue-source";

// The resolver builds Coverage Issue values with the production lookup helper, a server-only module.
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { resolveComparisonCatalogues } = await import("../lib/comparison-catalogue-resolver");
const { ProviderHttpError } = await import("../lib/provider-client");
hook.deregister();

const NOW = "2026-06-01T12:00:00.000Z";
const DAY = 86400_000;
const before = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const show = { ratingKey: "show-1", title: "Example Show" };

type ProviderSetup = { candidates: number[]; preferredId?: number; refreshObligation?: boolean };
function request(tmdb: ProviderSetup, tvdb: ProviderSetup) {
  const provider = (setup: ProviderSetup, kind: "TMDB show" | "TVDB series") => ({
    candidates: setup.candidates, preferredId: setup.preferredId, refreshObligation: !!setup.refreshObligation,
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

test("an unloadable preferred catalogue is a catalogue-refresh Coverage Issue with today's identity, failure time, provenance and impact", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.deepEqual(resolved.tmdb.issues, [
    { action: "set", issue: {
      id: "catalogue-refresh:TMDB:show-1", failedAt: NOW, operation: "catalogue-refresh", provider: "TMDB", scope: "show",
      show: { ratingKey: "show-1", title: "Example Show", tmdbId: 11, tvdbId: 1 },
      category: "Provider Lookup",
      lookup: { source: [{ provider: "Plex", kind: "TMDB show", id: 11 }], requested: { provider: "TMDB", kind: "show", id: 11 }, impact: "Preferred: 11 · Currently using: 10 · 11 unavailable; no saved catalogue. TMDB series 11 is retried every scan; the preference is kept.", status: 404, failureKind: "http" },
      cause: "404 — record not found", action: "Check the Plex provider ID reference; retry after checking or correcting the reference.",
    } },
    { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" },
  ]);
  assert.equal(resolved.tmdb.warning, undefined, "a compared fallback raises no warning");
});

test("fallback candidates are tried in numeric order, and a fallback compared from its saved copy has its own Coverage Issue", async () => {
  const { source, requests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 20: before(30 * DAY) }, tvdb: tvdbSaved },
    failing: { tmdb: { 100: notFound(100), 3: notFound(3), 20: notFound(20) } },
  });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [100, 20, 3], preferredId: 100 }, tvdbOnly), { source });

  assert.deepEqual(requests.filter(r => r.provider === "tmdb").map(r => r.id), [100, 3, 20]);
  assert.deepEqual(resolved.tmdb.catalogue, { id: 20, origin: "saved", downloadedAt: before(30 * DAY), catalogue: { provider: "tmdb", id: 20, downloadedAt: before(30 * DAY) } });
  const use = { preferredId: 100, usingId: 20, state: "fallback", preferredFailedAt: NOW, usingDownloadedAt: before(30 * DAY), usingFailedAt: NOW };
  assert.deepEqual(resolved.tmdb.use, { action: "set", use });
  const fallbackIssue = resolved.tmdb.issues[1];
  assert.deepEqual(fallbackIssue, { action: "set", issue: {
    id: "catalogue-fallback-refresh:TMDB:show-1", operation: "catalogue-refresh", provider: "TMDB", scope: "show",
    show: { ratingKey: "show-1", title: "Example Show", tmdbId: 20, tvdbId: 1 },
    category: "Provider Lookup",
    lookup: { source: [{ provider: "Plex", kind: "TMDB show", id: 100 }], requested: { provider: "TMDB", kind: "show", id: 20 }, impact: `Preferred: 100 · Currently using: 20 · 100 unavailable; no saved catalogue · 20 could not be refreshed either; its saved catalogue, downloaded ${before(30 * DAY).slice(0, 10)}, is in use.`, status: 404, failureKind: "http" },
    cause: "404 — record not found", action: "Check the Plex provider ID reference; retry after checking or correcting the reference.",
  } });
});

test("no candidate with a usable catalogue leaves the provider unavailable and the comparison pending", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 10: notFound(10), 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.equal(resolved.outcome, "pending");
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

test("every candidate load asks for the 20-day refresh, and is mandatory while a refresh obligation is open", async () => {
  for (const refreshObligation of [false, true]) {
    const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
    await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation }, tvdbOnly), { source });
    assert.deepEqual(requests.filter(r => r.provider === "tmdb"), [
      { provider: "tmdb", id: 11, mandatory: refreshObligation, refreshAfter: 20 * DAY },
      { provider: "tmdb", id: 10, mandatory: refreshObligation, refreshAfter: 20 * DAY },
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
