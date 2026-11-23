import assert from "node:assert/strict";
import test from "node:test";
import { liveTmdbCrosswalkDecision, replayedTmdbCrosswalkDecision } from "../lib/tmdb-crosswalk-policy";

const SCAN_STARTED = "2026-06-01T23:30:00.000Z";
const MATCH = { tv_episode_results: [{ id: 901, show_id: 10 }] };

test("a live scan reuses a usable shared answer received on the scan's starting UTC date", () => {
  const shared = { value: MATCH, receivedAt: "2026-06-01T00:00:00.000Z" };
  assert.deepEqual(
    liveTmdbCrosswalkDecision({ shared, scanStartedAt: SCAN_STARTED, forced: false, requestedInThisScan: false }),
    { action: "reuse", copy: { value: MATCH, receivedAt: "2026-06-01T00:00:00.000Z" } },
  );
});

const EMPTY = { tv_episode_results: [] };
const usable = (receivedAt: string, value: unknown = MATCH) => ({ value, receivedAt });
const ordinary = { forced: false, requestedInThisScan: false };

for (const [label, scanStartedAt, shared, mode, expected] of [
  // Midnight is the scan's starting UTC date, not the current time.
  ["received one millisecond before the starting UTC date", "2026-06-01T23:30:00.000Z", usable("2026-05-31T23:59:59.999Z"), ordinary, "request"],
  ["received at midnight on the starting UTC date", "2026-06-01T23:30:00.000Z", usable("2026-06-01T00:00:00.000Z"), ordinary, "reuse"],
  ["received after midnight during a scan that started the day before", "2026-06-01T23:30:00.000Z", usable("2026-06-02T00:10:00.000Z"), ordinary, "reuse"],
  ["received on a later scan's receipt date, by a scan that crossed midnight", "2026-06-02T08:00:00.000Z", usable("2026-06-02T00:10:00.000Z"), ordinary, "reuse"],
  ["received the day before a later scan", "2026-06-03T00:00:00.000Z", usable("2026-06-02T23:59:59.999Z"), ordinary, "request"],
  ["received in another zone's offset on the starting UTC date", "2026-06-01T23:30:00.000Z", usable("2026-06-01T08:00:00.000+05:00"), ordinary, "reuse"],
  ["received in another zone's offset on the previous UTC date", "2026-06-01T23:30:00.000Z", usable("2026-06-01T02:00:00.000+05:00"), ordinary, "request"],
  ["a valid empty answer received on the starting UTC date", "2026-06-01T23:30:00.000Z", usable("2026-06-01T01:00:00.000Z", EMPTY), ordinary, "reuse"],
  ["a valid empty answer received the day before", "2026-06-01T23:30:00.000Z", usable("2026-05-31T23:00:00.000Z", EMPTY), ordinary, "request"],
  ["no shared evidence", "2026-06-01T23:30:00.000Z", undefined, ordinary, "request"],
  ["an undated shared response", "2026-06-01T23:30:00.000Z", { value: MATCH }, ordinary, "request"],
  ["an unparseable receipt time", "2026-06-01T23:30:00.000Z", { value: MATCH, receivedAt: "not a time" }, ordinary, "request"],
  ["a rejected request", "2026-06-01T23:30:00.000Z", { rejectedAt: "2026-06-01T23:40:00.000Z" }, ordinary, "request"],
  ["an unreadable payload kept with its rejection", "2026-06-01T23:30:00.000Z", { value: { results: "?" }, rejectedAt: "2026-06-01T23:40:00.000Z" }, ordinary, "request"],
  ["a current answer marked not current by a show's Clear cache", "2026-06-01T23:30:00.000Z", { ...usable("2026-06-01T23:00:00.000Z"), invalidatedAt: "2026-06-01T23:10:00.000Z" }, ordinary, "request"],
  // Forced lookups accept only an answer requested in this scan, whatever its date.
  ["forced: a current answer not requested in this scan", "2026-06-01T23:30:00.000Z", usable("2026-06-01T23:40:00.000Z"), { forced: true, requestedInThisScan: false }, "request"],
  ["forced: an answer requested in this scan", "2026-06-01T23:30:00.000Z", usable("2026-06-01T23:40:00.000Z"), { forced: true, requestedInThisScan: true }, "reuse"],
  ["forced: a rejection requested in this scan", "2026-06-01T23:30:00.000Z", { rejectedAt: "2026-06-01T23:40:00.000Z" }, { forced: true, requestedInThisScan: true }, "request"],
  ["forced: an invalidated answer requested in this scan", "2026-06-01T23:30:00.000Z", { ...usable("2026-06-01T23:40:00.000Z"), invalidatedAt: "2026-06-01T23:45:00.000Z" }, { forced: true, requestedInThisScan: true }, "request"],
  ["ordinary: having requested the lookup in this scan does not make a stale answer current","2026-06-01T23:30:00.000Z", usable("2026-05-31T12:00:00.000Z"), { forced: false, requestedInThisScan: true }, "request"],
] as const) {
  test(`live scan: ${label} → ${expected}`, () => {
    const decision = liveTmdbCrosswalkDecision({ shared, scanStartedAt, ...mode });
    if (expected === "request") assert.deepEqual(decision, { action: "request" });
    // Reuse never renews the receipt time: the copy carries the shared response as received.
    else assert.deepEqual(decision, { action: "reuse", copy: { value: shared!.value, receivedAt: shared!.receivedAt } });
  });
}

