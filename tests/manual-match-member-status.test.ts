import assert from "node:assert/strict";
import test from "node:test";
import { memberStatus, type CoverageMember, type CoverageOutcome } from "../lib/manual-coverage-model";

const episode = (provider: "TMDB" | "TVDB", id: number, reportMissing = false): CoverageMember => ({
  provider, id, showId: provider === "TMDB" ? 10 : 20, show: "Show", title: `Episode ${id}`, season: 1, episode: id, url: "", ...(reportMissing ? { reportMissing } : {}),
});
const outcome = (member: CoverageMember, status: CoverageOutcome["status"]): CoverageOutcome => ({ provider: member.provider, id: member.id, status, season: 1 });

// A one-to-one Manual Match, and a one-to-many one whose combined TMDB episode 1
// maps to split TVDB episodes 11 and 12.
const single = episode("TMDB", 1), singlePartner = episode("TVDB", 11);
const combined = episode("TMDB", 1), splitA = episode("TVDB", 11), splitB = episode("TVDB", 12);

const reportedA = { ...splitA, reportMissing: true }, reportedB = { ...splitB, reportMissing: true };
const flaggedSingle = { ...single, reportMissing: true };

for (const [label, input, expected] of [
  // Every level, alone.
  ["a member reported missing", { member: flaggedSingle, members: [flaggedSingle, singlePartner], direct: false, matched: [] }, { status: "reported-missing" }],
  ["a combined episode whose split episodes are reported missing", { member: combined, members: [combined, reportedA, reportedB], direct: false, matched: [] }, { status: "incomplete", missingParts: [{ provider: "TVDB", id: 11 }, { provider: "TVDB", id: 12 }] }],
  ["a member a Plex item owns directly", { member: single, members: [single, singlePartner], direct: true, matched: [] }, { status: "direct" }],
  ["a member the comparison found missing", { member: single, members: [single, singlePartner], direct: false, matched: [outcome(single, "missing")] }, { status: "missing" }],
  ["a member satisfied automatically", { member: single, members: [single, singlePartner], direct: false, matched: [outcome(single, "automatic")] }, { status: "automatic" }],
  ["a member covered by a complete alternative set", { member: single, members: [single, singlePartner], direct: false, matched: [outcome(single, "manual")] }, { status: "manual" }],
  ["a member with no outcome of its own", { member: single, members: [single, singlePartner], direct: false, matched: [] }, { status: "alternative" }],
  // Collisions: the higher level wins.
  ["reported missing and incomplete", { member: { ...combined, reportMissing: true }, members: [{ ...combined, reportMissing: true }, reportedA, splitB], direct: false, matched: [] }, { status: "reported-missing" }],
  ["reported missing and directly owned", { member: flaggedSingle, members: [flaggedSingle, singlePartner], direct: true, matched: [outcome(single, "automatic")] }, { status: "reported-missing" }],
  ["incomplete and directly owned", { member: combined, members: [combined, reportedA, splitB], direct: true, matched: [outcome(combined, "automatic")] }, { status: "incomplete", missingParts: [{ provider: "TVDB", id: 11 }] }],
  ["missing and satisfied automatically", { member: single, members: [single, singlePartner], direct: false, matched: [outcome(single, "automatic"), outcome(single, "missing")] }, { status: "missing" }],
  ["missing and covered by a complete alternative set", { member: single, members: [single, singlePartner], direct: false, matched: [outcome(single, "manual"), outcome(single, "missing")] }, { status: "missing" }],
  ["satisfied automatically and covered by a complete alternative set", { member: single, members: [single, singlePartner], direct: false, matched: [outcome(single, "manual"), outcome(single, "automatic")] }, { status: "automatic" }],
  // Missing parts belong only to the combined episode, never to a reported split episode.
  ["a reported split episode of an incomplete combined episode", { member: reportedA, members: [combined, reportedA, splitB], direct: false, matched: [] }, { status: "reported-missing" }],
  ["an unflagged split episode of an incomplete combined episode", { member: splitB, members: [combined, reportedA, splitB], direct: false, matched: [outcome(splitB, "missing")] }, { status: "missing" }],
] as const) {
  test(`member status: ${label}`, () => {
    assert.deepEqual(memberStatus({ ...input, members: [...input.members], matched: [...input.matched] }), expected);
  });
}
