import { createScanRunLifecycle, type ScanRunContext, type ScanRunKind, type ScanRunMode, type ScanRunStatus } from "../lib/scan-run";
import type { ProviderClock } from "../lib/provider-client";

type Timer = { at: number; order: number; fire: () => void; cancelled?: boolean };

/**
 * A virtual clock for the provider client: sleeps and attempt deadlines fire
 * only as `runUntil` or `advance` moves time, so pacing, Retry-After and
 * timeouts are checked in exact milliseconds without real waiting.
 */
export function fakeClock(start = Date.parse("2026-11-19T12:00:00.000Z")) {
  let now = start;
  let order = 0;
  const timers: Timer[] = [];
  const schedule = (milliseconds: number, fire: () => void) => {
    const timer: Timer = { at: now + Math.max(0, milliseconds), order: order++, fire };
    timers.push(timer);
    return timer;
  };
  const clock: ProviderClock = {
    now: () => now,
    sleep: (milliseconds) => new Promise<void>((resolve) => { schedule(milliseconds, resolve); }),
    deadline: (milliseconds) => {
      const controller = new AbortController();
      const timer = schedule(milliseconds, () => controller.abort(new DOMException("The attempt timed out.", "TimeoutError")));
      return { signal: controller.signal, clear: () => { timer.cancelled = true; } };
    },
  };
  const flush = async () => { for (let index = 0; index < 25; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const nextTimer = () => {
    for (let index = timers.length - 1; index >= 0; index -= 1) if (timers[index].cancelled) timers.splice(index, 1);
    timers.sort((left, right) => left.at - right.at || left.order - right.order);
    return timers[0];
  };
  const fireNext = () => {
    const timer = nextTimer();
    if (!timer) return false;
    timers.shift();
    now = Math.max(now, timer.at);
    timer.fire();
    return true;
  };
  return {
    clock,
    now: () => now,
    elapsed: () => now - start,
    /** Moves time forward by `milliseconds`, firing every timer due on the way. */
    async advance(milliseconds: number) {
      const target = now + milliseconds;
      await flush();
      for (let timer = nextTimer(); timer && timer.at <= target; timer = nextTimer()) { fireNext(); await flush(); }
      now = target;
      await flush();
    },
    /** Fires timers in time order until `promise` settles, then returns its outcome. */
    async runUntil<T>(promise: Promise<T>): Promise<T> {
      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      await flush();
      // With no timer due, real I/O (such as a config file write) may still be finishing: give it real time.
      for (let step = 0, idle = 0; !settled && step < 10_000; step += 1) {
        if (fireNext()) { idle = 0; await flush(); continue; }
        if ((idle += 1) > 200) throw new Error("The promise is waiting on something other than the clock.");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return promise;
    },
  };
}

export type RecordedLine = { runId: string; level: "info" | "warn" | "error"; event: string; details?: Record<string, unknown> };

/**
 * Scan runs through a real lifecycle with in-memory status stores for both
 * kinds, recording every log line and status with the run that wrote it.
 */
export function runHarness(now: () => number) {
  const runs = createScanRunLifecycle({ clock: { now }, state: {}, timers: { setInterval: () => 0, clearInterval: () => {} } });
  const lines: RecordedLine[] = [];
  const statuses: Partial<Record<ScanRunKind, ScanRunStatus>> = {};
  const mode = (kind: ScanRunKind): ScanRunMode<ScanRunStatus, never> => ({
    kind,
    eventPrefix: kind === "plex" ? "plex" : "",
    failureMessage: `The ${kind} scan failed.`,
    status: { read: () => statuses[kind] ? structuredClone(statuses[kind]!) : null, write: (status) => { statuses[kind] = structuredClone(status); } },
    interruptedError: () => "Interrupted.",
  });
  /** Starts a run of `kind` whose body is `body`; resolves with the run id and its settled promise. */
  function start(kind: ScanRunKind, body: (run: ScanRunContext<never>) => Promise<void>) {
    let runId = "";
    const started = runs.start(kind, (owner) => {
      runId = owner.runId;
      const record = (level: RecordedLine["level"]) => (event: string, details?: Record<string, unknown>) => { lines.push({ runId: owner.runId, level, event, details }); };
      return runs.run(owner, mode(kind), { fullRun: false, createLogger: () => ({ info: record("info"), warn: record("warn"), error: record("error") }) }, body);
    });
    return { runId, settled: started.settled };
  }
  return { runs, lines, statuses, start, linesOf: (runId: string) => lines.filter((line) => line.runId === runId) };
}

/** A fetch fake answering each request from `respond`, recording what was asked. */
export function fakeFetch(respond: (request: { url: URL; init: RequestInit; index: number }) => Response | Promise<Response>) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push({ url, init });
    return respond({ url, init, index: requests.length - 1 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
