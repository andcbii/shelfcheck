import type { TraktShow } from "@/lib/trakt-model";
import { IGNORE_DURATIONS, type IgnoreDuration, type IgnoreTiming } from "@/lib/ignored-shows";

export type IgnoredPlexShow = { ratingKey: string; title: string } & IgnoreTiming;
export type IgnoredPlexSeasons = IgnoredPlexShow & { seasons: number[] };
export type IgnoredTraktShow = TraktShow & IgnoreTiming;
export type IgnoredTraktSeasons = { traktId: number; title: string; seasons: number[] } & IgnoreTiming;

function parseIgnoreTiming(show: Record<string, unknown>): IgnoreTiming | null {
  const duration = IGNORE_DURATIONS.some((item) => item.value === show.duration) ? show.duration as IgnoreDuration : undefined;
  if (show.expiresAt === undefined) return duration ? { duration: "forever" } : {};
  if (typeof show.expiresAt !== "string" || !Number.isFinite(Date.parse(show.expiresAt))) return null;
  return { expiresAt: show.expiresAt, ...(duration && duration !== "forever" ? { duration } : {}) };
}

export type PlexPreferences = {
  ignoredShows: IgnoredPlexShow[];
  ignoredSeasons: IgnoredPlexSeasons[];
  hideUnairedEpisodes: boolean;
  airingOffsetDays: number;
  autoCompoundEpisodes: boolean;
  diagnosticsEnabled: boolean;
};

export type PlexPreferencesPatch = Partial<PlexPreferences>;

export function parsePlexPreferences(value: unknown): PlexPreferences {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const ignoredShows = Array.isArray(source.ignoredShows) ? source.ignoredShows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const show = item as Record<string, unknown>;
    const timing = parseIgnoreTiming(show);
    return timing && typeof show.ratingKey === "string" && typeof show.title === "string" ? [{ ratingKey: show.ratingKey, title: show.title, ...timing }] : [];
  }) : [];
  const ignoredSeasons = Array.isArray(source.ignoredSeasons) ? source.ignoredSeasons.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const show = item as Record<string, unknown>;
    const timing = parseIgnoreTiming(show);
    if (!timing) return [];
    if (typeof show.ratingKey !== "string" || typeof show.title !== "string" || !Array.isArray(show.seasons)) return [];
    const seasons = [...new Set(show.seasons.filter((season): season is number => typeof season === "number" && Number.isFinite(season) && season >= 0).map(Math.trunc))].sort((a, b) => a - b);
    return seasons.length ? [{ ratingKey: show.ratingKey, title: show.title, seasons, ...timing }] : [];
  }) : [];
  const rawOffset = typeof source.airingOffsetDays === "number" && Number.isFinite(source.airingOffsetDays) ? source.airingOffsetDays : 0;
  return {
    ignoredShows,
    ignoredSeasons,
    hideUnairedEpisodes: source.hideUnairedEpisodes === true,
    airingOffsetDays: Math.max(0, Math.min(30, Math.trunc(rawOffset))),
    autoCompoundEpisodes: source.autoCompoundEpisodes !== false,
    diagnosticsEnabled: source.diagnosticsEnabled !== false,
  };
}

export function parsePlexPreferencesPatch(value: unknown): PlexPreferencesPatch {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const parsed = parsePlexPreferences(source);
  const patch: PlexPreferencesPatch = {};
  for (const key of ["ignoredShows", "ignoredSeasons", "hideUnairedEpisodes", "airingOffsetDays", "autoCompoundEpisodes", "diagnosticsEnabled"] as const) {
    if (Object.prototype.hasOwnProperty.call(source, key)) patch[key] = parsed[key] as never;
  }
  return patch;
}

export type TraktPreferencesPatch = { ignoredShows?: IgnoredTraktShow[]; ignoredSeasons?: IgnoredTraktSeasons[]; diagnosticsEnabled?: boolean; airingGraceDays?: number };

export function parseTraktPreferencesPatch(value: unknown): TraktPreferencesPatch {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const patch: TraktPreferencesPatch = {};
  if (Array.isArray(source.ignoredShows)) patch.ignoredShows = source.ignoredShows.flatMap((item) => {
    if (!item || typeof item !== "object" || typeof (item as TraktShow).ids?.trakt !== "number" || typeof (item as TraktShow).title !== "string") return [];
    const timing = parseIgnoreTiming(item as Record<string, unknown>);
    if (!timing) return [];
    const show = { ...item } as IgnoredTraktShow;
    delete show.expiresAt;
    delete show.duration;
    return [{ ...show, ...timing }];
  });
  if (Array.isArray(source.ignoredSeasons)) patch.ignoredSeasons = source.ignoredSeasons.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const show = item as Record<string, unknown>;
    const timing = parseIgnoreTiming(show);
    if (!timing) return [];
    if (typeof show.traktId !== "number" || !Number.isFinite(show.traktId) || typeof show.title !== "string" || !Array.isArray(show.seasons)) return [];
    const seasons = [...new Set(show.seasons.filter((season): season is number => typeof season === "number" && Number.isFinite(season) && season >= 0).map(Math.trunc))].sort((a, b) => a - b);
    return seasons.length ? [{ traktId: show.traktId, title: show.title, seasons, ...timing }] : [];
  });
  if (typeof source.diagnosticsEnabled === "boolean") patch.diagnosticsEnabled = source.diagnosticsEnabled;
  if (typeof source.airingGraceDays === "number" && Number.isFinite(source.airingGraceDays)) patch.airingGraceDays = Math.max(0, Math.min(30, Math.trunc(source.airingGraceDays)));
  return patch;
}
