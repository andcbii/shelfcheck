export type ScanCacheInputs = {
  deep: boolean;
  gracePeriodChanged: boolean;
  cached: boolean;
  collectionChanged: boolean;
  airedChanged: boolean;
  traktUpdated: boolean;
};

export type ScanReason = "new" | "collection-changed" | "aired-changed" | "trakt-updated" | "settings-changed";

type CollectedShow = {
  show: { aired_episodes?: number };
  seasons?: { number: number; episodes?: { number: number; collected_at?: string }[] }[];
};

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

export function collectionFingerprint(item: CollectedShow): string {
  const episodes = (item.seasons || []).flatMap((season) => (season.episodes || [])
    .map((episode) => `${season.number}:${episode.number}:${episode.collected_at || ""}`)).sort().join("|");
  return hash(episodes);
}

export function collectedEpisodeCount(item: CollectedShow): number {
  return (item.seasons || []).reduce((total, season) => total + (season.number ? season.episodes?.length || 0 : 0), 0);
}

export function scanReason(inputs: ScanCacheInputs): ScanReason | null {
  if (inputs.gracePeriodChanged) return "settings-changed";
  if (!inputs.cached) return "new";
  if (inputs.collectionChanged) return "collection-changed";
  if (inputs.airedChanged) return "aired-changed";
  if (inputs.deep && inputs.traktUpdated) return "trakt-updated";
  return null;
}

export function shouldReportIncompleteEpisode(deep: boolean, graceDays: number, airedAfterGrace: boolean, airDateKnown = true): boolean {
  return !airDateKnown || (!deep && graceDays === 0) || airedAfterGrace;
}

export function canCacheAirDateResult(requiresAirDates: boolean, requestSucceeded: boolean, unknownAirDates: number): boolean {
  return !requiresAirDates || (requestSucceeded && unknownAirDates === 0);
}

export function shouldSaveCheckpoint(processed: number, lastProcessed: number, now: number, lastSavedAt: number): boolean {
  return processed - lastProcessed >= 10 || now - lastSavedAt >= 5_000;
}
