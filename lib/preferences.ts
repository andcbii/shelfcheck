import type { TraktShow } from "@/lib/trakt-model";

export type PlexPreferences = {
  ignoredShows: { ratingKey: string; title: string }[];
  ignoredSeasons: { ratingKey: string; title: string; seasons: number[] }[];
  hideUnairedEpisodes: boolean;
  airingOffsetDays: number;
  autoCompoundEpisodes: boolean;
  diagnosticsEnabled: boolean;
};

export function parsePlexPreferences(value: unknown): PlexPreferences {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const ignoredShows = Array.isArray(source.ignoredShows) ? source.ignoredShows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const show = item as Record<string, unknown>;
    return typeof show.ratingKey === "string" && typeof show.title === "string" ? [{ ratingKey: show.ratingKey, title: show.title }] : [];
  }) : [];
  const ignoredSeasons = Array.isArray(source.ignoredSeasons) ? source.ignoredSeasons.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const show = item as Record<string, unknown>;
    if (typeof show.ratingKey !== "string" || typeof show.title !== "string" || !Array.isArray(show.seasons)) return [];
    const seasons = [...new Set(show.seasons.filter((season): season is number => typeof season === "number" && Number.isFinite(season) && season >= 0).map(Math.trunc))].sort((a, b) => a - b);
    return seasons.length ? [{ ratingKey: show.ratingKey, title: show.title, seasons }] : [];
  }) : [];
  const rawOffset = typeof source.airingOffsetDays === "number" ? source.airingOffsetDays : 0;
  return {
    ignoredShows,
    ignoredSeasons,
    hideUnairedEpisodes: source.hideUnairedEpisodes === true,
    airingOffsetDays: Math.max(0, Math.min(30, Math.trunc(rawOffset))),
    autoCompoundEpisodes: source.autoCompoundEpisodes !== false,
    diagnosticsEnabled: source.diagnosticsEnabled !== false,
  };
}

export type TraktPreferencesPatch = { ignoredShows?: TraktShow[]; ignoredSeasons?: { traktId: number; title: string; seasons: number[] }[]; diagnosticsEnabled?: boolean; airingGraceDays?: number };

export function parseTraktPreferencesPatch(value: unknown): TraktPreferencesPatch {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const patch: TraktPreferencesPatch = {};
  if (Array.isArray(source.ignoredShows)) patch.ignoredShows = source.ignoredShows.filter((show): show is TraktShow => Boolean(show && typeof show === "object" && typeof (show as TraktShow).ids?.trakt === "number" && typeof (show as TraktShow).title === "string"));
  if (Array.isArray(source.ignoredSeasons)) patch.ignoredSeasons = source.ignoredSeasons.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const show = item as Record<string, unknown>;
    if (typeof show.traktId !== "number" || !Number.isFinite(show.traktId) || typeof show.title !== "string" || !Array.isArray(show.seasons)) return [];
    const seasons = [...new Set(show.seasons.filter((season): season is number => typeof season === "number" && Number.isFinite(season) && season >= 0).map(Math.trunc))].sort((a, b) => a - b);
    return seasons.length ? [{ traktId: show.traktId, title: show.title, seasons }] : [];
  });
  if (typeof source.diagnosticsEnabled === "boolean") patch.diagnosticsEnabled = source.diagnosticsEnabled;
  if (typeof source.airingGraceDays === "number" && Number.isFinite(source.airingGraceDays)) patch.airingGraceDays = Math.max(0, Math.min(30, Math.trunc(source.airingGraceDays)));
  return patch;
}
