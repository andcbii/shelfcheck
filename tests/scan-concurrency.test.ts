import assert from "node:assert/strict";
import test from "node:test";
import { ActiveScanTracker, ProviderStartGate, runTrackedWorkerPool, runWorkerPool } from "../lib/scan-concurrency";

test("worker pool respects concurrency and completes every item", async () => {
  let active = 0;
  let maximum = 0;
  const completed: number[] = [];
  await runWorkerPool([1, 2, 3, 4, 5], 3, async (item) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    completed.push(item);
    active -= 1;
  });
  assert.equal(maximum, 3);
  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("worker rejection fails the pool", async () => {
  await assert.rejects(runWorkerPool([1, 2], 2, async (item) => { if (item === 2) throw new Error("failed"); }), /failed/);
});

test("provider gate serializes starts at the configured spacing", async () => {
  let now = 0;
  const starts: number[] = [];
  const gate = new ProviderStartGate<string>({
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  await Promise.all([1, 2, 3].map(async () => {
    const slot = await gate.wait("TVDB", 200);
    starts.push(slot.startedAt);
  }));
  assert.deepEqual(starts, [0, 200, 400]);
});

test("provider gate rechecks a rate-limit deadline extended while a request is queued", async () => {
  let now = 0;
  let sleeps = 0;
  const clock = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
      if (sleeps++ === 0) gate.delayUntil("Trakt", 120_000);
    },
  };
  const gate = new ProviderStartGate<string>(clock);
  gate.delayUntil("Trakt", 30_000);
  const slot = await gate.wait("Trakt", 250);
  assert.equal(slot.startedAt, 120_000);
  assert.equal(slot.waitMs, 120_000);
});

test("heartbeat tracker retains all concurrent shows independently", () => {
  const tracker = new ActiveScanTracker();
  tracker.update("a", "Show A", "tmdb");
  tracker.update("b", "Show B", "tvdb");
  tracker.update("a", "Show A", "crosswalk");
  assert.deepEqual(tracker.snapshot().map(({ show, phase }) => ({ show, phase })), [{ show: "Show A", phase: "crosswalk" }, { show: "Show B", phase: "tvdb" }]);
  tracker.remove("a");
  assert.deepEqual(tracker.snapshot().map(({ show }) => show), ["Show B"]);
});

test("tracked scan orchestration publishes active work and always clears completed or failed shows", async () => {
  const tracker = new ActiveScanTracker();
  const snapshots: string[][] = [];
  await assert.rejects(runTrackedWorkerPool(
    [{ key: "a", title: "Show A" }, { key: "b", title: "Show B" }],
    2,
    tracker,
    (item) => ({ key: item.key, show: item.title }),
    async (item) => {
      snapshots.push(tracker.snapshot().map(({ key }) => key).sort());
      await Promise.resolve();
      if (item.key === "b") throw new Error("scan failed");
    },
  ), /scan failed/);
  assert.ok(snapshots.some((snapshot) => snapshot.join(",") === "a,b"));
  assert.deepEqual(tracker.snapshot(), []);
});
