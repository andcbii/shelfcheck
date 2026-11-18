"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseActiveScanRun, scanRunLockMessage, type ActiveScanRun, type ScanRunKind } from "@/lib/scan-run-activity";

type ScanRunActivityOptions = {
  /** Whether the page is already following its own kind's Scan run: a start it requested, or its progress poller. */
  isFollowing: () => boolean;
  /** The page's progress poll: follows its own kind's Scan run until it finishes, handling its own errors. */
  poll: () => Promise<unknown>;
  intervalMs?: number;
};

/**
 * Observes which Scan run owns the lock, through GET /api/scan-runs, for as
 * long as the page is mounted: once on mount, then about once a second whether
 * the page is idle or scanning, with one request in flight at a time. It is
 * kept apart from the page's own scanning and progress state, so it never
 * makes the page look like it is scanning.
 *
 * An observation that finds a Scan run of the page's own kind, for example one
 * started in another tab, follows it with the page's progress poll once, unless
 * the page is already following one, then observes again when the poll ends.
 *
 * Until the first observation arrives the owner is unknown, and an unknown
 * owner locks the scan controls and handler guards without a lock message. A
 * failed or malformed observation keeps the last known owner (or leaves it
 * unknown); it is never taken to mean the lock was released. A response that started before a newer
 * observation (a refresh or a reported 409) is ignored. The server still
 * refuses a conflicting start; this only keeps the page's controls honest.
 */
export function useScanRunActivity(page: ScanRunKind, options: ScanRunActivityOptions) {
  // undefined: no observation has arrived yet, so the owner is unknown.
  const [activeScanRun, setActiveScanRun] = useState<ActiveScanRun | null | undefined>(undefined);
  const activeRef = useRef<ActiveScanRun | null | undefined>(undefined);
  const followRef = useRef({ isFollowing: options.isFollowing, poll: options.poll });
  // The own-kind Scan run this page last followed, so another tab's run starts the progress poll once.
  const followedRef = useRef<string | null>(null);
  const versionRef = useRef(0);
  const wakeRef = useRef<() => void>(() => {});
  const intervalMs = options.intervalMs ?? 1000;
  useEffect(() => { followRef.current = { isFollowing: options.isFollowing, poll: options.poll }; }, [options.isFollowing, options.poll]);

  const followOwnScanRun = useCallback((run: ActiveScanRun) => {
    const alreadyFollowing = followRef.current.isFollowing();
    if (!alreadyFollowing && followedRef.current === run.startedAt) return;
    followedRef.current = run.startedAt;
    if (alreadyFollowing) return;
    void followRef.current.poll().finally(() => wakeRef.current());
  }, []);

  const apply = useCallback((run: ActiveScanRun | null) => {
    versionRef.current += 1;
    activeRef.current = run;
    setActiveScanRun((current) => current === run || (current && run && current.kind === run.kind && current.startedAt === run.startedAt) ? current : run);
    if (run?.kind === page) followOwnScanRun(run);
  }, [page, followOwnScanRun]);

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
  /** Whether this page's scan controls are locked, read at call time for handler guards. */
  const isLocked = useCallback(() => locks(activeRef.current, page), [page]);

  const locking = activeScanRun && activeScanRun.kind !== page ? activeScanRun : null;
  return { locked: locks(activeScanRun, page), lockMessage: locking ? scanRunLockMessage(locking.kind, page) : "", isLocked, refresh, report };
}

/** An unknown owner (undefined) or the other kind's Scan run locks the page's scan controls. */
function locks(run: ActiveScanRun | null | undefined, page: ScanRunKind) {
  return run === undefined || (run !== null && run.kind !== page);
}
