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
    vetoedError: "Manual Matches changed while this scan was running. Start a new Plex scan to include them.",
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

// Heartbeat failures are best effort: the tick reports to the console and the
// run keeps going, still owning the lock and its heartbeat until the body settles.
test("a heartbeat whose logger throws is contained: the run keeps ownership, its heartbeat and records the beat", async (t) => {
  const reported = t.mock.method(console, "error", () => {});
  const h = harness();
  const work = deferred();
  const throwing = {
    info: (event: string) => { if (event === "plex.scan.heartbeat") throw new Error("log disk full"); },
    warn: () => {}, error: () => {},
  };
  const started = h.startRun(async () => { await work.promise; }, { createLogger: () => throwing });
  await Promise.resolve();
  assert.doesNotThrow(() => h.tick(), "a timer callback must never throw");
  assert.equal(h.runs.isActive("plex"), true, "ownership is kept while the body is in flight");
  assert.equal(h.timerCount(), 1, "the heartbeat keeps running");
  assert.equal(h.status()?.heartbeatAt, h.iso(15_000), "the beat is still recorded");
  assert.ok(reported.mock.callCount() >= 1, "the failure is reported");
  work.resolve();
  await started.settled;
  assert.equal(h.runs.isActive(), false, "ownership is released once the body settles");
  assert.equal(h.timerCount(), 0);
});

test("a heartbeat whose status store throws is contained: the run keeps ownership and beats again once the store recovers", async (t) => {
  const reported = t.mock.method(console, "error", () => {});
  const h = harness();
  const work = deferred();
  const started = h.startRun(async () => { await work.promise; });
  await Promise.resolve();
  h.failures.statusWrite = true;
  assert.doesNotThrow(() => h.tick(), "a timer callback must never throw");
  assert.equal(h.runs.isActive("plex"), true, "ownership is kept while the body is in flight");
  assert.equal(h.timerCount(), 1, "the heartbeat keeps running");
  assert.ok(reported.mock.callCount() >= 1, "the failure is reported");
  h.failures.statusWrite = false;
  h.tick();
  assert.equal(h.status()?.heartbeatAt, h.iso(30_000), "the next beat is recorded");
  assert.equal(h.status()?.status, "running");
  work.resolve();
  await started.settled;
  assert.equal(h.runs.isActive(), false);
  assert.equal(h.timerCount(), 0);
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

test("a veto at completion is never a success: it ends the run at once with a clean error status, committing and saving nothing", async () => {
  const h = harness();
  let committed = false;
  let outcome: string | undefined;
  await h.startRun(async (run) => {
    run.resumePoint.startIntervals();
    run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: ["a"] }, details: {} }));
    run.progress(2, 4);
    run.reportRateLimit("TVDB", true, h.iso(60_000));
    run.activeWork.update("a", "Show A", "tvdb-series");
    h.tick();
    outcome = run.complete({ commit: () => { committed = true; }, processed: 4, total: 4, finishedAt: h.iso(20_000), details: {} });
  }, { hooks: {
    veto: () => true,
    committed: () => assert.fail("a vetoed run completes no coverage recheck"),
    succeeded: () => assert.fail("a vetoed run does not succeed"),
    failed: () => assert.fail("a vetoed run raises no scan-failure Coverage Issue"),
  } }).settled;
  assert.equal(outcome, "vetoed");
  assert.equal(committed, false);
  assert.deepEqual(h.status(), { status: "error", processed: 2, total: 4, startedAt: h.iso(), finishedAt: h.iso(15_000), error: "Manual Matches changed while this scan was running. Start a new Plex scan to include them.", rateLimitPaused: false, currentPhase: "tvdb-series", heartbeatAt: h.iso(15_000) });
  assert.equal(h.point, null, "no Resume point is forced for a vetoed report");
  assert.ok(!h.events().some((event) => event === "plex.scan.complete" || event === "plex.scan.error" || event.startsWith("plex.checkpoint.")));
  assert.equal(h.timerCount(), 0);
  assert.equal(h.runs.activeScanRun(), null);
  h.advance(600_000);
  assert.equal(h.runs.readStatus(h.mode)?.error, "Manual Matches changed while this scan was running. Start a new Plex scan to include them.");
  assert.equal(h.interruptions.length, 0, "a vetoed run is never recorded as an Interrupted scan");
});

