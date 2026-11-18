/**
 * The Resume point age rule both scan modes share: a Resume point is usable
 * for less than 6 hours after it was saved. Exactly 6 hours old is unusable.
 */
export const RESUME_POINT_MAX_AGE_MS = 6 * 3_600_000;

/**
 * Whether a Resume point saved at `savedAt` is still young enough to resume
 * from at `now`: `savedAt` must be a string that parses, under the maximum
 * age. With `rejectFuture`, a future-dated point is unusable too; without it
 * (the Plex rule), a future-dated point counts as fresh.
 */
export function resumePointIsFresh(savedAt: unknown, now: number, options: { rejectFuture?: boolean } = {}): boolean {
  if (typeof savedAt !== "string") return false;
  const saved = Date.parse(savedAt);
  return Number.isFinite(saved) && !(options.rejectFuture && saved > now) && now - saved < RESUME_POINT_MAX_AGE_MS;
}
