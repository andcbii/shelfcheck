import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ActiveScanTracker, type ActiveScanWork } from "@/lib/scan-concurrency";
import { shouldSaveCheckpoint } from "@/lib/scan-cache";
import type { ScanLogger } from "@/lib/scan-log";
import { SCAN_RUN_LABELS, scanRunLockMessage, type ScanPreparationProgress, type ScanRunKind } from "@/lib/scan-run-activity";

/**
 * The scan run lifecycle: the one place that decides whether a Scan run, Trakt
 * or Plex, full or single-show, may start, and that owns it until all its work
 * settles. Only one Scan run is active at a time across both kinds.
 *
 * It owns the run's status transitions, its 15-second heartbeat, Interrupted
 * scan reconciliation, Resume point policy and its logger. Each scan mode
 * passes a typed adapter (a ScanRunMode plus per-run ScanRunOptions) and keeps
 * its own domain work, report assembly and success persistence. It must not
 * import the scan modes back.
 */

export type { ScanRunKind };

/** Who holds the lock: the kind, a unique run identity and when ownership was claimed. */
export type ScanRunOwner = { kind: ScanRunKind; runId: string; startedAt: string };

export type ScanRunClock = { now: () => number };

/** Interval timers, injectable so tests drive the heartbeat deterministically. */
export type ScanRunTimers = { setInterval: (callback: () => void, milliseconds: number) => unknown; clearInterval: (handle: unknown) => void };

/**
 * Where the owner record lives. Production keeps it on `globalThis`, so every
 * module instance in this server process (route bundles, reloaded modules)
 * shares one record.
 *
 * Single-process assumption: this is an in-memory lock. It holds within one
 * Node.js server process, which matches Shelfcheck's single-container,
 * single-process deployment. Several processes or replicas would each have
 * their own record and could run scans together; that deployment needs a
 * different lock.
 */
export type ScanRunState = { owner?: ScanRunOwner };

/** More than this long without a heartbeat, a running status with no live owner is an Interrupted scan. */
export const INTERRUPTED_AFTER_MS = 90_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** A start refused because another Scan run, of either kind, owns the lock. */
export class ScanRunConflictError extends Error {
  readonly status = 409;
  constructor(readonly owner: ScanRunOwner, requested: ScanRunKind) {
    super(scanRunLockMessage(owner.kind, requested));
    this.name = "ScanRunConflictError";
  }
}

/** The lifecycle fields every scan mode's stored status shares. Modes narrow or add their own typed extras. */
export type ScanRunStatus = {
  status: "idle" | "running" | "completed" | "error";
  processed: number;
  total: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  rateLimitPaused?: boolean;
  rateLimitProvider?: string;
  /** When the provider said the rate-limit pause ends, if it said. */
  rateLimitResumeAt?: string;
  currentShow?: string;
  currentPhase?: string;
  activeShows?: ActiveScanWork[];
  /** A preparing run's progress through its preparation steps, if the mode reports one. */
  preparation?: ScanPreparationProgress;
  heartbeatAt?: string;
};

/**
 * The fields a status holds only while its run is live: its rate-limit pause's
 * provider and resume time, its active work and its preparation. A terminal
 * error, recorded or interrupted, clears every one.
 */
const TRANSIENT_STATUS_FIELDS = ["rateLimitProvider", "rateLimitResumeAt", "activeShows", "currentShow", "preparation"] as const satisfies readonly (keyof ScanRunStatus)[];

/** An update that clears every transient field. */
const CLEARED_TRANSIENT_STATUS: Partial<ScanRunStatus> = Object.fromEntries(TRANSIENT_STATUS_FIELDS.map((field) => [field, undefined]));

type LogDetails = Record<string, unknown>;

/** Why a Resume point was saved outside the interval cadence. */
type ForcedSaveReason = "failure" | "rate-limit";

/** Why a Resume point was saved: on the interval cadence, or forced. */
export type ScanRunSaveReason = "interval" | ForcedSaveReason;

/** Where a mode keeps its Resume point, and how its log events describe one. */
export type ScanRunResumePointStore<P> = {
  read(): P | null;
  write(point: P): void;
  clear(): void;
  /** Details for the `<prefix>.checkpoint.resume` event. */
  resumeDetails(point: P): LogDetails;
  /** Details for the `<prefix>.checkpoint.discarded` event. */
  discardDetails(point: P): LogDetails;
  /**
   * The `reason` the `<prefix>.checkpoint.saved` event logs, or undefined for
   * none. By default a forced save logs its reason and an interval save none.
   */
  savedReason?(reason: ScanRunSaveReason): string | undefined;
};

