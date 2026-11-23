/**
 * ADR-0004 decisions for one TVDB episode's TMDB external-ID crosswalk, as pure functions:
 * values in, decision out, with no store, clock or hidden context. A coordinator reads the
 * comparison's saved copy, the shared crosswalk evidence and the show's recorded failure, and
 * applies the decision.
 */

/** A comparison's own saved copy of the crosswalk response; undated when its receipt time was removed or never recorded. */
export type CrosswalkCopy = { value: unknown; receivedAt?: string };

/**
 * The shared crosswalk evidence for one TVDB episode: a usable response with its receipt time,
 * or a rejection (an unreadable payload keeps its value). `invalidatedAt` marks a usable response
 * not current for live scans after one show's cache was cleared; offline rechecks still replay it.
 * This is the stored shape of shared crosswalk evidence (`SharedTmdbCrosswalk` in plex-catalogues).
 */
export type SharedCrosswalkRecord = { value?: unknown; receivedAt?: string; rejectedAt?: string; invalidatedAt?: string };

/** A UTC ISO 8601 time, as `Date.prototype.toISOString` writes it: its first ten characters are its UTC date. */
const UTC_ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/** How a live scan reaches the lookup. */
export type LiveCrosswalkInput = {
  shared: SharedCrosswalkRecord | undefined;
  /** The scan run's start time as a UTC ISO 8601 time ending in `Z` (`toISOString`); its date is the scan's starting UTC date. Any other form is refused. */
  scanStartedAt: string;
  /** A single-show rescan, provider-change invalidation, TVDB ID change, stale alias or a retry of the show's own failed crosswalk. */
  forced: boolean;
  /** A request for this lookup has settled during this scan, failures included. */
  requestedInThisScan: boolean;
};

/**
 * `reuse`: the comparison takes the shared response as its copy, with its original receipt time,
 * and that resolves its failed request for the lookup. `request`: the comparison's copy is
 * discarded and the lookup is requested, or joins the request already in flight.
 */
export type LiveCrosswalkDecision = { action: "reuse"; copy: CrosswalkCopy } | { action: "request" };

/**
 * Episode crosswalk freshness with shared crosswalk evidence. An ordinary lookup reuses a usable,
 * not-invalidated shared response received on or after the scan's starting UTC date; a forced
 * lookup accepts only one requested during this scan. Neither renews the receipt time, and an
 * undated or unreadable shared outcome is never current.
 */
export function liveTmdbCrosswalkDecision({ shared, scanStartedAt, forced, requestedInThisScan }: LiveCrosswalkInput): LiveCrosswalkDecision {
  if (!UTC_ISO_TIME.test(scanStartedAt) || !Number.isFinite(Date.parse(scanStartedAt))) throw new RangeError(`The scan's start time must be a UTC ISO 8601 time ending in Z, not ${JSON.stringify(scanStartedAt)}.`);
  if (!shared?.receivedAt || shared.invalidatedAt) return { action: "request" };
  const received = Date.parse(shared.receivedAt);
  const current = Number.isFinite(received)
    && (forced ? requestedInThisScan : new Date(received).toISOString().slice(0, 10) >= scanStartedAt.slice(0, 10));
  return current ? { action: "reuse", copy: { value: shared.value, receivedAt: shared.receivedAt } } : { action: "request" };
}

/** The comparison's failed-request Coverage Issue for the lookup: open, with its failure time when one was recorded. */
export type RecordedCrosswalkFailure = { open: true; failedAt?: string };

/** What an offline cached recheck has for the lookup. */
export type ReplayedCrosswalkInput = {
  /** The comparison's own saved copy; absent when it has none. */
  copy: CrosswalkCopy | undefined;
  shared: SharedCrosswalkRecord | undefined;
  /** The comparison's open failed-request Coverage Issue for the lookup, if any. */
  failure: RecordedCrosswalkFailure | undefined;
};

/**
 * `replay-copy`: the comparison's own copy stands. `unavailable`: it has no copy and none can be
 * recovered. `replay-shared`: the copy is replaced in memory by the shared outcome (a usable
 * response with its receipt time, or an undated unreadable payload). `drop`: a rejection without
 * a payload removes the copy. `recover`: the shared answer fills the missing copy; the recheck
 * saves it as the comparison's own copy and only then resolves the failed request.
 */
export type ReplayedCrosswalkDecision =
  | { action: "replay-copy" }
  | { action: "unavailable" }
  | { action: "replay-shared"; copy: CrosswalkCopy }
  | { action: "drop" }
  | { action: "recover"; copy: CrosswalkCopy };

/**
 * An offline recheck replays the comparison's copy unless the shared outcome is newer (an undated
 * copy counts as older; equal times keep the copy). Without a copy, a usable shared answer is
 * recovered only after the comparison's own failed request, when that failure's time is recorded
 * and strictly earlier than the answer. An invalidation mark does not affect replay. Replay never
 * renews a receipt time.
 */
export function replayedTmdbCrosswalkDecision({ copy, shared, failure }: ReplayedCrosswalkInput): ReplayedCrosswalkDecision {
  const outcomeAt = Date.parse(shared?.receivedAt || shared?.rejectedAt || "");
  if (!shared || !Number.isFinite(outcomeAt)) return copy ? { action: "replay-copy" } : { action: "unavailable" };
  if (!copy) {
    const failedAt = Date.parse(failure?.failedAt || "");
    if (!shared.receivedAt || !Number.isFinite(failedAt) || outcomeAt <= failedAt) return { action: "unavailable" };
    return { action: "recover", copy: { value: shared.value, receivedAt: shared.receivedAt } };
  }
  const savedAt = Date.parse(copy.receivedAt || "");
  if (Number.isFinite(savedAt) && savedAt >= outcomeAt) return { action: "replay-copy" };
  if (shared.receivedAt) return { action: "replay-shared", copy: { value: shared.value, receivedAt: shared.receivedAt } };
  if (Object.hasOwn(shared, "value")) return { action: "replay-shared", copy: { value: shared.value } };
  return { action: "drop" };
}
