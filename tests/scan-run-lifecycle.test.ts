import assert from "node:assert/strict";
import test from "node:test";
import { createScanRunLifecycle, type ScanRunContext, type ScanRunMode, type ScanRunOptions, type ScanRunStatus } from "../lib/scan-run";

type Point = { savedAt: string; shows: string[] };
type LogLine = { level: "info" | "warn" | "error"; event: string; details?: Record<string, unknown> };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * A lifecycle with an isolated owner record, a settable clock, manual interval
 * timers, a JSON round-tripping status store (as SQLite stores it) and a Resume
 * point store, plus a recording logger.
 */
function harness(start = Date.parse("2026-11-18T12:00:00.000Z")) {
  let now = start;
  const intervals = new Map<number, () => void>();
  let nextTimer = 1;
  const timers = {
    setInterval: (callback: () => void, milliseconds: number) => { assert.equal(milliseconds, 15_000); const id = nextTimer++; intervals.set(id, callback); return id; },
    clearInterval: (id: unknown) => { intervals.delete(id as number); },
  };
  const runs = createScanRunLifecycle({ clock: { now: () => now }, state: {}, timers });
  let stored: string | null = null;
  let point: Point | null = null;
  const log: LogLine[] = [];
  const interruptions: ScanRunStatus[] = [];
  const failures = { statusWrite: false, interruptionHook: false };
  const mode: ScanRunMode<ScanRunStatus, Point> = {
    kind: "plex",
    eventPrefix: "plex",
    failureMessage: "The Plex scan failed.",
    status: {
      read: () => stored === null ? null : JSON.parse(stored),
      write: (status) => { if (failures.statusWrite) throw new Error("status store unavailable"); stored = JSON.stringify(status); },
    },
    interruptedError: (status) => `Interrupted during ${status.currentPhase || "processing"}.`,
    onInterrupted: (status) => { if (failures.interruptionHook) throw new Error("issue store unavailable"); interruptions.push(status); },
    resumePoint: {
      read: () => point,
      write: (next) => { point = next; },
      clear: () => { point = null; },
      resumeDetails: (saved) => ({ savedAt: saved.savedAt, shows: saved.shows.length }),
      discardDetails: (saved) => ({ savedAt: saved.savedAt, reason: "expired-or-incompatible" }),
    },
  };
  const logger = {
    info: (event: string, details?: Record<string, unknown>) => { log.push({ level: "info", event, details }); },
    warn: (event: string, details?: Record<string, unknown>) => { log.push({ level: "warn", event, details }); },
    error: (event: string, details?: Record<string, unknown>) => { log.push({ level: "error", event, details }); },
  };
  const options = (extra: Partial<ScanRunOptions<Point>> = {}): ScanRunOptions<Point> => ({ fullRun: true, createLogger: () => logger, ...extra });
  /** Starts a Plex Scan run whose body is `body`. */
  const startRun = (body: (run: ScanRunContext<Point>) => Promise<void>, extra: Partial<ScanRunOptions<Point>> = {}) =>
    runs.start("plex", (owner) => runs.run(owner, mode, options(extra), body));
  return {
    runs, mode, log, interruptions, failures, startRun,
    events: () => log.map((line) => line.event),
    status: () => mode.status.read(),
    setStatus: (status: ScanRunStatus | null) => { stored = status === null ? null : JSON.stringify(status); },
    get point() { return point; },
    set point(next: Point | null) { point = next; },
    advance: (milliseconds: number) => { now += milliseconds; },
    /** Fires every live 15-second heartbeat once, as an interval tick would. */
    tick: () => { now += 15_000; for (const callback of [...intervals.values()]) callback(); },
    timerCount: () => intervals.size,
    iso: (offset = 0) => new Date(start + offset).toISOString(),
  };
}

test("a Scan run starts clean: a fresh running status replaces the previous run's leftovers", async () => {
  const h = harness();
  h.setStatus({ status: "error", processed: 7, total: 9, startedAt: "2026-11-17T10:00:00.000Z", finishedAt: "2026-11-17T10:05:00.000Z", error: "old failure", rateLimitPaused: true, rateLimitProvider: "TVDB", activeShows: [{ key: "1", show: "Old", phase: "x" }], currentShow: "Old" });
  const work = deferred();
  h.startRun(async () => { await work.promise; }, { phase: "initializing", startDetails: { mode: "full" } });
  await Promise.resolve();
  assert.deepEqual(h.status(), { status: "running", processed: 0, total: 0, startedAt: h.iso(), currentPhase: "initializing", heartbeatAt: h.iso() });
  assert.deepEqual(h.log[0], { level: "info", event: "plex.scan.start", details: { startedAt: h.iso(), mode: "full" } });
  work.resolve();
});

