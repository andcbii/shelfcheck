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
    error => error === persistence,
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
