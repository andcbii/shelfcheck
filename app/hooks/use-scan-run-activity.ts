"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseActiveScanRun, scanRunLockMessage, type ActiveScanRun, type ScanRunActivityKind } from "@/lib/scan-run-activity";

type ScanRunActivityOptions = {
  /** Called on each observation that finds a Scan run of this page's own kind, for example one started in another tab. */
  onOwnKindRunning: (run: ActiveScanRun) => void;
  intervalMs?: number;
};

/**
 * Observes which Scan run owns the lock, through GET /api/scan-runs, for as
 * long as the page is mounted: once on mount, then about once a second whether
 * the page is idle or scanning, with one request in flight at a time. It is
 * kept apart from the page's own scanning and progress state, so it never
 * makes the page look like it is scanning.
 *
 * A failed or malformed observation keeps the last known owner; it is never
 * taken to mean the lock was released. A response that started before a newer
 * observation (a refresh or a reported 409) is ignored. The server still
 * refuses a conflicting start; this only keeps the page's controls honest.
 */
export function useScanRunActivity(page: ScanRunActivityKind, options: ScanRunActivityOptions) {
  const [activeScanRun, setActiveScanRun] = useState<ActiveScanRun | null>(null);
  const activeRef = useRef<ActiveScanRun | null>(null);
  const onOwnKindRunningRef = useRef(options.onOwnKindRunning);
  const versionRef = useRef(0);
  const wakeRef = useRef<() => void>(() => {});
  const intervalMs = options.intervalMs ?? 1000;
  useEffect(() => { onOwnKindRunningRef.current = options.onOwnKindRunning; }, [options.onOwnKindRunning]);

  const apply = useCallback((run: ActiveScanRun | null) => {
    versionRef.current += 1;
    activeRef.current = run;
    setActiveScanRun((current) => current?.kind === run?.kind && current?.startedAt === run?.startedAt ? current : run);
    if (run?.kind === page) onOwnKindRunningRef.current(run);
  }, [page]);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let refreshRequested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    async function observe() {
      if (stopped) return;
      if (inFlight) { refreshRequested = true; return; }
      clearTimeout(timer);
      inFlight = true;
      const version = versionRef.current;
      controller = new AbortController();
      try {
        const response = await fetch("/api/scan-runs", { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => undefined) as { activeScanRun?: unknown } | undefined;
        const run = response.ok ? parseActiveScanRun(body?.activeScanRun) : undefined;
        if (!stopped && run !== undefined && versionRef.current === version) apply(run);
      } catch { /* A failed observation keeps the last known owner. */ }
      inFlight = false;
      controller = undefined;
      if (stopped) return;
      if (refreshRequested) { refreshRequested = false; void observe(); return; }
      timer = setTimeout(() => void observe(), intervalMs);
    }

    const observeOnReturn = () => { if (document.visibilityState === "visible") void observe(); };
    wakeRef.current = () => void observe();
    document.addEventListener("visibilitychange", observeOnReturn);
    void observe();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      wakeRef.current = () => {};
      document.removeEventListener("visibilitychange", observeOnReturn);
    };
  }, [apply, intervalMs]);

  /** Observes again now, for example after the page's own Scan run completes. */
  const refresh = useCallback(() => wakeRef.current(), []);
  /** Records an owner the server reported (a 409's `activeScanRun`), then observes again now. */
  const report = useCallback((value: unknown) => {
    const run = parseActiveScanRun(value);
    if (run !== undefined) apply(run);
    wakeRef.current();
  }, [apply]);
  /** The other kind's Scan run that locks this page's scan controls, read at call time for handler guards. */
  const lockingScanRun = useCallback(() => activeRef.current && activeRef.current.kind !== page ? activeRef.current : null, [page]);

  const locking = activeScanRun && activeScanRun.kind !== page ? activeScanRun : null;
  return { locked: Boolean(locking), lockMessage: locking ? scanRunLockMessage(locking.kind, page) : "", lockingScanRun, refresh, report };
}