test("a start over a stored running status logs the earlier run as interrupted before starting", async () => {
  const h = harness();
  h.setStatus({ status: "running", processed: 3, total: 9, startedAt: "2026-11-17T10:00:00.000Z", heartbeatAt: "2026-11-17T10:01:00.000Z", currentPhase: "processing" });
  await h.startRun(async () => {}).settled;
  assert.deepEqual(h.log[0], { level: "warn", event: "plex.scan.interrupted-detected", details: { previousStartedAt: "2026-11-17T10:00:00.000Z", processed: 3, total: 9, currentShow: undefined, currentPhase: "processing", lastHeartbeatAt: "2026-11-17T10:01:00.000Z" } });
  assert.equal(h.log[1].event, "plex.scan.start");
});

test("the 15-second heartbeat reports progress and active work, keeping a rate-limit pause", async () => {
  const h = harness();
  const work = deferred();
  let run!: ScanRunContext<Point>;
  h.startRun(async (context) => { run = context; await work.promise; }, { phase: "initializing" });
  await Promise.resolve();
  run.reportRateLimit("TVDB", true);
  h.tick();
  assert.equal(h.status()?.currentPhase, "initializing", "an empty tracker keeps an explicit phase");
  run.setPhase(undefined);
  run.progress(2, 5);
  run.activeWork.update("a", "Show A", "tvdb-series");
  h.tick();
  assert.deepEqual(h.status(), { status: "running", processed: 2, total: 5, startedAt: h.iso(), currentPhase: "tvdb-series", heartbeatAt: h.iso(30_000), rateLimitPaused: true, rateLimitProvider: "TVDB", activeShows: [{ key: "a", show: "Show A", phase: "tvdb-series" }], currentShow: "Show A" });
  run.activeWork.update("b", "Show B", "plex-inventory");
  h.tick();
  assert.equal(h.status()?.currentPhase, "processing-2-shows");
  assert.equal(h.status()?.currentShow, undefined);
  run.activeWork.remove("a"); run.activeWork.remove("b");
  h.tick();
  assert.equal(h.status()?.currentPhase, "processing");
  assert.deepEqual(h.log.filter((line) => line.event === "plex.scan.heartbeat").at(-1)?.details, { processed: 2, total: 5, activeShows: [], heartbeatAt: h.iso(60_000) });
  work.resolve();
});

test("a heartbeat is not progress: it neither counts a show nor makes a Resume point save due", async () => {
  const h = harness();
  const work = deferred();
  let run!: ScanRunContext<Point>;
  h.startRun(async (context) => { run = context; await work.promise; });
  await Promise.resolve();
  run.resumePoint.startIntervals();
  run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: [] }, details: {} }));
  run.progress(0, 30);
  h.advance(1_000);
  h.tick();
  assert.equal(h.status()?.processed, 0);
  assert.equal(h.point, null, "no Resume point is written by a heartbeat");
  work.resolve();
});

test("a completed run replaces its status cleanly, stops its heartbeat and a late tick never writes running", async () => {
  const h = harness();
  let run!: ScanRunContext<Point>;
  const order: string[] = [];
  const started = h.startRun(async (context) => {
    run = context;
    context.reportRateLimit("TMDB", true);
    context.activeWork.update("a", "Show A", "x");
    h.tick();
    assert.equal(context.complete({ commit: () => order.push("commit"), processed: 4, total: 4, finishedAt: h.iso(20_000), details: { finishedAt: h.iso(20_000), shows: 4 } }), "completed");
    h.tick();
  }, { hooks: { committed: () => order.push("committed"), succeeded: () => order.push("succeeded") } });
  await started.settled;
  assert.deepEqual(order, ["commit", "committed", "succeeded"]);
  assert.deepEqual(h.status(), { status: "completed", processed: 4, total: 4, startedAt: h.iso(), finishedAt: h.iso(20_000) });
  assert.equal(h.timerCount(), 0);
  assert.deepEqual(h.log.at(-1), { level: "info", event: "plex.scan.complete", details: { finishedAt: h.iso(20_000), shows: 4 } });
  run.progress(9, 9);
  run.reportRateLimit("TMDB", true);
  run.logger.info("plex.late");
  assert.equal(h.status()?.status, "completed", "a settled run's late calls change nothing");
  assert.ok(!h.events().includes("plex.late"));
});

