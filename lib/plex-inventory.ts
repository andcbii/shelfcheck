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
  const parents = shows.map((_, index) => index);
  const root = (index: number): number => parents[index] === index ? index : (parents[index] = root(parents[index]));
  const join = (left: number, right: number) => { parents[root(right)] = root(left); };
  const aliases = new Map<string, number>();

  for (const [index, show] of shows.entries()) {
    const plexGuid = show.guid?.startsWith("plex://show/") ? show.guid : undefined;
    const { tmdbId, tvdbId } = idsFromGuids(show.Guid);
    // Requiring the complete pair avoids merging distinct TMDB series that TVDB
    // represents as one record (for example, the two Animaniacs series).
    const providerPair = tmdbId && tvdbId ? `tmdb:${tmdbId}|tvdb:${tvdbId}` : undefined;
    for (const alias of [plexGuid, providerPair]) {
      if (!alias) continue;
      const existing = aliases.get(alias);
      if (existing === undefined) aliases.set(alias, index);
      else join(existing, index);
    }
  }

  const recordsByRoot = new Map<number, PlexMetadata[]>();
  for (const [index, show] of shows.entries()) {
    const records = recordsByRoot.get(root(index)) || [];
    records.push(show);
    recordsByRoot.set(root(index), records);
  }

  return [...recordsByRoot.values()].map((records) => {
    const plexGuid = records.map((record) => record.guid).find((guid) => guid?.startsWith("plex://show/"));
    return { identity: plexGuid || `ratingKey:${records[0]?.ratingKey || "unknown"}`, ...(plexGuid ? { plexGuid } : {}), records };
  });
}

export function plexFingerprint(group: PlexShowGroup): string | undefined {
  if (group.records.some((record) => !record.ratingKey || !Number.isFinite(record.updatedAt))) return undefined;
  return group.records.map((record) => `${record.ratingKey}:${record.updatedAt}`).sort().join("|");
}

export function hasPlexEpisodeCoordinate(episode: PlexMetadata): episode is PlexMetadata & { parentIndex: number; index: number } {
  return Number.isFinite(episode.parentIndex) && Number.isFinite(episode.index);
}
