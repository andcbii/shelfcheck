import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SeriesAssociation } from "../lib/comparison-catalogue-resolver";
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

test("a preferred failure sets the refresh obligation only after candidate choice, so the first fallback reuses its recent saved copy", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source });

  assert.deepEqual(requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, false], [10, false]]);
  assert.equal(resolved.tmdb.catalogue?.origin, "reused");
  assert.equal(resolved.tmdb.obligation, "set");
  assert.equal(resolved.tvdb.obligation, "unchanged");
});

test("an open refresh obligation makes every attempted candidate a mandatory download, and only a downloaded preferred catalogue clears it", async () => {
  const preferredDownloads = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved } });
  const cleared = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: preferredDownloads.source });
  assert.equal(cleared.tmdb.catalogue?.origin, "downloaded");
  assert.equal(cleared.tmdb.obligation, "clear");

  const fallbackDownloads = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const kept = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: fallbackDownloads.source });
  assert.deepEqual(fallbackDownloads.requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, true]]);
  assert.equal(kept.tmdb.catalogue?.id, 11, "the preferred saved copy is still within 60 days");
  assert.equal(kept.tmdb.obligation, "unchanged");

  const tooOld = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 11: notFound(11) } } });
  const fallback = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: tooOld.source });
  assert.deepEqual(tooOld.requests.filter(r => r.provider === "tmdb").map(r => [r.id, r.mandatory]), [[11, true], [10, true]]);
  assert.deepEqual([fallback.tmdb.catalogue?.id, fallback.tmdb.catalogue?.origin], [10, "downloaded"]);
  assert.equal(fallback.tmdb.obligation, "unchanged", "a fallback download does not clear the obligation");
});

test("a reused preferred catalogue never clears a refresh obligation", async () => {
  const { source: reusing } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(DAY), 11: before(DAY) }, tvdb: tvdbSaved } });
  // A source whose own freshness policy reuses the preferred catalogue despite the mandatory setting.
  const source = { ...reusing, async loadCatalogue(provider: "tmdb" | "tvdb", id: number) { const saved = reusing.savedCatalogue(provider, id)!; return { outcome: "reused" as const, ...saved }; } };
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, tvdbOnly), { source: source as typeof reusing });
  assert.equal(resolved.tmdb.catalogue?.origin, "reused");
  assert.equal(resolved.tmdb.obligation, "unchanged");
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
      events.push(`patch ${provider} ${obligation}`);
      if (provider === "tmdb") await acknowledged;
      events.push(`acknowledged ${provider}`);
    },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ["load tmdb 11", "load tmdb 10", "patch tmdb set"], "TVDB waits for the TMDB patch to be acknowledged");

  acknowledge();
  const resolved = await resolving;
  assert.deepEqual(events, ["load tmdb 11", "load tmdb 10", "patch tmdb set", "acknowledged tmdb", "load tvdb 1", "patch tvdb unchanged", "acknowledged tvdb"]);
  assert.equal(resolved.tmdb.obligation, "set");
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

test("a pending outcome leaves acknowledged obligation changes as they were sent, once each", async () => {
  const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(61 * DAY) }, tvdb: tvdbSaved }, failing: { tmdb: { 10: notFound(10), 11: notFound(11) } } });
  const patches: unknown[] = [];
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, tvdbOnly), { source, onProviderResolved: async progress => { patches.push(progress); } });

  assert.equal(resolved.outcome, "pending");
  assert.deepEqual(patches, [{ provider: "tmdb", obligation: "set" }, { provider: "tvdb", obligation: "unchanged" }]);
  assert.deepEqual([resolved.tmdb.obligation, resolved.tvdb.obligation], ["set", "unchanged"]);
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

test("a TMDB catalogue that names no TVDB series leaves TVDB with no derived series", async () => {
  const { source, requests } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved } });
  const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, noTvdb), { source });

  assert.equal(resolved.outcome, "comparable");
  assert.equal(resolved.tvdb.identity, undefined);
  assert.deepEqual(resolved.tvdb.use, { action: "clear" });
  assert.deepEqual(resolved.tvdb.issues, [{ action: "resolve", id: "catalogue-refresh:TVDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TVDB:show-1" }]);
  assert.ok(!requests.some(r => r.provider === "tvdb"));
});