/** The parts of a scan mode the lifecycle needs with or without a live run. */
export type ScanRunMode<S extends ScanRunStatus, P> = {
  kind: ScanRunKind;
  /**
   * Lifecycle log events are `<eventPrefix>.scan.*` and `<eventPrefix>.checkpoint.*`;
   * with an empty prefix, `scan.*` and `checkpoint.*`. The Trakt mode uses the
   * empty prefix for log compatibility: its shelfcheck.log lines kept these
   * unprefixed names before the lifecycle, and stay unchanged.
   */
  eventPrefix: string;
  /** The status error when a failure is not an Error with its own message. */
  failureMessage: string;
  /** The status error when the mode's veto ends the run at completion; the failure message when absent. */
  vetoedError?: string;
  /** The raw stored status record of this kind; it never reconciles. */
  status: { read(): S | null; write(status: S): void };
  interruptedError(status: S): string;
  /** Runs once, when a stored running status is first recorded as an Interrupted scan. */
  onInterrupted?(status: S): void;
  resumePoint?: ScanRunResumePointStore<P>;
};

/** Mode hooks for one Scan run. A throw from begin, veto, committed or succeeded fails the run; cleanup still happens. */
export type ScanRunHooks = {
  /** Before the start transition. */
  begin?(): void;
  /**
   * True when the mode refuses to commit: vetoes Resume point saves and the
   * run's completion. A veto at completion ends the run with the mode's
   * vetoed error, without the failed hook.
   */
  veto?(): boolean;
  /** After the mode's commit, before the Resume point is cleared or pruned. */
  committed?(): void;
  /** After the Resume point is settled, before the completed status. */
  succeeded?(): void;
  /** When the run fails, before its error status. A throw here is reported, never replaces the run's error. */
  failed?(error: unknown): void;
  /** Extra details for the `<prefix>.scan.error` event. */
  failureDetails?(): LogDetails;
  /**
   * Once the run's outcome is recorded, including a forced failure save, and
   * before ownership is released. Runs exactly once, even when recording
   * failed; a throw here is reported, never replaces the run's outcome.
   */
  ended?(): void;
};

export type ScanRunOptions<P> = {
  /** Full runs load and save Resume points; single-show runs never save one. */
  fullRun: boolean;
  /** Creates this run's logger once it owns the lock. */
  createLogger(): ScanLogger;
  /** Details for the `<prefix>.scan.start` event, after `startedAt`. */
  startDetails?: LogDetails;
  /** The phase shown while no show is active, until the body changes it. */
  phase?: string;
  hooks?: ScanRunHooks;
  /** Single-show runs: the stored full-run Resume point without the checked show, or null to clear it. */
  pruneResumePoint?(point: P): P | null;
};

/** A Resume point snapshot: the point to write and extra details for its `<prefix>.checkpoint.saved` event. */
export type ScanRunSnapshot<P> = { point: P; details: LogDetails };

/** What the run body uses. Every operation is a no-op once the run has settled. */
export type ScanRunContext<P> = {
  owner: ScanRunOwner;
  /** The mode's log event prefix, for the provider request events this run dispatches. */
  eventPrefix: string;
  startedAt: string;
  /** This run's logger; silent once the run has settled. */
  logger: ScanLogger;
  /** Active work the heartbeat reports. */
  activeWork: ActiveScanTracker;
  /** Whether this run is still running: not settled and not terminal. */
  isLive(): boolean;
  /** Records progress: shows processed out of total. */
  progress(processed: number, total: number): void;
  /** The phase the heartbeat shows while no show is active; undefined shows "processing". */
  setPhase(phase: string | undefined): void;
  /** Records the run's preparation progress, shown alongside its active shows. */
  reportPreparation(preparation: ScanPreparationProgress): void;
  /** A provider rate-limit pause starting or ending for this run, with when it ends if the provider said. */
  reportRateLimit(provider: string, paused: boolean, resumeAt?: string): void;
  resumePoint: {
    /**
     * Loads the stored Resume point at the point the mode chooses. A full run
     * gets it back as `usable` when `validate` accepts it, and discards it
     * otherwise. A single-show run only sees it as `stored`, for pruning.
     */
    load(validate: (point: P) => boolean): { stored: P | null; usable: P | null };
    /** Starts the interval save cadence from the current progress. */
    startIntervals(): void;
    /** Installs the producer of the latest safe snapshot. Before this, saves are no-ops. */
    provideSnapshot(produce: (savedAt: string) => ScanRunSnapshot<P>): void;
    /** Saves an interval Resume point when one is due, allowed and not vetoed. True when written. */
    checkpoint(): boolean;
  };
  /**
   * Completes the run: unless the mode vetoes it, runs `commit` (the mode's
   * report write), settles the Resume point, records the completed status and
   * logs `<prefix>.scan.complete`. A vetoed run is not a success: nothing is
   * committed or saved, and the run ends at once with the mode's vetoed error.
   */
  complete(final: ScanRunCompletion): "completed" | "vetoed";
  /**
   * Completes the run as `complete` does, but after the commit, the
   * `committed` hook and settling the Resume point, reports `phase` and awaits
   * the mode's `finalize` before it records the completed status. The run keeps
   * its ownership and the scan run lock until `finalize` settles. A vetoed run
   * never commits or finalizes. A throw from `finalize` fails the run after its
   * commit, so no Resume point is forced over the committed report. A process
   * that ends during `finalize` leaves the run running in `phase`, so a later
   * read records it as interrupted there, never as completed.
   */
  completeAfter(final: ScanRunCompletion & { phase: string; finalize(): Promise<void> }): Promise<"completed" | "vetoed">;
};

