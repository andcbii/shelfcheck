export const PLEX_CACHE_VERSION = 10;

export type PlexScanCacheEntry = {
  plexFingerprint?: string;
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