const OWN = { tv_episode_results: [{ id: 800, show_id: 10 }] };
const UNREADABLE = { tv_episode_results: "not a list" };
const T = (hhmm: string) => `2026-06-01T${hhmm}:00.000Z`;

test("a cached recheck replays a newer usable shared answer in place of its older copy, keeping the shared receipt time", () => {
  assert.deepEqual(
    replayedTmdbCrosswalkDecision({ copy: { value: OWN, receivedAt: T("08:00") }, shared: usable(T("09:00")), failure: undefined }),
    { action: "replay-shared", copy: { value: MATCH, receivedAt: T("09:00") } },
  );
});

const copyAt = (receivedAt?: string) => receivedAt === undefined ? { value: OWN } : { value: OWN, receivedAt };
const REPLAY_SHARED = { action: "replay-shared", copy: { value: MATCH, receivedAt: T("09:00") } } as const;

for (const [label, copy, shared, expected] of [
  ["no shared evidence keeps the copy", copyAt(T("08:00")), undefined, { action: "replay-copy" }],
  ["an undated shared response keeps the copy", copyAt(T("08:00")), { value: MATCH }, { action: "replay-copy" }],
  ["an older shared answer keeps the copy", copyAt(T("10:00")), usable(T("09:00")), { action: "replay-copy" }],
  ["a shared answer received at the same time keeps the copy", copyAt(T("09:00")), usable(T("09:00")), { action: "replay-copy" }],
  ["a shared answer one millisecond newer replaces the copy", copyAt("2026-06-01T08:59:59.999Z"), usable(T("09:00")), REPLAY_SHARED],
  ["an undated copy counts as older than a shared answer", copyAt(), usable(T("09:00")), REPLAY_SHARED],
  ["an unparseable copy time counts as older", copyAt("not a time"), usable(T("09:00")), REPLAY_SHARED],
  ["a newer valid empty answer replaces the copy", copyAt(T("08:00")), usable(T("09:00"), EMPTY), { action: "replay-shared", copy: { value: EMPTY, receivedAt: T("09:00") } }],
  ["a show's Clear cache mark does not stop replay of the newer answer", copyAt(T("08:00")), { ...usable(T("09:00")), invalidatedAt: T("09:30") }, REPLAY_SHARED],
  ["a show's Clear cache mark does not revive an older copy over it", copyAt(T("10:00")), { ...usable(T("09:00")), invalidatedAt: T("11:00") }, { action: "replay-copy" }],
  ["a newer failed request drops the copy", copyAt(T("08:00")), { rejectedAt: T("09:00") }, { action: "drop" }],
  ["a newer failed request drops an undated copy", copyAt(), { rejectedAt: T("09:00") }, { action: "drop" }],
  ["a failed request at the same time keeps the copy", copyAt(T("09:00")), { rejectedAt: T("09:00") }, { action: "replay-copy" }],
  ["an older failed request keeps the copy", copyAt(T("10:00")), { rejectedAt: T("09:00") }, { action: "replay-copy" }],
  ["a newer unreadable payload replaces the copy without a receipt time", copyAt(T("08:00")), { value: UNREADABLE, rejectedAt: T("09:00") }, { action: "replay-shared", copy: { value: UNREADABLE } }],
] as const) {
  test(`cached recheck with a copy: ${label}`, () => {
    assert.deepEqual(replayedTmdbCrosswalkDecision({ copy, shared, failure: undefined }), expected);
  });
}

