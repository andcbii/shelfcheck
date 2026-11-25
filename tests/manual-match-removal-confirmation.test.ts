import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { CoverageMapping, CoverageMember } from "../lib/manual-coverage-model";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { confirmRemovalCandidates } = await import("../lib/manual-match-removal-confirmation");
const { ProviderCooldownTooLongError, ProviderHttpError, ProviderNetworkError } = await import("../lib/provider-client");
hook.deregister();

// A removal candidate is removed only when its provider confirms the episode gone (ADR-0008); any
// lookup that cannot answer keeps it. The full-scan workflow covers 404, moved series and 5xx.
const member = (provider: "TMDB" | "TVDB", id: number): CoverageMember => ({ provider, id, showId: 20, show: "Target", title: "One", season: 1, episode: 1, url: "https://example.invalid" });
const tvdb = member("TVDB", 201), tmdb = member("TMDB", 101);
const mapping: CoverageMapping = { id: "m1", revision: 3, members: [tmdb, tvdb], createdAt: "2026-01-01T00:00:00.000Z" };
const proposal = (item: CoverageMember) => ({ mappingId: "m1", member: { provider: item.provider, id: item.id }, expectedRevision: 3 });

test("a candidate whose lookup times out, hits a cooldown or cannot sign in is kept", async () => {
  for (const error of [new ProviderNetworkError("TVDB"), new ProviderCooldownTooLongError("TVDB", 3_600_000, { reason: "server", deadline: Date.now() + 3_600_000, status: 503 }), new ProviderHttpError("TVDB", 401), new Error("TVDB sign-in failed")]) {
    const [confirmation] = await confirmRemovalCandidates([proposal(tvdb)], [mapping], () => Promise.reject(error));
    assert.deepEqual([confirmation.gone, confirmation.reason], [false, "lookup-failed"], error.message);
  }
});

test("a TMDB candidate is removed when its numbers now name another episode, and kept when they name it", async () => {
  const [moved] = await confirmRemovalCandidates([proposal(tmdb)], [mapping], async () => ({ id: 999 }));
  assert.deepEqual([moved.gone, moved.reason], [true, "different-episode"]);
  const [still] = await confirmRemovalCandidates([proposal(tmdb)], [mapping], async () => ({ id: 101 }));
  assert.deepEqual([still.gone, still.reason], [false, "still-at-provider"]);
});

test("each candidate is looked up once, however many shows proposed it", async () => {
  const looked: number[] = [];
  const confirmations = await confirmRemovalCandidates([proposal(tvdb), proposal(tvdb), proposal(tmdb)], [mapping], async item => { looked.push(item.id); return Promise.reject(new ProviderHttpError(item.provider, 404)); });
  assert.deepEqual(looked.sort(), [101, 201]);
  assert.deepEqual(confirmations.map(item => [item.proposal.member.id, item.gone, item.reason]), [[201, true, "not-found"], [101, true, "not-found"]]);
});
