import assert from "node:assert/strict";
import test from "node:test";
import { memberStatus, type CoverageIdentity, type CoverageMember, type CoverageOutcome, type MemberStatus } from "../lib/manual-coverage-model";
import { episode, identity } from "./manual-match-members";

const outcome = (member: CoverageIdentity, status: CoverageOutcome["status"]): Pick<CoverageOutcome, "status"> & CoverageIdentity => ({ ...identity(member), status });

// TMDB episode 1 matches TVDB episode 11 one-to-one, or, as a combined episode,
// split TVDB episodes 11 and 12 one-to-many. `reported…` members carry a saved flag.
const tmdb1 = episode("TMDB", 1), tvdb11 = episode("TVDB", 11), tvdb12 = episode("TVDB", 12);
const reportedTmdb1 = episode("TMDB", 1, true), reportedTvdb11 = episode("TVDB", 11, true), reportedTvdb12 = episode("TVDB", 12, true);
const oneToOne = [tmdb1, tvdb11];

const cases: [label: string, input: { member: CoverageIdentity; members: CoverageMember[]; direct: boolean; matched: Pick<CoverageOutcome, "status">[] }, expected: { status: MemberStatus; missingParts?: CoverageIdentity[] }][] = [
  // Every level, alone.
  ["a member reported missing", { member: tmdb1, members: [reportedTmdb1, tvdb11], direct: false, matched: [] }, { status: "reported-missing" }],
  ["a combined episode whose split episodes are reported missing", { member: tmdb1, members: [tmdb1, reportedTvdb11, reportedTvdb12], direct: false, matched: [] }, { status: "incomplete", missingParts: [{ provider: "TVDB", id: 11 }, { provider: "TVDB", id: 12 }] }],
  ["a member a Plex item owns directly", { member: tmdb1, members: oneToOne, direct: true, matched: [] }, { status: "direct" }],
  ["a member the comparison found missing", { member: tmdb1, members: oneToOne, direct: false, matched: [outcome(tmdb1, "missing")] }, { status: "missing" }],
  ["a member satisfied automatically", { member: tmdb1, members: oneToOne, direct: false, matched: [outcome(tmdb1, "automatic")] }, { status: "automatic" }],
  ["a member covered by a complete alternative set", { member: tmdb1, members: oneToOne, direct: false, matched: [outcome(tmdb1, "manual")] }, { status: "manual" }],
  ["a member with no outcome of its own", { member: tmdb1, members: oneToOne, direct: false, matched: [] }, { status: "alternative" }],
  // Collisions: the higher level wins.
  ["reported missing and incomplete", { member: tmdb1, members: [reportedTmdb1, reportedTvdb11, tvdb12], direct: false, matched: [] }, { status: "reported-missing" }],
  ["reported missing and directly owned", { member: tmdb1, members: [reportedTmdb1, tvdb11], direct: true, matched: [outcome(tmdb1, "automatic")] }, { status: "reported-missing" }],
  ["incomplete and directly owned", { member: tmdb1, members: [tmdb1, reportedTvdb11, tvdb12], direct: true, matched: [outcome(tmdb1, "automatic")] }, { status: "incomplete", missingParts: [{ provider: "TVDB", id: 11 }] }],
  ["missing and satisfied automatically", { member: tmdb1, members: oneToOne, direct: false, matched: [outcome(tmdb1, "automatic"), outcome(tmdb1, "missing")] }, { status: "missing" }],
  ["missing and covered by a complete alternative set", { member: tmdb1, members: oneToOne, direct: false, matched: [outcome(tmdb1, "manual"), outcome(tmdb1, "missing")] }, { status: "missing" }],
  ["satisfied automatically and covered by a complete alternative set", { member: tmdb1, members: oneToOne, direct: false, matched: [outcome(tmdb1, "manual"), outcome(tmdb1, "automatic")] }, { status: "automatic" }],
  // Missing parts belong only to the combined episode, never to a reported split episode.
  ["a reported split episode of an incomplete combined episode", { member: tvdb11, members: [tmdb1, reportedTvdb11, tvdb12], direct: false, matched: [] }, { status: "reported-missing" }],
  ["an unflagged split episode of an incomplete combined episode", { member: tvdb12, members: [tmdb1, reportedTvdb11, tvdb12], direct: false, matched: [outcome(tvdb12, "missing")] }, { status: "missing" }],
];

for (const [label, input, expected] of cases) {
  test(`member status: ${label}`, () => {
    // The member is passed by identity only, so its status comes from the flags saved in `members`.
    assert.deepEqual(memberStatus({ ...input, member: identity(input.member) }), expected);
  });
}
