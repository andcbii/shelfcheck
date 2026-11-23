import assert from "node:assert/strict";
import test from "node:test";
import { reportedOrIncomplete } from "../lib/manual-coverage-model";
import { episode } from "./manual-match-members";

// A one-to-many Manual Match: combined TMDB episode 1 maps to split TVDB episodes 11 and 12.
const combined = episode("TMDB", 1), splitA = episode("TVDB", 11), splitB = episode("TVDB", 12);

test("reported or incomplete: a member reported missing is reported", () => {
  const members = [episode("TMDB", 1, true), episode("TVDB", 11)];
  assert.deepEqual(reportedOrIncomplete(members, { provider: "TMDB", id: 1 }), { status: "reported-missing" });
});

test("reported or incomplete: a combined episode with reported split episodes is incomplete with those parts", () => {
  const members = [combined, episode("TVDB", 11, true), splitB];
  assert.deepEqual(reportedOrIncomplete(members, { provider: "TMDB", id: 1 }), { status: "incomplete", missingParts: [{ provider: "TVDB", id: 11 }] });
});

test("reported or incomplete: an unflagged member that is not incomplete is neither", () => {
  assert.equal(reportedOrIncomplete([combined, splitA, splitB], { provider: "TMDB", id: 1 }), undefined);
  assert.equal(reportedOrIncomplete([combined, episode("TVDB", 11, true), splitB], { provider: "TVDB", id: 12 }), undefined);
});

test("reported or incomplete: reported wins over incomplete", () => {
  const members = [episode("TMDB", 1, true), episode("TVDB", 11, true), splitB];
  assert.deepEqual(reportedOrIncomplete(members, { provider: "TMDB", id: 1 }), { status: "reported-missing" });
});

test("reported or incomplete: a member outside the Manual Match is neither", () => {
  assert.equal(reportedOrIncomplete([episode("TMDB", 1, true), splitA], { provider: "TVDB", id: 99 }), undefined);
});