/** A run's completion: the mode's commit (its report write) and the completed status's counts and log details. */
export type ScanRunCompletion = { commit(): void; processed: number; total: number; finishedAt: string; details: LogDetails };

/** The run body: everything the Scan run does after it owns the lock. */
export type ScanRunBody = (owner: ScanRunOwner) => Promise<void>;

export type StartedScanRun = {
  owner: ScanRunOwner;
  /** Settles, with the body's outcome, once the body has settled and ownership is released. */
  settled: Promise<void>;
};

type GlobalWithScanRun = typeof globalThis & { __shelfcheckScanRun?: ScanRunState };

function processState(): ScanRunState {
  const global = globalThis as GlobalWithScanRun;
  global.__shelfcheckScanRun ??= {};
  return global.__shelfcheckScanRun;
}

const silentLogger: ScanLogger = { info() {}, warn() {}, error() {} };

function report(message: string, error: unknown) { console.error(message, error); }

/** Reports where a throw has nowhere to go, such as a timer callback: even a failing console is swallowed. */
function reportSafely(message: string, error: unknown) { try { report(message, error); } catch { /* nothing left to report to */ } }

export function createScanRunLifecycle(options: { clock?: ScanRunClock; state?: ScanRunState; newRunId?: () => string; timers?: ScanRunTimers } = {}) {
  // Read lazily, so clocks and timers mocked after module load apply.
  const clock = options.clock || { now: () => Date.now() };
  const timers: ScanRunTimers = options.timers || { setInterval: (callback, milliseconds) => setInterval(callback, milliseconds), clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>) };
  const newRunId = options.newRunId || randomUUID;
  const state = () => options.state || processState();
  const iso = () => new Date(clock.now()).toISOString();
  // The run that dispatched the current asynchronous work, captured when its body started.
  const dispatching = new AsyncLocalStorage<{ kind: ScanRunKind; context: ScanRunContext<unknown> }>();

  function activeScanRun(): ScanRunOwner | null {
    return state().owner || null;
  }

  function isActive(kind?: ScanRunKind) {
    const owner = activeScanRun();
    return Boolean(owner && (!kind || owner.kind === kind));
  }

  /**
   * Claims the lock synchronously, before the body does anything, then runs the
   * body. A conflicting start throws ScanRunConflictError with no side effects.
   * Ownership is released only by this run, after its body settles, including
   * when the body throws before returning its promise.
   */
  function start(kind: ScanRunKind, body: ScanRunBody): StartedScanRun {
    const record = state();
    if (record.owner) throw new ScanRunConflictError(record.owner, kind);
    const owner: ScanRunOwner = { kind, runId: newRunId(), startedAt: iso() };
    record.owner = owner;
    // Only this run's identity releases the record it claimed; a stale run never clears a newer owner.
    const release = () => { if (record.owner?.runId === owner.runId) record.owner = undefined; };
    let work: Promise<void>;
    try {
      work = body(owner);
    } catch (error) {
      release();
      throw error;
    }
    const settled = Promise.resolve(work).finally(release);
    // Callers that do not await the run must not see an unhandled rejection; awaiting `settled` still sees it.
    settled.catch(() => {});
    return { owner, settled };
  }

  /**
   * Runs a Scan run's body for the owner `start` gave it, through the mode's
   * adapter. Owns the start and terminal status transitions, the heartbeat,
   * Resume point policy and the logger. Resolves once the outcome is recorded;
   * rejects with the run's original error only when its failure could not be
   * recorded.
   */
  async function run<S extends ScanRunStatus, P>(owner: ScanRunOwner, mode: ScanRunMode<S, P>, runOptions: ScanRunOptions<P>, body: (context: ScanRunContext<P>) => Promise<void>): Promise<void> {
    if (owner.kind !== mode.kind || activeScanRun()?.runId !== owner.runId) throw new Error(`This ${SCAN_RUN_LABELS[mode.kind]} scan run does not own the scan run lock.`);
    const label = SCAN_RUN_LABELS[mode.kind];
    const hooks = runOptions.hooks || {};
    const prefix = mode.eventPrefix;
    // An empty prefix keeps a mode's unprefixed event names, such as the Trakt scan's `scan.start`.
    const event = (name: string) => (prefix ? `${prefix}.${name}` : name);
    const startedAt = owner.startedAt;
    let settled = false;
    let terminal = false;
    // Once the mode's report write succeeded, a later failure must not force a Resume point over it.
    let committed = false;
    let logger: ScanLogger = silentLogger;
    let heartbeat: unknown;
    let phase = runOptions.phase;
    let processed = 0;
    let total = 0;
    let storedPoint: P | null = null;
    let snapshot: ((savedAt: string) => ScanRunSnapshot<P>) | undefined;
    let cadence: { processed: number; at: number } | undefined;
    const activeWork = new ActiveScanTracker();
    const live = () => !settled && !terminal;
    // Only a live full run with a snapshot producer installed saves a Resume point.
    const savable = () => live() && Boolean(mode.resumePoint && runOptions.fullRun && snapshot);
    /**
     * Writes a Resume point unless the mode vetoes it. A veto is not a save:
     * nothing is written and the cadence is not reset. Only a written point
     * restarts the interval cadence.
     */
    const save = (reason?: ForcedSaveReason) => {
      if (!savable() || hooks.veto?.()) return false;
      const savedAt = iso();
      const { point, details } = snapshot!(savedAt);
      mode.resumePoint!.write(point);
      const logged = mode.resumePoint!.savedReason ? mode.resumePoint!.savedReason(reason || "interval") : reason;
      runLogger.info(event("checkpoint.saved"), { savedAt, processed, total, ...(logged ? { reason: logged } : {}), ...details });
      cadence = { processed, at: clock.now() };
      return true;
    };
    /**
     * A forced save, at a failure or when a rate-limit pause starts: saved at
     * once, whatever the interval cadence. Its own failure is logged and never
     * fails or interrupts the run.
     */
    const forceSave = (reason: ForcedSaveReason) => {
      try { save(reason); } catch (error) {
        try { runLogger.warn(event("checkpoint.save-failed"), { reason, error: error instanceof Error ? error.message : String(error) }); } catch (logError) { report(`The ${label} scan could not log a failed Resume point save.`, logError); }
      }
    };
    // In-run updates merge against the raw stored record, never the reconciling reader.
    const update = (progress: Partial<ScanRunStatus>) => {
      const current = mode.status.read() || { status: "running", processed, total, startedAt };
      mode.status.write({ ...current, ...progress } as S);
    };
    /**
     * The terminal error transition: keeps the run's progress, clears its pause
     * and active work. Reports, and returns false, when the store cannot record it.
     */
    const recordError = (message: string, what: "failure" | "veto") => {
      terminal = true;
      try {
        update({ status: "error", finishedAt: iso(), error: message, rateLimitPaused: false, ...CLEARED_TRANSIENT_STATUS });
        return true;
      } catch (storeError) {
        report(`The ${label} scan could not record its ${what}.`, storeError);
        return false;
      }
    };
    const runLogger: ScanLogger = {
      info: (event, details) => { if (!settled) logger.info(event, details); },
      warn: (event, details) => { if (!settled) logger.warn(event, details); },
      error: (event, details) => { if (!settled) logger.error(event, details); },
    };
    const context: ScanRunContext<P> = {
      owner,
      eventPrefix: prefix,
      startedAt,
      logger: runLogger,
      activeWork,
      isLive: live,
      progress(nextProcessed, nextTotal) {
        if (!live()) return;
        processed = nextProcessed;
        total = nextTotal;
        update({ status: "running", processed, total });
      },
      setPhase(next) { if (live()) phase = next; },
      reportPreparation(preparation) { if (live()) update({ preparation }); },
      reportRateLimit(provider, paused, resumeAt) {
        if (!live()) return;
        const current = mode.status.read();
        if (current?.status !== "running" || !(paused || current.rateLimitProvider === provider)) return;
        update({ rateLimitPaused: paused, rateLimitProvider: paused ? provider : undefined, rateLimitResumeAt: paused ? resumeAt : undefined });
        // A pause starting, not one continuing or ending, saves the work completed so far.
        if (paused && !current.rateLimitPaused) forceSave("rate-limit");
      },
      resumePoint: {
        load(validate) {
          const store = mode.resumePoint;
          if (!live() || !store) return { stored: null, usable: null };
          storedPoint = store.read();
          if (!runOptions.fullRun) return { stored: storedPoint, usable: null };
          const usable = storedPoint && validate(storedPoint) ? storedPoint : null;
          if (usable) runLogger.info(event("checkpoint.resume"), store.resumeDetails(usable));
          else if (storedPoint) {
            runLogger.warn(event("checkpoint.discarded"), store.discardDetails(storedPoint));
            store.clear();
          }
          return { stored: storedPoint, usable };
        },
        startIntervals() { if (live()) cadence = { processed, at: clock.now() }; },
        provideSnapshot(produce) { if (live()) snapshot = produce; },
        checkpoint() {
          if (!savable()) return false;
          cadence ??= { processed: 0, at: clock.now() };
          if (!shouldSaveCheckpoint(processed, cadence.processed, clock.now(), cadence.at)) return false;
          return save();
        },
      },
      complete(final) {
        if (!commit(final)) return "vetoed";
        settleResumePoint();
        return succeed(final);
      },
      async completeAfter(final) {
        if (!commit(final)) return "vetoed";
        settleResumePoint();
        phase = final.phase;
        update({ currentPhase: phase });
        await final.finalize();
        return succeed(final);
      },
    };
    /** The veto check and the mode's commit. False, with the run ended, when it is vetoed or no longer live. */
    const commit = (final: ScanRunCompletion) => {
      if (!live()) return false;
      if (hooks.veto?.()) {
        // Ends the run at once rather than leaving it running until it reads as an Interrupted scan.
        recordError(mode.vetoedError || mode.failureMessage, "veto");
        runLogger.warn(event("scan.vetoed"), { processed, total });
        return false;
      }
      final.commit();
      committed = true;
      hooks.committed?.();
      return true;
    };
    /** After the commit: a full run clears the Resume point; a single-show run prunes its show from it. */
    const settleResumePoint = () => {
      const store = mode.resumePoint;
      if (!store) return;
      if (runOptions.fullRun) store.clear();
      else if (storedPoint && runOptions.pruneResumePoint) {
        const next = runOptions.pruneResumePoint(storedPoint);
        if (next) store.write(next); else store.clear();
      }
    };
    /** After the commit and the settled Resume point: records the completed status and logs the completion. */
    const succeed = (final: ScanRunCompletion): "completed" => {
      hooks.succeeded?.();
      // A clean finish: replace, so no pause or active work survives the run.
      mode.status.write({ status: "completed", processed: final.processed, total: final.total, startedAt, finishedAt: final.finishedAt } as S);
      terminal = true;
      runLogger.info(event("scan.complete"), final.details);
      return "completed";
    };
    /**
     * One heartbeat tick. It runs from a timer, outside the run's error
     * boundary, so it must never throw. Recording is best effort: a failing
     * logger or status store is reported to the console and the run keeps
     * going, still owning the lock and its heartbeat until the body settles.
     * A missed beat at worst lets a later read call the run interrupted.
     */
    const beat = () => {
      // A queued tick after a terminal transition or settlement must never write running again.
      if (!live()) return;
      try {
        const activeShows = activeWork.snapshot();
        const heartbeatAt = iso();
        try { runLogger.info(event("scan.heartbeat"), { processed, total, activeShows, heartbeatAt }); } catch (logError) { reportSafely(`The ${label} scan could not log its heartbeat.`, logError); }
        update({ status: "running", processed, total, activeShows, currentShow: activeShows.length === 1 ? activeShows[0].show : undefined, currentPhase: activeShows.length > 1 ? `processing-${activeShows.length}-shows` : activeShows[0]?.phase || phase || "processing", heartbeatAt });
      } catch (error) {
        reportSafely(`The ${label} scan could not record its heartbeat.`, error);
      }
    };

    return dispatching.run({ kind: mode.kind, context: context as ScanRunContext<unknown> }, async () => {
      let failure: { error: unknown } | undefined;
      try {
        logger = runOptions.createLogger();
        hooks.begin?.();
        const previous = mode.status.read();
        if (previous?.status === "running") logger.warn(event("scan.interrupted-detected"), { previousStartedAt: previous.startedAt, processed: previous.processed, total: previous.total, currentShow: previous.currentShow, currentPhase: previous.currentPhase, lastHeartbeatAt: previous.heartbeatAt });
        logger.info(event("scan.start"), { startedAt, ...runOptions.startDetails });
        // A clean start: replace, never merge, so nothing from an earlier run survives.
        mode.status.write({ status: "running", processed: 0, total: 0, startedAt, ...(phase ? { currentPhase: phase } : {}), heartbeatAt: startedAt } as S);
        heartbeat = timers.setInterval(beat, HEARTBEAT_INTERVAL_MS);
        await body(context);
      } catch (error) {
        failure = { error };
      }
      let unrecorded = false;
      try {
        if (failure && !terminal) {
          // While still live and before its report committed: the completed, compatible work so far becomes the Resume point.
          if (!committed) forceSave("failure");
          terminal = true;
          const { error } = failure;
          try { hooks.failed?.(error); } catch (hookError) { report(`The ${label} scan failure hook failed.`, hookError); }
          unrecorded = !recordError(error instanceof Error ? error.message : mode.failureMessage, "failure");
          try {
            let details: LogDetails = {};
            try { details = hooks.failureDetails?.() || {}; } catch (detailsError) { report(`The ${label} scan failure details failed.`, detailsError); }
            logger.error(event("scan.error"), { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, ...details });
          } catch (logError) { report(`The ${label} scan could not log its failure.`, logError); }
        }
      } finally {
        try { hooks.ended?.(); } catch (endError) { report(`The ${label} scan end hook failed.`, endError); }
        settled = true;
        if (heartbeat !== undefined) timers.clearInterval(heartbeat);
        logger = silentLogger;
      }
      if (failure && unrecorded) throw failure.error;
    });
  }

  /**
   * Reads a mode's stored status, reconciling an Interrupted scan: with no live
   * run of that kind, a running status whose last heartbeat (or start) is more
   * than 90 seconds old becomes an error, written once, and the mode's
   * interruption hook runs once; later reads find the error and rewrite
   * nothing. A running status with a missing or invalid timestamp cannot be
   * aged and has no live owner, so it is interrupted at once.
   */
  function readStatus<S extends ScanRunStatus>(mode: ScanRunMode<S, unknown>): S | null {
    const status = mode.status.read();
    if (status?.status !== "running" || isActive(mode.kind)) return status;
    const lastActivity = Date.parse(status.heartbeatAt || status.startedAt || "");
    if (Number.isFinite(lastActivity) && clock.now() - lastActivity <= INTERRUPTED_AFTER_MS) return status;
    // Explained from the last running status, then reset like any terminal error: no pause, provider, resume time or active work survives.
    const error = mode.interruptedError(status);
    const interrupted: S = { ...status, status: "error", finishedAt: iso(), error, rateLimitPaused: false };
    for (const field of TRANSIENT_STATUS_FIELDS) delete interrupted[field];
    mode.status.write(interrupted);
    try { mode.onInterrupted?.(interrupted); } catch (error) { report(`The ${SCAN_RUN_LABELS[mode.kind]} interrupted scan hook failed.`, error); }
    return interrupted;
  }

  /**
   * The live Scan run that dispatched the current asynchronous work, of `kind`
   * when one is given. A late callback from a settled run, a callback from
   * another kind's run, and work outside any run get undefined.
   */
  function bound<P>(kind?: ScanRunKind): ScanRunContext<P> | undefined {
    const current = dispatching.getStore();
    if (!current || (kind && current.kind !== kind) || !current.context.isLive()) return undefined;
    return current.context as ScanRunContext<P>;
  }

  return {
    start,
    run,
    readStatus,
    bound,
    activeScanRun,
    /** Whether a Scan run of this kind (or of any kind, when omitted) owns the lock. */
    isActive,
  };
}

export type ScanRunLifecycle = ReturnType<typeof createScanRunLifecycle>;

/** The production lifecycle, sharing this process's owner record. */
export const scanRuns: ScanRunLifecycle = createScanRunLifecycle();
