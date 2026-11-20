export type IgnoreDuration = "30d" | "90d" | "6m" | "forever";
export type IgnoreTiming = { expiresAt?: string; duration?: IgnoreDuration };

export const IGNORE_DURATIONS: { value: IgnoreDuration; label: string }[] = [
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "6m", label: "6 months" },
  { value: "forever", label: "Forever" },
];

export function createIgnoreTiming(duration: IgnoreDuration, now = new Date()): IgnoreTiming {
  if (duration === "forever") return { duration };
  const expires = new Date(now.getTime());
  if (duration === "6m") {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 7, 0).getDate();
    expires.setFullYear(now.getFullYear(), now.getMonth() + 6, Math.min(now.getDate(), lastDay));
  } else {
    expires.setTime(expires.getTime() + (duration === "30d" ? 30 : 90) * 86_400_000);
  }
  return { duration, expiresAt: expires.toISOString() };
}

/** Keeps finite, non-negative season numbers, truncated, de-duplicated and sorted; season 0 is kept. */
export function normalizeIgnoredSeasons(seasons: unknown): number[] {
  if (!Array.isArray(seasons)) return [];
  return [...new Set(seasons.filter((season): season is number => typeof season === "number" && Number.isFinite(season) && season >= 0).map(Math.trunc))].sort((a, b) => a - b);
}

export function isIgnoreActive(rule: IgnoreTiming, now = Date.now()): boolean {
  if (rule.expiresAt === undefined) return true;
  return typeof rule.expiresAt === "string" && Date.parse(rule.expiresAt) > now;
}

export function activeIgnores<T extends IgnoreTiming>(rules: readonly T[], now = Date.now()): T[] {
  return rules.filter((rule) => isIgnoreActive(rule, now));
}

export function ignoredTraktIds(value: unknown, now = Date.now()): Set<number> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((show) => {
    if (!show || typeof show !== "object" || !isIgnoreActive(show as IgnoreTiming, now)) return [];
    const id = (show as { ids?: { trakt?: unknown } }).ids?.trakt;
    return typeof id === "number" && Number.isFinite(id) ? [id] : [];
  }));
}

export function ignoredPlexKeys(value: unknown, now = Date.now()): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((show) => {
    if (!show || typeof show !== "object" || !isIgnoreActive(show as IgnoreTiming, now)) return [];
    const key = (show as { ratingKey?: unknown }).ratingKey;
    return typeof key === "string" && key ? [key] : [];
  }));
}

// Ignore list rules shared by the Trakt and Plex pages. Each operation takes one
// clock value, never changes its inputs and returns a new list. Keys are compared
// exactly: Trakt reads numbers, Plex reads strings.

export type IgnoreKey = string | number;
type TitledRule = { title: string };

function byTitle(a: TitledRule, b: TitledRule): number {
  return a.title.localeCompare(b.title);
}

/** Ignores a whole show: replaces any rule for the same key, keeps other active rules, sorts by title. */
export function applyIgnore<R extends TitledRule, K extends IgnoreKey>(rules: readonly (R & IgnoreTiming)[], keyOf: (rule: R) => K, record: R, duration: IgnoreDuration, now: number): (R & IgnoreTiming)[] {
  const key = keyOf(record);
  return [...activeIgnores(rules, now).filter((rule) => keyOf(rule) !== key), { ...record, ...createIgnoreTiming(duration, new Date(now)) }].sort(byTitle);
}

/** Restores one rule (whole-show or seasons, whichever list is given) and keeps other active rules. */
export function restoreIgnore<T extends IgnoreTiming, K extends IgnoreKey>(rules: readonly T[], keyOf: (rule: T) => K, key: K, now: number): T[] {
  return activeIgnores(rules, now).filter((rule) => keyOf(rule) !== key);
}

