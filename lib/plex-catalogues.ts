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
  /** A verified provider change to an alias whose relationships this comparison has not yet rebuilt. */
  staleRelationships?: {tmdb?: true; tvdb?: true};
};
/** The point through which each provider's change feed has been checked, with identified changes handled or retained. */
export type ProviderVerificationPositions = {tmdb?: string; tvdb?: string};
export type DailyFullScanCount = {utcDate: string; count: number};
type CompletedFullScanRow = {startedAt?: string; completedFullScans?: DailyFullScanCount};
export type PlexGeneratedInputs = {
  version: 1;
  tmdb: Record<string, ProviderCatalogue<TmdbCatalogueShow>>;
  tvdb: Record<string, ProviderCatalogue<{id:number; name?:string; slug?:string}>>;
  comparisons: Record<string, SavedPlexComparison>;
  inventory?: { capturedAt:string; complete:boolean; groups:PlexShowGroup[]; items:Record<string,PlexMetadata[]>; evidence:CoverageEvidence[] };
  /** Start of the latest Completed full scan (complete inventory, library processing finished). */
  completedFullScanAt?: string;
  verification: ProviderVerificationPositions;
  /** Completed full scans counted on their planned UTC start date, for the fifth-scan safeguard. */
  completedFullScans?: DailyFullScanCount;
  /** Verified TMDB changes not yet satisfied by a catalogue download, including same-day reuse deferrals. */
  deferredTmdbChanges: Record<string, true>;
  /** Verified TVDB changes not yet satisfied by a catalogue download. */
  pendingTvdbChanges: Record<string, true>;
  /**
   * Fifth-scan safeguards whose required TMDB change list could not be retrieved, keyed by
   * the planned UTC start date whose changes must bypass same-day reuse.
   */
  pendingSafeguards: Record<string, true>;
};
const validTime = (value?: string) => Number.isFinite(Date.parse(value || "")) ? value : undefined;
export function readPlexInputs(): PlexGeneratedInputs {
  // Before provider isolation, one clean-scan baseline served as scan activity and both providers' change baseline.
  const legacy = readPlexGeneratedInputs<{startedAt?: string; successfulFullScans?: DailyFullScanCount}>("full-scan");
  const completed = readPlexGeneratedInputs<CompletedFullScanRow>("completed-full-scan");
  const legacyBaseline = validTime(legacy?.startedAt);
  const verification = readPlexGeneratedInputs<ProviderVerificationPositions>("provider-verification") || {tmdb: legacyBaseline, tvdb: legacyBaseline};
  return {
    version: 1,
    deferredTmdbChanges: readPlexGeneratedInputs<Record<string, true>>("deferred-tmdb") || {},
    pendingTvdbChanges: readPlexGeneratedInputs<Record<string, true>>("pending-tvdb") || {},
    pendingSafeguards: readPlexGeneratedInputs<Record<string, true>>("pending-safeguards") || {},
    tmdb: listPlexGeneratedInputs("tmdb:"),
    tvdb: listPlexGeneratedInputs("tvdb:"),
    comparisons: listPlexGeneratedInputs("comparison:"),
    inventory: readPlexGeneratedInputs<PlexGeneratedInputs["inventory"]>("inventory") || undefined,
    completedFullScanAt: validTime(completed?.startedAt) || legacyBaseline,
    verification: {
      ...(validTime(verification.tmdb) ? {tmdb: verification.tmdb} : {}),
      ...(validTime(verification.tvdb) ? {tvdb: verification.tvdb} : {}),
    },
    // Before completed-scan counting, only clean full scans were counted.
    completedFullScans: completed?.completedFullScans || legacy?.successfulFullScans,
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
export function savePendingTvdbChanges(changes: Record<string, true>) {
  writePlexGeneratedInputs("pending-tvdb", changes);
}
export function savePendingSafeguards(safeguards: Record<string, true>) {
  writePlexGeneratedInputs("pending-safeguards", safeguards);
}
export function saveProviderVerification(positions: ProviderVerificationPositions) {
  writePlexGeneratedInputs("provider-verification", positions);
}
/** One durable row commits completed-full-scan activity and its daily count at the same boundary. */
export function saveCompletedFullScan(startedAt: string, completedFullScans: DailyFullScanCount) {
  writePlexGeneratedInputs("completed-full-scan", {startedAt, completedFullScans} satisfies CompletedFullScanRow);
}
/** Snapshot writer for local rechecks. Full scans write only their changed rows. */
export function savePlexInputs(inputs: PlexGeneratedInputs) {
  for (const [id,catalogue] of Object.entries(inputs.tmdb)) savePlexCatalogue("tmdb", Number(id), catalogue);
  for (const [id,catalogue] of Object.entries(inputs.tvdb)) savePlexCatalogue("tvdb", Number(id), catalogue);
  for (const [key,input] of Object.entries(inputs.comparisons)) savePlexComparison(key, input);
  if (inputs.inventory) savePlexInventory(inputs.inventory);
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