test("a veto at completion is never a success: nothing is committed and no completed status is written", async () => {
  const h = harness();
  let committed = false;
  let outcome: string | undefined;
  await h.startRun(async (run) => {
    outcome = run.complete({ commit: () => { committed = true; }, processed: 1, total: 1, finishedAt: h.iso(), details: {} });
  }, { hooks: { veto: () => true, succeeded: () => assert.fail("a vetoed run does not succeed") } }).settled;
  assert.equal(outcome, "vetoed");
  assert.equal(committed, false);
  assert.equal(h.status()?.status, "running", "the stored running status is later reconciled as an Interrupted scan");
  assert.ok(!h.events().includes("plex.scan.complete"));
  assert.equal(h.timerCount(), 0);
});

test("a failed run keeps its error, clears pause and active work, and releases timer and owner", async () => {
  const h = harness();
  const failed: unknown[] = [];
  const started = h.startRun(async (run) => {
    run.progress(3, 8);
    run.reportRateLimit("TVDB", true);
    run.activeWork.update("a", "Show A", "x");
    h.tick();
    throw new Error("Plex is unreachable.");
  }, { hooks: { failed: (error) => failed.push(error), failureDetails: () => ({ providerMetrics: { Plex: 1 } }) } });
  await started.settled;
  assert.deepEqual(h.status(), { status: "error", processed: 3, total: 8, startedAt: h.iso(), finishedAt: h.iso(15_000), error: "Plex is unreachable.", rateLimitPaused: false, currentPhase: "x", heartbeatAt: h.iso(15_000) });
  assert.equal((failed[0] as Error).message, "Plex is unreachable.");
  const error = h.log.at(-1)!;
  assert.equal(error.event, "plex.scan.error");
  assert.equal(error.details?.error, "Plex is unreachable.");
  assert.deepEqual(error.details?.providerMetrics, { Plex: 1 });
  assert.equal(h.timerCount(), 0);
  assert.equal(h.runs.activeScanRun(), null);
});

test("a non-Error failure records the mode's failure message", async () => {
  const h = harness();
  await h.startRun(async () => { throw "boom"; }).settled;
  assert.equal(h.status()?.error, "The Plex scan failed.");
});

test("cleanup survives a throwing failure hook, logger and failure details, and keeps the original error", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness();
  const throwing = { info: () => {}, warn: () => {}, error: () => { throw new Error("disk full"); } };
  await h.startRun(async () => { throw new Error("original"); }, {
    createLogger: () => throwing,
    hooks: { failed: () => { throw new Error("issue store down"); }, failureDetails: () => { throw new Error("metrics broke"); } },
  }).settled;
  assert.equal(h.status()?.error, "original");
  assert.equal(h.timerCount(), 0);
  assert.equal(h.runs.activeScanRun(), null);
});

test("when the status store cannot record the failure, the run rejects with its original error and still cleans up", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness();
  const started = h.startRun(async () => { h.failures.statusWrite = true; throw new Error("original"); });
  await assert.rejects(started.settled, /original/);
  assert.equal(h.timerCount(), 0);
  assert.equal(h.runs.activeScanRun(), null);
});

test("a throwing begin hook or snapshot fails the run cleanly", async () => {
  const h = harness();
  await h.startRun(async () => assert.fail("the body does not run"), { hooks: { begin: () => { throw new Error("coverage store locked"); } } }).settled;
  assert.equal(h.status()?.error, "coverage store locked");
  assert.equal(h.timerCount(), 0);
  await h.startRun(async (run) => {
    run.resumePoint.provideSnapshot(() => { throw new Error("snapshot broke"); });
    run.progress(10, 20);
    run.resumePoint.checkpoint();
  }).settled;
  assert.equal(h.status()?.error, "snapshot broke");
  assert.equal(h.runs.activeScanRun(), null);
});