test("a known-empty association means no derived TMDB series, while one missing even when requested leaves the comparison pending", async () => {
  const empty = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: tvdbSaved }, associations: { 1: { outcome: "known-empty" } } });
  const none = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source: empty.source });
  assert.equal(none.outcome, "comparable", "TVDB alone is compared");
  assert.equal(none.tmdb.identity, undefined);
  assert.deepEqual(none.tmdb.use, { action: "clear" });
  assert.equal(none.tmdb.obligation, "unchanged");
  assert.deepEqual(none.tmdb.issues, [{ action: "resolve", id: "catalogue-refresh:TMDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" }]);
  assert.ok(!empty.requests.some(r => r.provider === "tmdb"));

  const missing = inMemoryCatalogueSource({ now: NOW, saved: { tvdb: tvdbSaved } });
  const pending = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source: missing.source });
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.tmdb.identity, undefined);
  assert.deepEqual(pending.tmdb.use, { action: "unchanged" });
  assert.deepEqual(pending.tmdb.issues, preserved("tmdb"));
  assert.equal(pending.tmdb.obligation, "unchanged");
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
  assert.equal(resolved.tmdb.obligation, "set");
  assert.equal(resolved.tmdb.warning, "TMDB request failed (503).");
  const issue = resolved.tmdb.issues[0];
  assert.equal(issue.action, "set");
  if (issue.action !== "set") return;
  assert.equal(issue.issue.id, "catalogue-refresh:TMDB:show-1");
  assert.deepEqual(issue.issue.show, { ratingKey: "show-1", title: "Example Show", tmdbId: undefined, tvdbId: 1 });
  assert.deepEqual(issue.issue.lookup?.source, [{ provider: "Plex", kind: "TVDB series", id: 1 }]);
  assert.deepEqual(issue.issue.lookup?.requested, { provider: "TMDB", kind: "TVDB ID search", id: 1 });
  assert.equal(issue.issue.lookup?.impact, "TMDB episode coverage could not be fully verified. Last-good catalogue data was retained. Last-good comparison results remain available.");
});

test("a TMDB series resolved before its download fails is kept, with its provenance, in the Coverage Issue", async () => {
  for (const resolvedId of [undefined, 51]) {
    const { source } = inMemoryCatalogueSource({
      now: NOW, saved: { tvdb: tvdbSaved }, associations: { 1: { outcome: "found", id: 50, cached: true } },
      failing: { tmdb: { 50: { ...notFound(resolvedId ?? 50), ...(resolvedId ? { resolvedId } : {}) } } },
    });
    const resolved = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source });
    const id = resolvedId ?? 50;

    assert.equal(resolved.outcome, "pending");
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
    assert.equal(resolved.tvdb.obligation, "unchanged", "an obligation already open stays open");
    assert.deepEqual(resolved.tvdb.use, { action: "set", use: { usingId: 7, state: "derived", derivedFrom: 11, ...(savedAt ? { usingDownloadedAt: savedAt } : {}) } });
    assert.equal(resolved.outcome, savedAt ? "comparable" : "pending");
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
  assert.equal(resolved.tvdb.obligation, "set");
  assert.equal(resolved.tvdb.warning, "TVDB is down.");
});

test("a downloaded derived series clears its open refresh obligation; a reused one does not", async () => {
  for (const obligation of [true, false]) {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: tmdbSaved, tvdb: { 7: before(DAY) } }, tvdbOfTmdb: { 11: 7 } });
    // The production reuse policy reuses a young saved copy unless the obligation makes the load mandatory.
    const resolved = await resolveComparisonCatalogues(request({ candidates: [10, 11], preferredId: 11 }, { candidates: [], refreshObligation: obligation }), { source });
    assert.equal(resolved.tvdb.catalogue?.origin, obligation ? "downloaded" : "reused");
    assert.equal(resolved.tvdb.obligation, obligation ? "clear" : "unchanged");
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
      events.push(`patch ${provider} ${obligation}`);
      if (provider === "tvdb") await acknowledged;
      events.push(`acknowledged ${provider}`);
    },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ["load tvdb 1", "load tvdb 3", "patch tvdb set"], "TMDB waits for the TVDB patch to be acknowledged");

  acknowledge();
  await resolving;
  assert.deepEqual(events, ["load tvdb 1", "load tvdb 3", "patch tvdb set", "acknowledged tvdb", "association 3", "load tmdb 50", "patch tmdb unchanged", "acknowledged tmdb"]);
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

