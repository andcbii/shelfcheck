import "server-only";

import type { DatabaseSync } from "node:sqlite";
import { ignoredPlexKeys, ignoredTraktIds } from "@/lib/ignored-shows";
import { database, rawSavedScanState, type SavedScanStateSnapshot, type ScanMode } from "@/lib/sqlite";

/**
 * The Ignore module: every Ignore rule over saved scan state lives here, and this is
 * the only public saved scan state store. Ignored results are deleted, not hidden, so
 * a Restore cannot bring them back. The database module (lib/sqlite.ts) only stores
 * and loads; a lint rule lets only this module use its raw saved scan state store.
 * The client-safe Active ignore rules stay in lib/ignored-shows.ts and are reused here.
 */

type IgnoreCache = typeof globalThis & {
  __shelfcheckScanIgnoreGuards?: Partial<Record<ScanMode, Set<string>>>;
  __shelfcheckIgnoreNormalizedHandles?: WeakSet<DatabaseSync>;
};

const SCAN_MODES: readonly ScanMode[] = ["trakt", "plex"];

/** Each mode's actively ignored show keys, as the strings its saved results are keyed by. */
const activeIgnoreKeys: Record<ScanMode, (ignoredShows: unknown, now?: number) => string[]> = {
  trakt: (ignoredShows, now) => [...ignoredTraktIds(ignoredShows, now)].map(String),
  plex: (ignoredShows, now) => [...ignoredPlexKeys(ignoredShows, now)],
};

function scanIgnoreGuards() {
  const cache = globalThis as IgnoreCache;
  return cache.__shelfcheckScanIgnoreGuards ||= {};
}

/**
 * Start a mode's scan ignore guard, seeded from the Ignores active at the scan's start
 * time. An Ignore applied during the scan is added to it and invalidates that scan's
 * results even if the user Restores the show before its pending provider requests
 * finish; neither Restore nor expiry removes a key. One guard per mode, process-local.
 * The returned cleanup removes only the guard it created, never a newer scan's.
 */
export function trackScanIgnores(mode: ScanMode, now = Date.now()): () => void {
  const guard = new Set(activeIgnoreKeys[mode](store(mode).readOptions().ignoredShows, now));
  scanIgnoreGuards()[mode] = guard;
  return () => {
    if (scanIgnoreGuards()[mode] === guard) delete scanIgnoreGuards()[mode];
  };
}

function recordScanIgnores(mode: ScanMode, ignored: Iterable<string>) {
  const guard = scanIgnoreGuards()[mode];
  if (guard) for (const key of ignored) guard.add(key);
}

/** The shows whose results a mode may not keep: its actively ignored shows, plus the running scan's guard. */
function blockedShowKeys(mode: ScanMode, ignoredShows: unknown) {
  return new Set([...activeIgnoreKeys[mode](ignoredShows), ...(scanIgnoreGuards()[mode] || [])]);
}

/**
 * A report or Resume point without the blocked shows: their shows and missing rows (keyed
 * by Plex rating key or Trakt show ID) and scan cache entries are removed together. Plex
 * ownership evidence, catalogues, Manual Matches, carried members and refresh obligations
 * live elsewhere and are never pruned.
 */
function pruneIgnoredResults<T>(value: T, mode: ScanMode, blocked: Set<string>): T {
  if (!value || typeof value !== "object" || !blocked.size) return value;
  const report = value as Record<string, unknown>;
  const isVisible = (item: unknown) => {
    if (!item || typeof item !== "object") return true;
    const row = item as { ratingKey?: string; show?: { ids?: { trakt?: number } } };
    const key = mode === "plex" ? row.ratingKey : String(row.show?.ids?.trakt);
    return key === undefined || !blocked.has(key);
  };
  return {
    ...report,
    ...(Array.isArray(report.shows) ? { shows: report.shows.filter(isVisible) } : {}),
    ...(Array.isArray(report.missing) ? { missing: report.missing.filter(isVisible) } : {}),
    ...(report.scanCache && typeof report.scanCache === "object" ? {
      scanCache: Object.fromEntries(Object.entries(report.scanCache).filter(([key]) => !blocked.has(key))),
    } : {}),
  } as T;
}

type RawStore = ReturnType<typeof rawSavedScanState>;

/**
 * Remove blocked shows from a mode's saved report and Resume point through the raw
 * store's maintenance update, so the state timestamp does not move. Only a part that
 * changed is written; a part that is not a JSON object is left as stored.
 */
function pruneSavedResults(raw: RawStore, mode: ScanMode, blocked: Set<string>) {
  const saved = raw.read();
  if (!saved) return;
  const parts: { report?: unknown; resumePoint?: unknown } = {};
  for (const part of ["report", "resumePoint"] as const) {
    const pruned = pruneIgnoredResults(saved[part], mode, blocked);
    if (JSON.stringify(pruned) !== JSON.stringify(saved[part])) parts[part] = pruned;
  }
  if (Object.keys(parts).length) raw.replaceResults(parts);
}