test("explicit clearing survives the stored record's serialization", async () => {
  const h = harness();
  const work = deferred();
  let run!: ScanRunContext<Point>;
  h.startRun(async (context) => { run = context; await work.promise; });
  await Promise.resolve();
  run.reportRateLimit("TVDB", true);
  assert.equal(h.status()?.rateLimitProvider, "TVDB");
  run.reportRateLimit("TMDB", false);
  assert.equal(h.status()?.rateLimitPaused, true, "another provider's resume leaves the pause");
  run.reportRateLimit("TVDB", false);
  assert.equal(h.status()?.rateLimitPaused, false);
  assert.ok(!("rateLimitProvider" in h.status()!), "the cleared provider is gone from the stored record");
  work.resolve();
});

test("a running status is an Interrupted scan only after more than 90 seconds without a heartbeat", () => {
  const h = harness();
  h.setStatus({ status: "running", processed: 2, total: 5, startedAt: h.iso(-200_000), heartbeatAt: h.iso(-90_000), currentPhase: "tvdb", currentShow: "Show A" });
  assert.equal(h.runs.readStatus(h.mode)?.status, "running", "exactly 90 seconds is not interrupted");
  h.advance(1);
  const interrupted = h.runs.readStatus(h.mode);
  assert.deepEqual(interrupted, { status: "error", processed: 2, total: 5, startedAt: h.iso(-200_000), heartbeatAt: h.iso(-90_000), currentPhase: "tvdb", currentShow: "Show A", finishedAt: h.iso(1), error: "Interrupted during tvdb." });
  assert.deepEqual(h.status(), interrupted);
  assert.equal(h.interruptions.length, 1);
  h.advance(60_000);
  assert.deepEqual(h.runs.readStatus(h.mode), interrupted, "later reads rewrite nothing");
  assert.equal(h.interruptions.length, 1, "the interruption hook runs once");
});

test("without a heartbeat, the start time ages the running status", () => {
  const h = harness();
  h.setStatus({ status: "running", processed: 0, total: 0, startedAt: h.iso(-91_000) });
  assert.equal(h.runs.readStatus(h.mode)?.status, "error");
});

const untimed: [string, ScanRunStatus][] = [
  ["missing", { status: "running", processed: 0, total: 0 }],
  ["invalid", { status: "running", processed: 0, total: 0, startedAt: "not a date", heartbeatAt: "also not" }],
];
for (const [label, status] of untimed) {
  test("a running status with " + label + " timestamps and no live run is interrupted at once rather than running forever", () => {
    const h = harness();
    h.setStatus(status);
    assert.equal(h.runs.readStatus(h.mode)?.status, "error");
    assert.equal(h.interruptions.length, 1);
  });
}

test("a live run of the kind is never reconciled, however late its heartbeat; another kind's run does not count", async () => {
  const h = harness();
  const work = deferred();
  h.startRun(async () => { await work.promise; });
  await Promise.resolve();
  h.advance(600_000);
  assert.equal(h.runs.readStatus(h.mode)?.status, "running");
  work.resolve();
  const other = harness();
  other.setStatus({ status: "running", processed: 0, total: 0, startedAt: other.iso(-100_000) });
  const trakt = deferred();
  other.runs.start("trakt", () => trakt.promise);
  assert.equal(other.runs.readStatus(other.mode)?.status, "error", "a Trakt owner does not keep a stale Plex status running");
  trakt.resolve();
});

test("a failing interruption hook still returns and stores the Interrupted scan", (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness();
  h.failures.interruptionHook = true;
  h.setStatus({ status: "running", processed: 0, total: 0, startedAt: h.iso(-100_000) });
  assert.equal(h.runs.readStatus(h.mode)?.status, "error");
  assert.equal(h.status()?.status, "error");
});

test("a full run loads a usable Resume point where the mode chooses, and discards an unusable one", async () => {
  const h = harness();
  h.point = { savedAt: h.iso(-1_000), shows: ["a"] };
  let loaded: unknown;
  await h.startRun(async (run) => { loaded = run.resumePoint.load((point) => point.shows.length === 1); }).settled;
  assert.deepEqual(loaded, { stored: { savedAt: h.iso(-1_000), shows: ["a"] }, usable: { savedAt: h.iso(-1_000), shows: ["a"] } });
  assert.deepEqual(h.log.find((line) => line.event === "plex.checkpoint.resume")?.details, { savedAt: h.iso(-1_000), shows: 1 });
  await h.startRun(async (run) => { loaded = run.resumePoint.load(() => false); }).settled;
  assert.equal((loaded as { usable: unknown }).usable, null);
  assert.equal(h.point, null, "an unusable point is cleared");
  assert.deepEqual(h.log.find((line) => line.event === "plex.checkpoint.discarded"), { level: "warn", event: "plex.checkpoint.discarded", details: { savedAt: h.iso(-1_000), reason: "expired-or-incompatible" } });
});