for (const hook of ["committed", "succeeded"] as const) {
  test(`a ${hook} hook that throws after the report was committed records the error but forces no failure Resume point over it`, async () => {
    const h = harness();
    h.point = { savedAt: h.iso(-1_000), shows: ["earlier"] };
    const failed: unknown[] = [];
    await h.startRun(async (run) => {
      run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: ["a"] }, details: {} }));
      run.progress(4, 4);
      run.complete({ commit: () => {}, processed: 4, total: 4, finishedAt: h.iso(), details: {} });
    }, { hooks: { [hook]: () => { throw new Error("coverage store down"); }, failed: (error: unknown) => failed.push(error) } }).settled;
    assert.equal(h.status()?.status, "error");
    assert.equal(h.status()?.error, "coverage store down", "the original error is kept");
    assert.equal((failed[0] as Error).message, "coverage store down");
    assert.ok(!h.events().includes("plex.checkpoint.saved"), "no failure Resume point is written after the report committed");
    if (hook === "committed") assert.deepEqual(h.point, { savedAt: h.iso(-1_000), shows: ["earlier"] });
    else assert.equal(h.point, null, "the completed run's cleared Resume point stays cleared");
  });
}

test("completeAfter settles the Resume point after the commit, then awaits finalization in its own phase, owning the lock and running, before it records completion", async () => {
  const h = harness();
  h.point = { savedAt: h.iso(-1_000), shows: ["earlier"] };
  const order: string[] = [];
  const finalizing = deferred();
  let outcome: Promise<string> | undefined;
  const started = h.startRun(async (run) => {
    outcome = run.completeAfter({ commit: () => order.push("commit"), phase: "finalizing", finalize: async () => { order.push("finalize"); await finalizing.promise; order.push("finalized"); }, processed: 4, total: 4, finishedAt: h.iso(20_000), details: { shows: 4 } });
    await outcome;
  }, { hooks: { committed: () => order.push("committed"), succeeded: () => order.push("succeeded") } });
  await Promise.resolve();
  assert.deepEqual(order, ["commit", "committed", "finalize"]);
  assert.equal(h.runs.activeScanRun()?.runId, started.owner.runId, "the run still owns the scan run lock");
  assert.equal(h.status()?.status, "running");
  assert.equal(h.status()?.currentPhase, "finalizing");
  assert.equal(h.point, null, "the committed run's Resume point is already settled");
  h.tick();
  assert.equal(h.status()?.currentPhase, "finalizing", "the heartbeat keeps reporting the finalization phase");
  assert.ok(!h.events().includes("plex.scan.complete"));
  finalizing.resolve();
  await started.settled;
  assert.equal(await outcome, "completed");
  assert.deepEqual(order, ["commit", "committed", "finalize", "finalized", "succeeded"]);
  assert.equal(h.status()?.status, "completed");
  assert.equal(h.point, null);
  assert.equal(h.runs.activeScanRun(), null);
});

test("a run whose process ends during finalization is never recorded as completed: it reads as interrupted in its finalization phase", async () => {
  const h = harness();
  h.point = { savedAt: h.iso(-1_000), shows: ["earlier"] };
  const finalizing = deferred();
  const committed: string[] = [];
  const started = h.startRun(async (run) => {
    await run.completeAfter({ commit: () => committed.push("report"), phase: "finalizing", finalize: () => finalizing.promise, processed: 4, total: 4, finishedAt: h.iso(), details: {} });
  });
  await Promise.resolve();
  assert.deepEqual(committed, ["report"]);
  // The process ends here: the next process has no owner record, and no heartbeat arrives.
  const next = createScanRunLifecycle({ clock: { now: () => Date.parse(h.iso(91_000)) }, state: {} });
  const status = next.readStatus(h.mode);
  assert.equal(status?.status, "error");
  assert.equal(status?.error, "Interrupted during finalizing.");
  assert.equal(h.interruptions.length, 1);
  assert.equal(h.point, null, "no Resume point survives the committed report");
  finalizing.resolve();
  await started.settled;
});

test("completeAfter never finalizes a vetoed run", async () => {
  const h = harness();
  let outcome: string | undefined;
  await h.startRun(async (run) => {
    outcome = await run.completeAfter({ commit: () => assert.fail("a vetoed run commits nothing"), phase: "finalizing", finalize: async () => assert.fail("a vetoed run finalizes nothing"), processed: 1, total: 1, finishedAt: h.iso(), details: {} });
  }, { hooks: { veto: () => true } }).settled;
  assert.equal(outcome, "vetoed");
  assert.equal(h.status()?.status, "error");
});

