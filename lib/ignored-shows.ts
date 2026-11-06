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