test("interval saves follow the cadence, skip vetoed writes without resetting it, and a completed full run clears the point", async () => {
  const h = harness();
  let vetoed = false;
  await h.startRun(async (run) => {
    run.resumePoint.startIntervals();
    run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: ["x"] }, details: { shows: 1 } }));
    run.progress(1, 30);
    assert.equal(run.resumePoint.checkpoint(), false, "not yet due");
    h.advance(5_000);
    vetoed = true;
    assert.equal(run.resumePoint.checkpoint(), false, "a vetoed save writes nothing");
    assert.equal(h.point, null);
    vetoed = false;
    assert.equal(run.resumePoint.checkpoint(), true, "still due after the veto");
    assert.equal(run.resumePoint.checkpoint(), false, "the successful save reset the cadence");
    for (let processed = 2; processed <= 11; processed += 1) run.progress(processed, 30);
    assert.equal(run.resumePoint.checkpoint(), true, "ten more shows are due");
    assert.deepEqual(h.point, { savedAt: h.iso(5_000), shows: ["x"] });
    run.complete({ commit: () => {}, processed: 30, total: 30, finishedAt: h.iso(), details: {} });
  }, { hooks: { veto: () => vetoed } }).settled;
  assert.deepEqual(h.log.filter((line) => line.event === "plex.checkpoint.saved").map((line) => line.details), [
    { savedAt: h.iso(5_000), processed: 1, total: 30, shows: 1 },
    { savedAt: h.iso(5_000), processed: 11, total: 30, shows: 1 },
  ]);
  assert.equal(h.point, null);
});

test("a single-show run never saves a Resume point and prunes its show from the stored full-run point", async () => {
  const h = harness();
  h.point = { savedAt: h.iso(-1_000), shows: ["a", "b"] };
  let loaded: unknown;
  await h.startRun(async (run) => {
    loaded = run.resumePoint.load(() => true);
    run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: ["b"] }, details: {} }));
    run.progress(1, 1);
    h.advance(10_000);
    assert.equal(run.resumePoint.checkpoint(), false);
    run.complete({ commit: () => {}, processed: 1, total: 1, finishedAt: h.iso(), details: {} });
  }, { fullRun: false, pruneResumePoint: (point) => ({ ...point, shows: point.shows.filter((show) => show !== "b") }) }).settled;
  assert.deepEqual(loaded, { stored: { savedAt: h.iso(-1_000), shows: ["a", "b"] }, usable: null });
  assert.deepEqual(h.point, { savedAt: h.iso(-1_000), shows: ["a"] });
  assert.ok(!h.events().some((event) => event.startsWith("plex.checkpoint.")));
});

test("a late provider callback reaches only the live run that dispatched it", async () => {
  const h = harness();
  let late!: () => unknown;
  await h.startRun(async () => {
    assert.ok(h.runs.bound("plex"), "work the run dispatched is bound to it");
    assert.equal(h.runs.bound("trakt"), undefined, "a binding requires the expected kind");
    late = () => h.runs.bound("plex");
  }).settled;
  const next = deferred();
  let nextRun!: ScanRunContext<Point>;
  h.startRun(async (run) => { nextRun = run; await next.promise; });
  await Promise.resolve();
  assert.ok(nextRun.isLive());
  assert.equal(late(), undefined, "the settled run's callback does not see the next run");
  assert.equal(h.runs.bound("plex"), undefined, "work outside any run is not bound");
  next.resolve();
});

test("only the run that owns the lock can run a body", async () => {
  const h = harness();
  await assert.rejects(h.runs.run({ kind: "plex", runId: "stale", startedAt: h.iso() }, h.mode, { fullRun: true, createLogger: () => ({ info() {}, warn() {}, error() {} }) }, async () => {}), /does not own/);
});