/** Gives one rule a new timing from the clock value; Forever clears any expiry. Keeps other active rules. */
export function changeIgnoreDuration<T extends IgnoreTiming, K extends IgnoreKey>(rules: readonly T[], keyOf: (rule: T) => K, key: K, duration: IgnoreDuration, now: number): T[] {
  const timing = createIgnoreTiming(duration, new Date(now));
  return activeIgnores(rules, now).map((rule) => keyOf(rule) === key ? { ...rule, expiresAt: undefined, ...timing } : rule);
}

// Season selections: the page supplies candidate season numbers from its own
// report; no report shapes enter this module.

type SeasonsRule = { seasons: number[] } & IgnoreTiming;
export type SeasonIgnoreDraft = { selected: number[]; options: number[]; duration: IgnoreDuration; originalTiming: IgnoreTiming | null };

function bySeason(a: number, b: number): number {
  return a - b;
}

/** Opens a season selection from the active rule for the key: its seasons, their sorted union with the candidates, its duration (Forever when none) and a copy of its timing. */
export function openSeasonIgnore<T extends SeasonsRule, K extends IgnoreKey>(rules: readonly T[], keyOf: (rule: T) => K, key: K, candidateSeasons: readonly number[], now: number): SeasonIgnoreDraft {
  const existing = activeIgnores(rules, now).find((rule) => keyOf(rule) === key);
  return {
    selected: [...(existing?.seasons || [])],
    options: [...new Set([...(existing?.seasons || []), ...candidateSeasons])].sort(bySeason),
    duration: existing?.duration || "forever",
    originalTiming: existing ? { expiresAt: existing.expiresAt, duration: existing.duration } : null,
  };
}

/**
 * Saves a season selection for the record's key. An unchanged duration keeps the original timing
 * (including a legacy expiry with no duration); otherwise a new timing starts from the clock value.
 * An empty selection, or one whose timing is no longer active, removes the rule. Sorts by title.
 */
export function saveSeasonIgnore<R extends TitledRule, K extends IgnoreKey>(rules: readonly (R & SeasonsRule)[], keyOf: (rule: R) => K, record: R, draft: Pick<SeasonIgnoreDraft, "selected" | "duration" | "originalTiming">, now: number): (R & SeasonsRule)[] {
  const original = draft.originalTiming;
  const timing: IgnoreTiming = original && (original.duration || "forever") === draft.duration
    ? { expiresAt: original.expiresAt, duration: original.duration }
    : createIgnoreTiming(draft.duration, new Date(now));
  const key = keyOf(record);
  const next = activeIgnores(rules, now).filter((rule) => keyOf(rule) !== key);
  if (draft.selected.length && isIgnoreActive(timing, now)) next.push({ ...record, seasons: [...draft.selected].sort(bySeason), ...timing });
  return next.sort(byTitle);
}

// Ignored Shows manager keys: "show|<key>" and "seasons|<key>". A UI transport
// detail only; list operations take typed keys.

export type IgnoreKind = "show" | "seasons";
export type IgnoreManagerTarget<K extends IgnoreKey> = { kind: IgnoreKind; key: K };

export function ignoreManagerKey(kind: IgnoreKind, key: IgnoreKey): string {
  return `${kind}|${key}`;
}

/** Decodes a manager key, keeping the full text after the known prefix; an unknown prefix gives null. */
export function decodeIgnoreManagerKey<K extends IgnoreKey>(value: string | number, parseKey: (text: string) => K): IgnoreManagerTarget<K> | null {
  const text = String(value);
  for (const kind of ["show", "seasons"] as const) {
    if (text.startsWith(`${kind}|`)) return { kind, key: parseKey(text.slice(kind.length + 1)) };
  }
  return null;
}

/** Trakt identities are numbers; this is the one place the decoded text becomes a number. */
export function decodeTraktManagerKey(value: string | number): IgnoreManagerTarget<number> | null {
  return decodeIgnoreManagerKey(value, Number);
}

/** Plex identities stay strings, even when they look like numbers. */
export function decodePlexManagerKey(value: string | number): IgnoreManagerTarget<string> | null {
  return decodeIgnoreManagerKey(value, (text) => text);
}
