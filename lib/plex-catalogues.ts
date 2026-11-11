import "server-only";
import type { ProviderEpisode } from "@/lib/plex-comparison";
import type { CoverageEvidence } from "@/lib/manual-coverage-model";
import type { PlexMetadata, PlexShowGroup } from "@/lib/plex-inventory";
import { readPlexGeneratedInputs, listPlexGeneratedInputs, writePlexGeneratedInputs, deletePlexGeneratedInputs } from "@/lib/sqlite";

export type TmdbCatalogueShow = { id: number; name?: string; first_air_date?: string | null; seasons?: {season_number:number}[]; external_ids?: {tvdb_id?:number|null} };
export type ProviderCatalogue<T> = { version: 1; downloadedAt: string; show: T; episodes: ProviderEpisode[] };
/** Only complete downloaded inputs can be reused or used as last-good fallback. */
export function usableProviderCatalogue<T extends {id:number}>(catalogue: ProviderCatalogue<T> | undefined): catalogue is ProviderCatalogue<T> {
  return catalogue?.version === 1 && Number.isFinite(catalogue.show?.id) && Array.isArray(catalogue.episodes) && Number.isFinite(Date.parse(catalogue.downloadedAt));
}
export type SavedPlexComparison = {
  group: PlexShowGroup; details: PlexMetadata[]; localMetadata: PlexMetadata[];
  tmdbId?: number; tvdbId?: number;
  // Raw successful HTTP identity relationships, including successful empty responses.
  // Ownership must always be derived against current inventory, never reused from a result.
  relationships: Record<string, {provider: string; value: unknown}>;
  tmdbAliases: number[]; tvdbAliases: number[];
  tmdbEpisodeAliases?: number[];
  tvdbEpisodeImdbIds?: Record<string, string[]>;
  complete: boolean;
  refresh?: {tmdb?: boolean; tvdb?: boolean};
};
export type PlexGeneratedInputs = {
  version: 1;
  tmdb: Record<string, ProviderCatalogue<TmdbCatalogueShow>>;
  tvdb: Record<string, ProviderCatalogue<{id:number; name?:string; slug?:string}>>;
  comparisons: Record<string, SavedPlexComparison>;
  inventory?: { capturedAt:string; complete:boolean; groups:PlexShowGroup[]; items:Record<string,PlexMetadata[]>; evidence:CoverageEvidence[] };
  fullScanStartedAt?: string;
  deferredTmdbChanges: Record<string, true>;
};
export function readPlexInputs(): PlexGeneratedInputs {
  return {
    version: 1,
    deferredTmdbChanges: readPlexGeneratedInputs<Record<string, true>>("deferred-tmdb") || {},
    tmdb: listPlexGeneratedInputs("tmdb:"),
    tvdb: listPlexGeneratedInputs("tvdb:"),
    comparisons: listPlexGeneratedInputs("comparison:"),
    inventory: readPlexGeneratedInputs<PlexGeneratedInputs["inventory"]>("inventory") || undefined,
    fullScanStartedAt: readPlexGeneratedInputs<{startedAt:string}>("full-scan")?.startedAt,
  };
}
export function savePlexCatalogue<P extends "tmdb" | "tvdb">(provider: P, id: number, catalogue: PlexGeneratedInputs[P][string]) {
  writePlexGeneratedInputs(`${provider}:${id}`, catalogue);
}
export function savePlexComparison(ratingKey: string, input: SavedPlexComparison) {
  writePlexGeneratedInputs(`comparison:${ratingKey}`, input);
}
export function savePlexInventory(inventory: NonNullable<PlexGeneratedInputs["inventory"]>) {
  writePlexGeneratedInputs("inventory", inventory);
}
export function saveDeferredTmdbChanges(changes: Record<string, true>) {
  writePlexGeneratedInputs("deferred-tmdb", changes);
}
export function savePlexScanBaseline(startedAt: string) {
  writePlexGeneratedInputs("full-scan", {startedAt});
}
/** Snapshot writer for local rechecks. Full scans write only their changed rows. */
export function savePlexInputs(inputs: PlexGeneratedInputs) {
  for (const [id,catalogue] of Object.entries(inputs.tmdb)) savePlexCatalogue("tmdb", Number(id), catalogue);
  for (const [id,catalogue] of Object.entries(inputs.tvdb)) savePlexCatalogue("tvdb", Number(id), catalogue);
  for (const [key,input] of Object.entries(inputs.comparisons)) savePlexComparison(key, input);
  if (inputs.inventory) savePlexInventory(inputs.inventory);
  if (inputs.fullScanStartedAt) savePlexScanBaseline(inputs.fullScanStartedAt);
}
export function clearPlexInputs(ratingKey?: string) {
  if (!ratingKey) { deletePlexGeneratedInputs(); return; }
  const previous = readPlexGeneratedInputs<SavedPlexComparison>(`comparison:${ratingKey}`);
  if (previous) {
    previous.refresh = {tmdb:true, tvdb:true};
    previous.complete = false;
    previous.relationships = {};
    savePlexComparison(ratingKey, previous);
  }
}
