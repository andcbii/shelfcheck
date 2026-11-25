import assert from "node:assert/strict";
import test from "node:test";
import { mountPaused, paused } from "../scan-progress-harness";

// Run by tests/fixed-zone-matrix.test.ts with TZ set before this file is imported.
const zone = process.env.TZ ?? "";
// The same pause end, 2026-11-24T22:32:00Z, as each zone's local HH:MM.
const resumeTimes: Record<string, string> = { "America/Los_Angeles": "14:32", "Australia/Sydney": "09:32" };

test(`${zone}: a rate-limit pause shows its resume time as local HH:MM on both pages`, async (t) => {
  assert.ok(resumeTimes[zone], `no case for TZ=${zone}`);
  for (const [page, provider] of [["trakt", "Trakt"], ["plex", "TVDB"]] as const) {
    await t.test(page, async (t) => {
      const view = await mountPaused(t, page, paused(provider, "2026-11-24T22:32:00.000Z"));
      assert.equal(view.notes(), `Paused: ${provider} rate limit. Resumes at ${resumeTimes[zone]}.`);
    });
  }
});