test("with TVDB chosen first and unavailable, TMDB is still derived from the preferred TVDB series and compared, and the live outcome is pending", async () => {
  const { source, associationRequests } = inMemoryCatalogueSource({
    now: NOW, saved: { tmdb: { 50: before(DAY) }, tvdb: { 1: before(61 * DAY) } },
    failing: { tvdb: { 1: notFound(1), 3: notFound(3) } }, associations: { 1: { outcome: "found", id: 50, cached: false } },
  });
  const patches: unknown[] = [];
  const resolved = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source, onProviderResolved: async progress => { patches.push(progress); } });

  assert.equal(resolved.outcome, "pending");
  assert.deepEqual(associationRequests, [{ tvdbId: 1, mandatory: false }]);
  assert.deepEqual([resolved.tvdb.identity, resolved.tvdb.catalogue], [1, undefined]);
  assert.deepEqual(resolved.tvdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }]);
  assert.equal(resolved.tvdb.issues[0].action, "set");
  assert.deepEqual(resolved.tvdb.use, { action: "set", use: { preferredId: 1, state: "unavailable", preferredDownloadedAt: before(61 * DAY), preferredUsableUntil: usableUntil(before(61 * DAY)), preferredFailedAt: NOW } });
  assert.deepEqual([resolved.tmdb.identity, resolved.tmdb.catalogue?.id], [50, 50], "TMDB's independent work still happens");
  assert.deepEqual(resolved.tmdb.use, { action: "set", use: { usingId: 50, state: "derived", derivedFrom: 1, usingDownloadedAt: before(DAY) } });
  assert.deepEqual(resolved.tmdb.issues, [{ action: "resolve", id: "catalogue-refresh:TMDB:show-1" }, { action: "resolve", id: "catalogue-fallback-refresh:TMDB:show-1" }]);
  assert.deepEqual(resolved.unavailableCauses, ["catalogue-refresh:TVDB:show-1"]);
  assert.deepEqual(patches, [{ provider: "tvdb", obligation: "set" }, { provider: "tmdb", obligation: "unchanged" }]);
});

test("a pending outcome lists the comparison-inputs issue's causes and the warnings in resolution order, while comparison order stays TMDB then TVDB", async () => {
  const tmdbDown = { error: new Error("TMDB is down.") };
  const { source } = inMemoryCatalogueSource({
    now: NOW, saved: { tvdb: { 3: before(DAY) } },
    failing: { tvdb: { 1: { error: new Error("TVDB is down.") } }, tmdb: { 50: tmdbDown } }, associations: { 3: { outcome: "found", id: 50, cached: false } },
  });
  const tvdbFirst = await resolveComparisonCatalogues(request(noTmdb, tvdbOnly), { source });
  assert.equal(tvdbFirst.outcome, "pending");
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
    assert.equal(resolved[provider].obligation, "unchanged");
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

  const none = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 10: before(61 * DAY), 11: before(61 * DAY) }, tvdb: tvdbSaved } });
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
  assert.equal(changed.tvdb.obligation, "unchanged");

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
  const resolved = await resolveComparisonCatalogues(cachedRequest({ candidates: [10, 11], preferredId: 11, refreshObligation: true }, { ...tvdbOnly, refreshObligation: true }, {}, { tmdbId: 10, tvdbId: 1 }), { source, onProviderResolved: async patch => { progress.push(patch); } });
  assert.equal(resolved.outcome, "comparable");
  assert.deepEqual(progress, [{ provider: "tmdb", obligation: "unchanged" }, { provider: "tvdb", obligation: "unchanged" }]);
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
  assert.deepEqual([resolved.tmdb.obligation, resolved.tvdb.obligation], ["unchanged", "unchanged"]);
  assert.deepEqual([resolved.unavailableCauses, resolved.warnings], [[], []]);
});