test("a finalization that throws fails the run after its commit, forcing no Resume point over the committed report", async () => {
  const h = harness();
  h.point = { savedAt: h.iso(-1_000), shows: ["earlier"] };
  await h.startRun(async (run) => {
    run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: ["a"] }, details: {} }));
    await run.completeAfter({ commit: () => {}, phase: "finalizing", finalize: async () => { throw new Error("coverage store down"); }, processed: 4, total: 4, finishedAt: h.iso(), details: {} });
  }).settled;
  assert.equal(h.status()?.status, "error");
  assert.equal(h.status()?.error, "coverage store down");
  assert.ok(!h.events().includes("plex.checkpoint.saved"));
  assert.equal(h.point, null, "the Resume point was settled with the committed report");
});

test("rate-limit reporting stores the resume time with the pause and clears it with the pause; a provider may give none", async () => {
  const h = harness();
  const work = deferred();
  let run!: ScanRunContext<Point>;
  h.startRun(async (context) => { run = context; await work.promise; });
  await Promise.resolve();
  run.reportRateLimit("TVDB", true, h.iso(60_000));
  assert.deepEqual({ paused: h.status()?.rateLimitPaused, provider: h.status()?.rateLimitProvider, resumeAt: h.status()?.rateLimitResumeAt }, { paused: true, provider: "TVDB", resumeAt: h.iso(60_000) });
  run.reportRateLimit("TVDB", false);
  assert.ok(!("rateLimitResumeAt" in h.status()!), "the resume time is cleared with the pause");
  run.reportRateLimit("Plex", true);
  assert.equal(h.status()?.rateLimitPaused, true);
  assert.ok(!("rateLimitResumeAt" in h.status()!), "a pause without a resume time stores none");
  work.resolve();
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
  assert.deepEqual(interrupted, { status: "error", processed: 2, total: 5, startedAt: h.iso(-200_000), heartbeatAt: h.iso(-90_000), currentPhase: "tvdb", rateLimitPaused: false, finishedAt: h.iso(1), error: "Interrupted during tvdb." });
  assert.deepEqual(h.status(), interrupted);
  assert.equal(h.interruptions.length, 1);
  h.advance(60_000);
  assert.deepEqual(h.runs.readStatus(h.mode), interrupted, "later reads rewrite nothing");
  assert.equal(h.interruptions.length, 1, "the interruption hook runs once");
});

test("an Interrupted scan is explained from its last running status but stores no pause or active work", () => {
  const h = harness();
  h.setStatus({ status: "running", processed: 2, total: 5, startedAt: h.iso(-200_000), heartbeatAt: h.iso(-91_000), currentPhase: "tvdb", currentShow: "Show A", activeShows: [{ key: "a", show: "Show A", phase: "tvdb" }], rateLimitPaused: true, rateLimitProvider: "TVDB", rateLimitResumeAt: h.iso(60_000) });
  const interrupted = h.runs.readStatus(h.mode);
  const expected = { status: "error", processed: 2, total: 5, startedAt: h.iso(-200_000), heartbeatAt: h.iso(-91_000), currentPhase: "tvdb", rateLimitPaused: false, finishedAt: h.iso(), error: "Interrupted during tvdb." };
  assert.deepEqual(interrupted, expected);
  assert.deepEqual(h.status(), expected, "the stored terminal record has no pause, provider, resume time or active shows");
  assert.equal(h.interruptions[0].rateLimitPaused, false, "the interruption hook sees the cleared record");
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

test("a full run that fails saves a forced Resume point at once, outside the interval cadence", async () => {
  const h = harness();
  await h.startRun(async (run) => {
    run.resumePoint.startIntervals();
    run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: ["a", "b"] }, details: { shows: 2 } }));
    run.progress(2, 30);
    h.advance(1_000);
    assert.equal(run.resumePoint.checkpoint(), false, "no interval save is due");
    throw new Error("Plex is unreachable.");
  }).settled;
  assert.deepEqual(h.point, { savedAt: h.iso(1_000), shows: ["a", "b"] });
  assert.deepEqual(h.log.find((line) => line.event === "plex.checkpoint.saved")?.details, { savedAt: h.iso(1_000), processed: 2, total: 30, reason: "failure", shows: 2 });
  assert.equal(h.status()?.error, "Plex is unreachable.");
});

