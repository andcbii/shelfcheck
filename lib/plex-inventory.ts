export type PlexMetadata = { ratingKey?: string; key?: string; guid?: string; title?: string; year?: number; thumb?: string; updatedAt?: number; duration?: number; type?: string; parentIndex?: number; index?: number; Guid?: { id?: string }[] };
export type PlexShowGroup = { identity: string; plexGuid?: string; records: PlexMetadata[] };

export function idsFromGuids(guids: { id?: string }[] = []) {
  let tmdbId: number | undefined; let tvdbId: number | undefined; let imdbId: string | undefined;
  for (const guid of guids) {
    const match = guid.id?.match(/^(tmdb|tvdb):\/\/(\d+)/i);
    if (match?.[1].toLowerCase() === "tmdb") tmdbId = Number(match[2]);
    if (match?.[1].toLowerCase() === "tvdb") tvdbId = Number(match[2]);
    const imdb = guid.id?.match(/^imdb:\/\/(tt\d+)/i);
    if (imdb) imdbId = imdb[1].toLowerCase();
  }
  return { tmdbId, tvdbId, imdbId };
}

export function groupPlexShows(shows: PlexMetadata[]): PlexShowGroup[] {
  const groups = new Map<string, PlexShowGroup>();
  for (const show of shows) {
    const plexGuid = show.guid?.startsWith("plex://show/") ? show.guid : undefined;
    const identity = plexGuid || `ratingKey:${show.ratingKey || "unknown"}`;
    const group = groups.get(identity) || { identity, ...(plexGuid ? { plexGuid } : {}), records: [] };
    group.records.push(show); groups.set(identity, group);
  }
  return [...groups.values()];
}

export function plexFingerprint(group: PlexShowGroup): string | undefined {
  if (group.records.some((record) => !record.ratingKey || !Number.isFinite(record.updatedAt))) return undefined;
  return group.records.map((record) => `${record.ratingKey}:${record.updatedAt}`).sort().join("|");
}

export function hasPlexEpisodeCoordinate(episode: PlexMetadata): episode is PlexMetadata & { parentIndex: number; index: number } {
  return Number.isFinite(episode.parentIndex) && Number.isFinite(episode.index);
}