test("a provider with one Plex ID keeps its saved catalogue at any age after a failed lookup, and is unavailable without one", async () => {
  for (const savedAt of [before(60 * DAY + 1), before(400 * DAY), undefined]) {
    const { source } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: savedAt ? { 11: savedAt } : {}, tvdb: { 1: before(DAY) } }, failing: { tmdb: { 11: notFound(11) } } });
    const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11 }, { candidates: [1], preferredId: 1 }), { source });

    assert.equal(resolved.outcome, savedAt ? "comparable" : "pending");
    assert.equal(resolved.tmdb.identity, 11);
    assert.deepEqual(resolved.tmdb.catalogue, savedAt ? { id: 11, origin: "saved", downloadedAt: savedAt, catalogue: { provider: "tmdb", id: 11, downloadedAt: savedAt } } : undefined);
    assert.deepEqual(resolved.tmdb.use, { action: "set", use: savedAt
      ? { preferredId: 11, usingId: 11, preferredDownloadedAt: savedAt, usingDownloadedAt: savedAt, state: "saved-unavailable", preferredFailedAt: NOW }
      : { preferredId: 11, state: "unavailable", preferredFailedAt: NOW } });
    assert.equal(resolved.tmdb.obligation, "set");
    assert.deepEqual(resolved.tmdb.issues, [
      { action: "set", issue: {
        id: "catalogue-refresh:TMDB:show-1", operation: "catalogue-refresh", provider: "TMDB", scope: "show",
        show: { ratingKey: "show-1", title: "Example Show", tmdbId: 11, tvdbId: 1 },
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

  assert.equal(resolved.outcome, "pending");
  assert.equal(resolved.tvdb.obligation, "unchanged", "an obligation already open stays open");
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
    assert.equal(resolved.tmdb.obligation, obligation ? "clear" : "unchanged");
    assert.deepEqual(resolved.tmdb.use, { action: "set", use: { preferredId: 11, usingId: 11, state: "preferred", preferredDownloadedAt: obligation ? NOW : before(DAY), usingDownloadedAt: obligation ? NOW : before(DAY) } });
  }
});

test("with no Plex TMDB ID and one Plex TVDB ID, TMDB is derived from that ID before TVDB loads, as the scan does", async () => {
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

test("a live scan of a show Plex reports no TMDB or TVDB ID for is pending with a warning saying so", async () => {
  const { source, requests, associationRequests } = inMemoryCatalogueSource({ now: NOW });
  const resolved = await resolveComparisonCatalogues(request(noTmdb, noTvdb), { source });

  assert.equal(resolved.outcome, "pending");
  assert.deepEqual(resolved.warnings, ["No TMDB or TVDB ID was exposed by Plex."]);
  assert.deepEqual([requests, associationRequests], [[], []]);
});

test("a load's provenance is the provider's lookup provenance when the load reports one", async () => {
  const { source: inner } = inMemoryCatalogueSource({ now: NOW, saved: { tmdb: { 11: before(DAY) }, tvdb: { 1: before(DAY) } } });
  const provenance = [{ provider: "Plex" as const, kind: "TMDB show" as const, id: 11 }, { provider: "TMDB" as const, kind: "resolved show" as const, id: 11, cached: true }];
  const source: typeof inner = { ...inner, loadCatalogue: async (provider, id, settings) => { const load = await inner.loadCatalogue(provider, id, settings); return provider === "tmdb" && load.outcome !== "failed" ? { ...load, lookupSource: provenance } : load; } };
  const resolved = await resolveComparisonCatalogues(request({ candidates: [11], preferredId: 11 }, { candidates: [1], preferredId: 1 }), { source });

  assert.deepEqual(resolved.tmdb.lookupSource, provenance);
  assert.deepEqual(resolved.tvdb.lookupSource, [{ provider: "Plex", kind: "TVDB series", id: 1 }]);
});
