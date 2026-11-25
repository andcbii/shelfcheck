import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { CoverageMapping, CoverageMember } from "../lib/manual-coverage-model";
import type { ProviderLookup } from "../lib/provider-lookup";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { fullScanProviderYears } = await import("../lib/show-year");
hook.deregister();

// A completed full scan's year lookups of Manual Match shows it did not visit (ADR-0008, SHELFCHECK-205)
// go a few at a time, never one request per show all at once.
const member = (provider: "TMDB" | "TVDB", showId: number): CoverageMember => ({ provider, id: showId * 100 + 1, showId, show: `Show ${showId}`, title: "Pilot", season: 1, episode: 1, url: "https://example.invalid" });

test("unvisited Manual Match shows are looked up a few at a time, each once", async () => {
  const mappings: CoverageMapping[] = Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, revision: 1, createdAt: "2026-11-25T00:00:00Z", members: [member("TMDB", 10 + index), member("TVDB", 20 + index)] }));
  const flight = { now: 0, most: 0 };
  const asked: ProviderLookup[] = [];
  const transport = async (lookup: ProviderLookup) => {
    asked.push(lookup);
    flight.most = Math.max(flight.most, ++flight.now);
    await new Promise(resolve => setTimeout(resolve, 5));
    flight.now--;
    return lookup.kind === "tvdb-series-summary" ? { data: { year: "1999" } } : { first_air_date: "1999-01-01" };
  };
  await fullScanProviderYears(mappings).lookUpUnvisited([], transport, () => assert.fail("no lookup fails"));
  assert.equal(asked.length, 12, "each of the twelve shows once");
  assert.ok(flight.most > 1, `lookups overlap (${flight.most})`);
  assert.ok(flight.most <= 3, `at most three at once (${flight.most})`);
});