/**
 * Normalization: older versions kept results when an Ignore was applied. Before the
 * first saved scan state operation of any kind on a database handle (read, snapshot,
 * options read or patch including Restore, status, scan start, any write), both
 * modes' retained results of active Ignores are removed, so no read or Restore can
 * expose them. Whether an Ignore is active is judged at that first use, not when the
 * handle opened (SHELFCHECK-42 decision 1: a temporary Ignore that expires in between
 * keeps its retained results). It runs on the given handle through the raw store only.
 *
 * It is recorded per actual handle, so a reopened handle is normalized again. A failure
 * surfaces and is retried by the next operation. Inside an open transaction success is
 * not recorded, since the transaction may roll back; a later operation runs it again.
 */
function normalizeOnFirstUse(db: DatabaseSync) {
  const cache = globalThis as IgnoreCache;
  const normalized = cache.__shelfcheckIgnoreNormalizedHandles ||= new WeakSet();
  if (normalized.has(db)) return;
  for (const mode of SCAN_MODES) {
    const raw = rawSavedScanState(mode, db);
    pruneSavedResults(raw, mode, blockedShowKeys(mode, raw.read()?.options?.ignoredShows));
  }
  if (!db.isTransaction) normalized.add(db);
}

/** The raw store of a mode on the open handle, normalized before its first use. */
function store(mode: ScanMode) {
  const db = database();
  normalizeOnFirstUse(db);
  return rawSavedScanState(mode, db);
}

function prunedForSave(raw: RawStore, mode: ScanMode, value: unknown) {
  return pruneIgnoredResults(value, mode, blockedShowKeys(mode, raw.readOptions().ignoredShows));
}

/**
 * Merge the supplied option fields over the saved ones. Only a patch that has its own
 * ignoredShows (an empty list on Restore included) touches the report and Resume
 * point or the guard: it records the Ignores for a running scan and removes the saved
 * results of every show blocked by the patch's active Ignores plus the guard.
 */
function patchOptions(raw: RawStore, mode: ScanMode, patch: Record<string, unknown>) {
  const options = { ...raw.readOptions(), ...patch };
  const ignoring = Object.prototype.hasOwnProperty.call(patch, "ignoredShows");
  // The running scan is marked before the save, as before: a save that then fails
  // still leaves the guard marked. This known guard-before-save gap is kept
  // deliberately until SHELFCHECK-158 applies SHELFCHECK-42 decision 2.
  if (ignoring) recordScanIgnores(mode, activeIgnoreKeys[mode](patch.ignoredShows));
  raw.writeOptions(options);
  if (ignoring) pruneSavedResults(raw, mode, blockedShowKeys(mode, options.ignoredShows));
}

export type { SavedScanStateSnapshot };

/**
 * The saved scan state of one scan mode: its report, Resume point, scan status and
 * options. Options are the mode's Settings and Ignore Preferences, kept together in one
 * JSON object. Each write changes only its own part. Report and Resume point writes
 * remove actively ignored results first; an options patch that sets ignoredShows
 * records them for a running scan and prunes the saved report and Resume point.
 * Operations join a transaction already open on the database instead of nesting one.
 */
export type SavedScanState<R, P, S, O> = {
  report: { read(): R | null; write(report: R): void };
  resumePoint: { read(): P | null; write(point: P): void; clear(): void };
  status: { read(): S | null; write(status: S): void };
  options: { read(): O; patch(patch: Partial<O>): void };
  /** All four parts and the state timestamp in one statement; null when the mode has no row. */
  snapshot(): SavedScanStateSnapshot<R, P, S, O> | null;
  /** Saves a finished report and clears its Resume point, as one write. */
  commitReport(report: R): void;
  /** Clears the report and its Resume point, as one write. */
  clearReportAndResumePoint(): void;
};

/** The saved scan state store bound to one mode; the caller supplies the mode's own part types. */
export function savedScanState<
  R = Record<string, unknown>, P = Record<string, unknown>, S = Record<string, unknown>, O extends Record<string, unknown> = Record<string, unknown>,
>(mode: ScanMode): SavedScanState<R, P, S, O> {
  return {
    report: {
      read: () => (store(mode).read()?.report ?? null) as R | null,
      write: (report) => { const raw = store(mode); raw.writeReport(prunedForSave(raw, mode, report)); },
    },
    resumePoint: {
      read: () => (store(mode).read()?.resumePoint ?? null) as P | null,
      write: (point) => { const raw = store(mode); raw.writeResumePoint(prunedForSave(raw, mode, point)); },
      clear: () => store(mode).clearResumePoint(),
    },
    status: {
      read: () => (store(mode).read()?.status ?? null) as S | null,
      write: (status) => store(mode).writeStatus(status),
    },
    options: {
      read: () => store(mode).readOptions() as O,
      patch: (patch) => { const raw = store(mode); raw.inTransaction(() => patchOptions(raw, mode, patch)); },
    },
    snapshot: () => store(mode).read() as SavedScanStateSnapshot<R, P, S, O> | null,
    commitReport: (report) => { const raw = store(mode); raw.commitReport(prunedForSave(raw, mode, report)); },
    clearReportAndResumePoint: () => store(mode).clearReportAndResumePoint(),
  };
}