test("a rate-limit pause saves a forced Resume point when the pause starts, not while it continues or as it ends", async () => {
  const h = harness();
  const saves = () => h.log.filter((line) => line.event === "plex.checkpoint.saved").map((line) => line.details);
  await h.startRun(async (run) => {
    run.resumePoint.startIntervals();
    let shows = ["a"];
    run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows }, details: {} }));
    run.progress(1, 30);
    h.advance(1_000);
    run.reportRateLimit("TVDB", true);
    assert.deepEqual(h.point, { savedAt: h.iso(1_000), shows: ["a"] });
    shows = ["a", "b"];
    run.reportRateLimit("TVDB", true);
    run.reportRateLimit("TMDB", true);
    assert.equal(saves().length, 1, "a continuing pause is not a new pause");
    run.reportRateLimit("TMDB", false);
    assert.equal(saves().length, 1, "the pause ending saves nothing");
    run.progress(2, 30);
    h.advance(1_000);
    run.reportRateLimit("TVDB", true);
    assert.deepEqual(h.point, { savedAt: h.iso(2_000), shows: ["a", "b"] }, "a new pause saves again");
    run.complete({ commit: () => {}, processed: 30, total: 30, finishedAt: h.iso(), details: {} });
  }).settled;
  assert.deepEqual(saves(), [
    { savedAt: h.iso(1_000), processed: 1, total: 30, reason: "rate-limit" },
    { savedAt: h.iso(2_000), processed: 2, total: 30, reason: "rate-limit" },
  ]);
});

test("a failure or pause before the snapshot producer is ready saves nothing and does not error", async () => {
  const h = harness();
  await h.startRun(async (run) => {
    run.progress(3, 30);
    run.reportRateLimit("TVDB", true);
    throw new Error("Plex is unreachable.");
  }).settled;
  assert.equal(h.point, null);
  assert.ok(!h.events().some((event) => event.startsWith("plex.checkpoint.")));
  assert.equal(h.status()?.error, "Plex is unreachable.");
});

test("single-show runs never force a save", async () => {
  const h = harness();
  h.point = { savedAt: h.iso(-1_000), shows: ["a", "b"] };
  await h.startRun(async (run) => {
    run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: ["b"] }, details: {} }));
    run.progress(1, 1);
    run.reportRateLimit("TVDB", true);
    throw new Error("TVDB is unreachable.");
  }, { fullRun: false }).settled;
  assert.deepEqual(h.point, { savedAt: h.iso(-1_000), shows: ["a", "b"] });
  assert.ok(!h.events().some((event) => event.startsWith("plex.checkpoint.")));
});

test("a vetoed forced save is not a save and does not reset the interval cadence", async () => {
  const h = harness();
  let vetoed = true;
  await h.startRun(async (run) => {
    run.resumePoint.startIntervals();
    run.resumePoint.provideSnapshot((savedAt) => ({ point: { savedAt, shows: ["a"] }, details: {} }));
    run.progress(1, 30);
    h.advance(5_000);
    run.reportRateLimit("TVDB", true);
    assert.equal(h.point, null, "the coverage-revision veto writes nothing");
    vetoed = false;
    assert.equal(run.resumePoint.checkpoint(), true, "the interval save is still due after the vetoed forced save");
    vetoed = true;
    throw new Error("Plex is unreachable.");
  }, { hooks: { veto: () => vetoed } }).settled;
  assert.deepEqual(h.log.filter((line) => line.event === "plex.checkpoint.saved").map((line) => line.details?.reason), [undefined], "only the interval save was written");
  assert.deepEqual(h.point, { savedAt: h.iso(5_000), shows: ["a"] });
});

test("a forced save that fails is logged and neither fails the pause nor replaces the run's error", async () => {
  const h = harness();
  let paused = false;
  await h.startRun(async (run) => {
    run.resumePoint.provideSnapshot(() => { throw new Error("snapshot broke"); });
    run.reportRateLimit("TVDB", true);
    paused = Boolean(h.status()?.rateLimitPaused);
    throw new Error("Plex is unreachable.");
  }).settled;
  assert.ok(paused, "the pause is still recorded");
  assert.deepEqual(h.log.filter((line) => line.event === "plex.checkpoint.save-failed").map((line) => line.details), [
    { reason: "rate-limit", error: "snapshot broke" },
    { reason: "failure", error: "snapshot broke" },
  ]);
  assert.equal(h.status()?.error, "Plex is unreachable.");
  assert.equal(h.runs.activeScanRun(), null);
});

test("the end hook runs once, after the forced failure save, even when the failure cannot be recorded", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness();
  const order: string[] = [];
  const started = h.startRun(async (run) => {
    run.resumePoint.provideSnapshot((savedAt) => { order.push("save"); return { point: { savedAt, shows: ["a"] }, details: {} }; });
    h.failures.statusWrite = true;
    throw new Error("original");
  }, { hooks: { ended: () => { order.push("ended"); throw new Error("end hook broke"); } } });
  await assert.rejects(started.settled, /original/);
  assert.deepEqual(order, ["save", "ended"]);
  assert.equal(h.runs.activeScanRun(), null);
  assert.equal(h.timerCount(), 0);
});