test("cached recheck with a copy: an open failed request does not change the replay", () => {
  assert.deepEqual(replayedTmdbCrosswalkDecision({ copy: copyAt(T("08:00")), shared: usable(T("07:00")), failure: { open: true, failedAt: T("07:30") } }), { action: "replay-copy" });
  assert.deepEqual(replayedTmdbCrosswalkDecision({ copy: copyAt(T("08:00")), shared: usable(T("09:00")), failure: { open: true, failedAt: T("09:30") } }), REPLAY_SHARED);
});

const RECOVER = { action: "recover", copy: { value: MATCH, receivedAt: T("09:00") } } as const;
for (const [label, shared, failure, expected] of [
  ["a usable answer received after the recorded failure is recovered", usable(T("09:00")), { open: true, failedAt: T("08:00") }, RECOVER],
  ["one millisecond after the recorded failure is recovered", usable(T("09:00")), { open: true, failedAt: "2026-06-01T08:59:59.999Z" }, RECOVER],
  ["a valid empty answer after the recorded failure is recovered", usable(T("09:00"), EMPTY), { open: true, failedAt: T("08:00") }, { action: "recover", copy: { value: EMPTY, receivedAt: T("09:00") } }],
  ["an invalidated answer after the recorded failure is still recovered", { ...usable(T("09:00")), invalidatedAt: T("10:00") }, { open: true, failedAt: T("08:00") }, RECOVER],
  ["an answer received at the failure time is not recovered", usable(T("09:00")), { open: true, failedAt: T("09:00") }, { action: "unavailable" }],
  ["an answer received before the failure is not recovered", usable(T("09:00")), { open: true, failedAt: T("10:00") }, { action: "unavailable" }],
  ["an undated failure never recovers", usable(T("09:00")), { open: true }, { action: "unavailable" }],
  ["an unparseable failure time never recovers", usable(T("09:00")), { open: true, failedAt: "not a time" }, { action: "unavailable" }],
  ["no recorded failure never recovers", usable(T("09:00")), undefined, { action: "unavailable" }],
  ["a later rejection is not recovered", { rejectedAt: T("09:00") }, { open: true, failedAt: T("08:00") }, { action: "unavailable" }],
  ["a later unreadable payload is not recovered", { value: UNREADABLE, rejectedAt: T("09:00") }, { open: true, failedAt: T("08:00") }, { action: "unavailable" }],
  ["an undated shared response is not recovered", { value: MATCH }, { open: true, failedAt: T("08:00") }, { action: "unavailable" }],
  ["no shared evidence leaves the copy unavailable", undefined, { open: true, failedAt: T("08:00") }, { action: "unavailable" }],
] as const) {
  test(`cached recheck without a copy: ${label}`, () => {
    assert.deepEqual(replayedTmdbCrosswalkDecision({ copy: undefined, shared, failure }), expected);
  });
}
