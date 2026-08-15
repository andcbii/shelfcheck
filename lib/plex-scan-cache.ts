export const PLEX_CACHE_VERSION = 11;

export type PlexScanCacheEntry = {
  plexFingerprint?: string;
  plexEpisodeFingerprint?: string;
  tmdbId?: number;
  tvdbId?: number;
  tvdbEpisodeImdbIds?: Record<string, string[]>;
  localTmdbEpisodeIds?: number[];
  localTvdbEpisodeIds?: number[];
  localImdbEpisodeIds?: string[];
  lastCheckedAt: string;
};

export function pruneEpisodeIdentityCache(cache: Record<string, string[]>, currentEpisodeIds: Iterable<number>) {
  const current = new Set([...currentEpisodeIds].map(String));
  return Object.fromEntries(Object.entries(cache).filter(([episodeId]) => current.has(episodeId)));
}

export function checkpointIsUsable(checkpoint: { cacheVersion?: number; autoCompoundEpisodes?: boolean; savedAt?: string } | null, autoCompoundEpisodes: boolean, now = Date.now()) {
  if (!checkpoint?.savedAt || checkpoint.cacheVersion !== PLEX_CACHE_VERSION || checkpoint.autoCompoundEpisodes !== autoCompoundEpisodes) return false;
  const savedAt = Date.parse(checkpoint.savedAt);
  return Number.isFinite(savedAt) && now - savedAt < 6 * 3600_000;
}

export function mergeScanProgress<T extends object>(current: T, progress: Partial<T>): T {
  return { ...current, ...progress };
}

export function checkpointShowsWithCache<T extends { ratingKey: string }>(shows: T[], cache: Record<string, unknown>): T[] {
  return shows.filter((show) => Boolean(cache[show.ratingKey]));
}

export function plexReportCacheIsUsable(report: { cacheVersion?: number; autoCompoundEpisodes?: boolean; scanCache?: Record<string, unknown> } | null | undefined, cacheVersion: number, autoCompoundEpisodes: boolean) {
  return report?.cacheVersion === cacheVersion && report.autoCompoundEpisodes === autoCompoundEpisodes && Boolean(report.scanCache);
}

export function targetedScanCarryOver<TShow extends { ratingKey: string }, TCache>(inputs: {
  cacheUsable: boolean;
  shows: TShow[];
  cache: Record<string, TCache>;
  currentIdentities: Set<string>;
  targetRatingKey: string;
}) {
  if (!inputs.cacheUsable) throw new Error("Run a full Plex search before force-checking one show because the scan settings or cache format changed.");
  return {
    shows: inputs.shows.filter((show) => show.ratingKey !== inputs.targetRatingKey && inputs.currentIdentities.has(show.ratingKey)),
    cache: Object.fromEntries(Object.entries(inputs.cache).filter(([key]) => key !== inputs.targetRatingKey && inputs.currentIdentities.has(key))) as Record<string, TCache>,
  };
}

export function checkpointWithoutRatingKey<TShow extends { ratingKey: string }, TCache, TCheckpoint extends { shows: TShow[]; scanCache: Record<string, TCache> }>(checkpoint: TCheckpoint, ratingKey: string): TCheckpoint | null {
  const scanCache = { ...checkpoint.scanCache };
  delete scanCache[ratingKey];
  if (!Object.keys(scanCache).length) return null;
  return { ...checkpoint, scanCache, shows: checkpoint.shows.filter((show) => show.ratingKey !== ratingKey) };
}
