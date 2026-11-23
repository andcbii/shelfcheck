/**
 * The Coverage Issue ID vocabulary: one named constructor or constant per kind of Coverage Issue,
 * each producing exactly the text saved by earlier versions (stored IDs and cause links depend on it).
 * Dependency-light by design (no SQLite, no server-only), so client code can share the types.
 * Historical migrations keep their own literal IDs and never import these constructors.
 */
import { catalogueRecordKey, type MalformedCatalogueRecord } from "@/lib/catalogue-records";
import { PROVIDER_NAME, type CatalogueProvider } from "@/lib/catalogue-selection";
import type { EpisodeCheckFailure } from "@/lib/plex-comparison";
import { lookupKey, type ProviderLookup } from "@/lib/provider-lookup";

declare const coverageIssueIdBrand: unique symbol;
/** A Coverage Issue's stored ID or a cause link to one; only this module's constructors make one. */
export type CoverageIssueId = string & { readonly [coverageIssueIdBrand]: true };

declare const coverageIssuePrefixBrand: unique symbol;
/**
 * The leading text shared by one family of Coverage Issue IDs (for example one show's episode checks),
 * with its trailing delimiter. It selects stored IDs; it is not an ID, so it can never be a cause link.
 */
export type CoverageIssuePrefix = string & { readonly [coverageIssuePrefixBrand]: true };

/** The only place a string becomes a Coverage Issue ID. Private: there is no public string-to-ID function. */
const issueId = (text: string) => text as CoverageIssueId;
/** The only place a string becomes a Coverage Issue prefix. Private, like `issueId`. */
const issuePrefix = (text: string) => text as CoverageIssuePrefix;

/** The interrupted or failed scan of the library. */
export const SCAN_FAILURE_ISSUE = issueId("scan-failure");
/** A failed TVDB sign-in: the root of every TVDB request it stopped. */
export const TVDB_AUTHENTICATION_ISSUE = issueId("provider-authentication:TVDB");
/** A failed Trakt sign-in. */
export const TRAKT_AUTHENTICATION_ISSUE = issueId("provider-authentication:Trakt");
/** Library-wide comparison inputs missing before any show's inputs were saved. */
export const INITIAL_COMPARISON_INPUTS_ISSUE = issueId("comparison-inputs:initial");

/** A provider's catalogue freshness (its change feed) could not be verified. */
export function providerVerificationIssueId(provider: "TMDB" | "TVDB") {
  return issueId(`provider-verification:${provider}`);
}

/** One Plex record's episode inventory in a show group, keyed by the group's identity and the record's rating key. */
export function plexInventoryIssueId(showIdentity: string, recordRatingKey: string) {
  return issueId(`inventory:${showIdentity}:${recordRatingKey}`);
}
/** A show's Plex metadata (its inventory details) could not be read. */
export function inventoryDetailsIssueId(ratingKey: string) {
  return issueId(`inventory-details:${ratingKey}`);
}
/** A show's saved comparison inputs are missing or incomplete; for the library-wide form see `INITIAL_COMPARISON_INPUTS_ISSUE`. */
export function comparisonInputsIssueId(ratingKey: string) {
  return issueId(`comparison-inputs:${ratingKey}`);
}
/** A show's comparison failed to run. */
export function comparisonFailureIssueId(ratingKey: string) {
  return issueId(`comparison-failure:${ratingKey}`);
}
/** One Manual Match member episode could not be verified at its provider. */
export function memberVerificationIssueId(mappingId: string, member: { provider: "TMDB" | "TVDB"; id: number }) {
  return issueId(`member-verification:${mappingId}:${member.provider}:${member.id}`);
}

/** A show's catalogue-refresh and catalogue-fallback-refresh Coverage Issue IDs for one provider. */
export function catalogueIssueIds(provider: CatalogueProvider, ratingKey: string) {
  const name = PROVIDER_NAME[provider];
  return { refreshId: issueId(`catalogue-refresh:${name}:${ratingKey}`), fallbackId: issueId(`catalogue-fallback-refresh:${name}:${ratingKey}`) };
}

/** The `episode-identity:` Coverage Issue ID of one show's failed request for a typed lookup; wraps its stored lookup key unchanged. */
export function lookupFailureIssueId(ratingKey: string, lookup: ProviderLookup) {
  return issueId(`episode-identity:${ratingKey}:${lookupKey(lookup)}`);
}

type EpisodeCheck = Pick<EpisodeCheckFailure, "operation" | "method" | "crosswalk">;

/** Every episode-check and catalogue-record Coverage Issue of one show starts with this prefix. */
export function episodeCheckShowPrefix(ratingKey: string) {
  return issuePrefix(`episode-check:${ratingKey}:`);
}
/** One check of one show: its operation, decision method and crosswalk, followed by the provider episode. */
export function episodeCheckPrefix(ratingKey: string, check: EpisodeCheck) {
  return issuePrefix(`${episodeCheckShowPrefix(ratingKey)}${check.operation}${check.method ? `:${check.method}` : ""}${check.crosswalk ? `:${check.crosswalk}` : ""}:`);
}
/** One check of one show for TVDB episodes only. */
export function episodeCheckTvdbEpisodePrefix(ratingKey: string, check: EpisodeCheck) {
  return issuePrefix(`${episodeCheckPrefix(ratingKey, check)}TVDB:`);
}
/** Stable per show, check and provider episode, so a repeated failure updates the same current cause. */
export function episodeCheckIssueId(ratingKey: string, failure: Pick<EpisodeCheckFailure, "operation" | "method" | "crosswalk" | "episode">) {
  const { provider = "Provider", id, season, episode } = failure.episode;
  return issueId(`${episodeCheckPrefix(ratingKey, failure)}${provider}:${id ?? `${season}x${episode}`}`);
}
/** The current cause of a failed English title request for one TVDB episode. */
export function titleRecoveryIssueId(ratingKey: string, tvdbEpisodeId: number) {
  return episodeCheckIssueId(ratingKey, { operation: "title-recovery", episode: { provider: "TVDB", id: tvdbEpisodeId } });
}
/** Stable per show and provider record: its identity, else its numbering, else its response position. */
export function catalogueRecordIssueId(ratingKey: string, record: MalformedCatalogueRecord) {
  return issueId(`${episodeCheckShowPrefix(ratingKey)}catalogue-record:${catalogueRecordKey(record)}`);
}
