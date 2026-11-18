import { randomUUID } from "node:crypto";

/**
 * The scan run lifecycle: the one place that decides whether a Scan run, Trakt
 * or Plex, full or single-show, may start, and that owns it until all its work
 * settles. Only one Scan run is active at a time across both kinds.
 *
 * This module starts with ownership. Status transitions, the heartbeat,
 * Interrupted scan reconciliation and Resume point policy join it later; the
 * run body already receives its owner record so those can bind to its run
 * identity. It must not import the scan modes back.
 */

export type ScanRunKind = "trakt" | "plex";

/** Who holds the lock: the kind, a unique run identity and when ownership was claimed. */
export type ScanRunOwner = { kind: ScanRunKind; runId: string; startedAt: string };

export type ScanRunClock = { now: () => number };

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

export const SCAN_RUN_LABELS: Record<ScanRunKind, string> = { trakt: "Trakt", plex: "Plex" };

/** A start refused because another Scan run, of either kind, owns the lock. */
export class ScanRunConflictError extends Error {
  readonly status = 409;
  constructor(readonly owner: ScanRunOwner, requested: ScanRunKind) {
    const running = SCAN_RUN_LABELS[owner.kind];
    super(owner.kind === requested
      ? `A ${running} scan is running. You can start another ${running} scan when it finishes.`
      : `A ${running} scan is running. You can start a ${SCAN_RUN_LABELS[requested]} scan when it finishes.`);
    this.name = "ScanRunConflictError";
  }
}

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

export function createScanRunLifecycle(options: { clock?: ScanRunClock; state?: ScanRunState; newRunId?: () => string } = {}) {
  const clock = options.clock || { now: Date.now };
  const newRunId = options.newRunId || randomUUID;
  const state = () => options.state || processState();

  function activeScanRun(): ScanRunOwner | null {
    return state().owner || null;
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
    const owner: ScanRunOwner = { kind, runId: newRunId(), startedAt: new Date(clock.now()).toISOString() };
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

  return {
    start,
    activeScanRun,
    /** Whether a Scan run of this kind (or of any kind, when omitted) owns the lock. */
    isActive: (kind?: ScanRunKind) => { const owner = activeScanRun(); return Boolean(owner && (!kind || owner.kind === kind)); },
  };
}

export type ScanRunLifecycle = ReturnType<typeof createScanRunLifecycle>;

/** The production lifecycle, sharing this process's owner record. */
export const scanRuns: ScanRunLifecycle = createScanRunLifecycle();
