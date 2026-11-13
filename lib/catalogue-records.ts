import type { ProviderEpisode } from "@/lib/plex-comparison";

/**
 * One provider catalogue record that could not be used in full. Only fields the
 * provider actually supplied are kept; nothing is invented. A record with
 * usable numbering but no identity is still compared by numbering; a record
 * without usable numbering is left out of the comparison.
 */
export type MalformedCatalogueRecord = {
  provider: "TMDB" | "TVDB";
  showId: number;
  /** Where the record sat in the provider response, for records with neither identity nor numbering. */
  position: string;
  id?: number;
  season?: number;
  episode?: number;
  title?: string;
  problem: "not-a-record" | "no-identity" | "no-numbering" | "no-identity-or-numbering";
};
export type NormalisedCatalogue = { episodes: ProviderEpisode[]; malformed: MalformedCatalogueRecord[] };

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identity = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const runtime = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

type Fields = { id: unknown; season: unknown; episode: unknown; title: unknown; titleLanguage?: unknown; airDate: unknown; runtime: unknown };

function normaliseRecord(provider: "TMDB" | "TVDB", showId: number, showTitle: string | undefined, position: string, raw: unknown, fields: (item: Record<string, unknown>) => Fields | null, into: NormalisedCatalogue) {
  if (!record(raw)) { into.malformed.push({ provider, showId, position, problem: "not-a-record" }); return; }
  const read = fields(raw);
  if (!read) return;
  const id = identity(read.id), season = number(read.season), episode = number(read.episode), title = text(read.title);
  const numbered = season !== undefined && episode !== undefined;
  if (numbered) into.episodes.push({ ...(showTitle !== undefined ? { showTitle } : {}), season, episode, ...(title !== undefined ? { title, ...(read.titleLanguage === "eng" ? { titleLanguage: "eng" as const } : {}) } : {}), ...(text(read.airDate) ? { airDate: read.airDate as string } : {}), ...(runtime(read.runtime) ? { runtime: read.runtime as number } : {}), ...(id !== undefined ? { providerEpisodeId: id } : {}), source: provider });
  if (numbered && id !== undefined) return;
  into.malformed.push({ provider, showId, position, ...(id !== undefined ? { id } : {}), ...(numbered ? { season, episode } : {}), ...(title !== undefined ? { title } : {}), problem: numbered ? "no-identity" : id !== undefined ? "no-numbering" : "no-identity-or-numbering" });
}

/** TMDB season response records. Every TMDB record is a comparable episode. */
export function normaliseTmdbRecords(show: { id: number; name?: string }, season: number, records: unknown[], into: NormalisedCatalogue = { episodes: [], malformed: [] }) {
  records.forEach((raw, index) => normaliseRecord("TMDB", show.id, show.name, `season ${season} record ${index + 1}`, raw, item => ({ id: item.id, season: item.season_number, episode: item.episode_number, title: item.name, airDate: item.air_date, runtime: item.runtime }), into));
  return into;
}

/**
 * TVDB default series episode records. An absent season is season 0 and records
 * outside comparable numbering (negative seasons, episode 0) are left out without
 * a problem, as before.
 */
export function normaliseTvdbRecords(seriesId: number, showTitle: string | undefined, page: number, records: unknown[], into: NormalisedCatalogue = { episodes: [], malformed: [] }) {
  records.forEach((raw, index) => normaliseRecord("TVDB", seriesId, showTitle, `page ${page + 1} record ${index + 1}`, raw, item => {
    const season = item.seasonNumber ?? 0;
    if ((typeof season === "number" && season < 0) || item.number === 0) return null;
    return { id: item.id, season, episode: item.number, title: item.name, airDate: item.aired, runtime: item.runtime };
  }, into));
  return into;
}

/** Saved catalogue episodes are untrusted too: older saved catalogues were stored without record validation. */
export function normaliseSavedEpisodes(provider: "TMDB" | "TVDB", showId: number, episodes: unknown[], malformed: unknown = []): NormalisedCatalogue {
  const into: NormalisedCatalogue = { episodes: [], malformed: Array.isArray(malformed) ? malformed.filter((item): item is MalformedCatalogueRecord => record(item) && item.provider === provider && typeof item.position === "string") : [] };
  episodes.forEach((raw, index) => normaliseRecord(provider, showId, record(raw) ? text(raw.showTitle) : undefined, `saved record ${index + 1}`, raw, item => ({ id: item.providerEpisodeId, season: item.season, episode: item.episode, title: item.title, titleLanguage: item.titleLanguage, airDate: item.airDate, runtime: item.runtime }), into));
  // A saved record without identity is kept for numbering and was already reported when downloaded.
  const seen = new Set<string>();
  into.malformed = into.malformed.filter(item => !seen.has(catalogueRecordKey(item)) && Boolean(seen.add(catalogueRecordKey(item))));
  return into;
}

/** The record's own identity, else its provider numbering, else its response position. */
export function catalogueRecordKey(item: MalformedCatalogueRecord) {
  return `${item.provider}:${item.showId}:${item.id ?? (item.season !== undefined && item.episode !== undefined ? `S${item.season}E${item.episode}` : item.position)}`;
}
