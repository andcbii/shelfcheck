import "server-only";
import { resolveCoverageUrls, reviewedCoverageMembers } from "@/lib/manual-coverage-resolver";
import { requestCoverageRecheck, type CoverageImpact } from "@/lib/plex-scan";
import { assertCoverageMutationAllowed, clearReportMissingFlags, coverageState, deleteCoverageMapping, deleteCoverageMappings, listCoverageMappings, saveCoverageMapping, type ManualMatchEdit } from "@/lib/manual-coverage";
import type { CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
import { readPlexInputs, type SavedPlexComparison } from "@/lib/plex-catalogues";
import { recordProviderYears, type ProviderYearObservation } from "@/lib/show-year";

/**
 * Manual Match changes: each command runs the whole sequence (refusal while a
 * Plex scan run is active, provider revalidation for a reviewed save, the
 * store's transactional write, which also carries the affected members, then
 * one cached recheck of those members and every other carried member).
 * Routes only parse requests and map results and errors. Preview resolution is
 * a read and stays outside this module. Clearing Report Missing flags for an
 * Ignore takes the newly applied scopes as plain input: which Ignore rules are
 * newly active is the caller's concern.
 */

/**
 * A save as the Manual Match page sends it: a reviewed save of a resolved
 * `preview` (new, or an `edit` of an existing Manual Match), or, with no
 * preview, a Report Missing flag edit of the existing Manual Match `edit`.
 * The preview token is checked by the resolver, and the revision and flags by
 * the store, which stay the authority for their errors.
 */
export type ManualMatchSave = { edit?: ManualMatchEdit; preview?: unknown; reportMissing?: unknown };

/** A saved Manual Match with its Report Missing flags; `created` is true for a new one, false for an edit. */
export type SavedManualMatch = { manualMatch: CoverageMapping; created: boolean };

/** Save a Manual Match. */
export async function saveManualMatch({ edit, preview, reportMissing }: ManualMatchSave): Promise<SavedManualMatch> {
  if (preview === undefined && edit && reportMissing !== undefined) {
    // Changing only Report Missing keeps the saved members, so it needs no provider review.
    const { mapping, affectedMembers } = saveCoverageMapping(undefined, edit, reportMissing);
    await recheckAfterCommit({ members: affectedMembers });
    return { manualMatch: mapping, created: false };
  }
  // Fail fast before contacting providers; the store's check inside its transaction stays authoritative.
  assertCoverageMutationAllowed();
  const reviewed = reviewedCoverageMembers(preview);
  // Revalidate the exact reviewed canonical identities. Coordinates can locate a
  // different TMDB record since preview, but must never replace that identity.
  const { showYears } = await resolveCoverageUrls(reviewed.map(member => member.provider === "TVDB" ? `tvdb:${member.id}` : `tmdb:${member.id} show:${member.showId} season:${member.season} episode:${member.episode}`));
  const { mapping, affectedMembers } = saveCoverageMapping(reviewed, edit, reportMissing);
  saveProviderYears(showYears);
  await recheckAfterCommit({ members: affectedMembers });
  return { manualMatch: mapping, created: !edit };
}

/**
 * Save the provider years the save's own show lookups gave, after the Manual Match commits. A
 * display value only: it moves no coverage revision, and a failure never fails the saved match.
 */
function saveProviderYears(showYears: ProviderYearObservation[]): void {
  try {
    recordProviderYears(showYears);
  } catch (error) {
    console.error("Shelfcheck saved the Manual Match but could not save its provider show years.", error);
  }
}

/**
 * Delete one Manual Match (`id`: a missing one is "not found") or each listed
 * one once (`ids`: missing ones are listed). A delete that removed nothing
 * starts no cached recheck.
 */
export async function deleteManualMatches(target: { id: string } | { ids: unknown }): Promise<{ deleted: string[]; missing: string[] }> {
  const { deleted, missing, affectedMembers } = "id" in target ? deleteCoverageMapping(target.id) : deleteCoverageMappings(target.ids);
  if (deleted.length) await recheckAfterCommit({ members: affectedMembers });
  return { deleted, missing };
}

/** A newly applied Plex Ignore: a whole show, or only the selected seasons of it. */
export type IgnoreScope = { ratingKey: string; seasons?: number[] };

/** `coverageRevision`: the committed coverage revision to reload, present only when flags were cleared. */
export type IgnoreCleanup = { coverageRevision?: number };

/**
 * Clear Report Missing flags for newly applied Ignore scopes: Ignore is
 * authoritative over Report Missing. Deletes the explicit flags of Manual Match
 * members inside the scopes and runs `saveIgnore` (the synchronous Ignore save)
 * in the same transaction, so a failure saves neither. Then rechecks every show
 * of the affected Manual Matches, so derived effects elsewhere are withdrawn at
 * once. Flags outside the scopes and every other Manual Match are kept; Restore
 * or expiry never brings flags back. Refused during a Plex scan run only when
 * there are flags to clear; with none, `saveIgnore` still runs exactly once, with
 * no revision change and no recheck.
 */
export async function clearReportMissingForIgnore(scopes: IgnoreScope[], saveIgnore: () => void): Promise<IgnoreCleanup> {
  const members = clearReportMissingFlags(membersInIgnoreScopes(scopes), saveIgnore);
  if (!members.length) return {};
  await recheckAfterCommit({ members });
  // The committed revision, whose rechecked (or, after a failed recheck, pending) report the page reloads.
  return { coverageRevision: coverageState().revision };
}

/**
 * Manual Match members inside an Ignore scope. A member belongs to the ignored
 * show when that show's saved comparison has it as its own provider show or
 * lists it in that show's catalogue, or, only when the show has no saved
 * comparison, when one of the show's Plex items carries its identity. Aliases
 * never match. A season Ignore also requires the member's provider season (from
 * the saved catalogue, else the saved member) to be one of the selected seasons.
 */
function membersInIgnoreScopes(scopes: IgnoreScope[]): CoverageMember[] {
  if (!scopes.length) return [];
  const inputs = readPlexInputs();
  // Provider season of every catalogued episode, built once per cleanup.
  const seasons = new Map<string, number>();
  for (const [provider, catalogues] of [["TMDB", inputs.tmdb], ["TVDB", inputs.tvdb]] as const)
    for (const catalogue of Object.values(catalogues)) for (const episode of catalogue.episodes)
      if (episode.providerEpisodeId) seasons.set(`${provider}:${episode.providerEpisodeId}`, episode.season);
  // The member's own provider show only, not aliases or Plex GUIDs, so a
  // mis-tagged item or shared alias never reaches another show's flags.
  const ownShow = (input: SavedPlexComparison, member: CoverageMember) => member.provider === "TMDB"
    ? input.tmdbId === member.showId || Boolean(input.tmdbId && inputs.tmdb[String(input.tmdbId)]?.episodes.some(episode => episode.providerEpisodeId === member.id))
    : input.tvdbId === member.showId || Boolean(input.tvdbId && inputs.tvdb[String(input.tvdbId)]?.episodes.some(episode => episode.providerEpisodeId === member.id));
  return listCoverageMappings().flatMap(mapping => mapping.members).filter(member => scopes.some(scope => {
    const input = inputs.comparisons[scope.ratingKey];
    // Without a saved comparison, fall back to the show's own Plex items.
    const inShow = input ? ownShow(input, member)
      : Boolean(inputs.inventory?.evidence.some(item => item.showKey === scope.ratingKey && item.identities.some(identity => identity.provider === member.provider && identity.id === member.id)));
    return inShow && (!scope.seasons || scope.seasons.includes(seasons.get(`${member.provider}:${member.id}`) ?? member.season));
  }));
}

/**
 * The cached recheck after a committed change. A rejected recheck never undoes
 * the commit: the change and the pending comparison its transaction set stay,
 * so the command still reports the committed change. The store's transaction
 * also carried the affected members, so every later recheck compares their
 * shows too, and the Plex page keeps the last results with the comparison
 * pending notice until a cached recheck or a committed full Plex scan run
 * compares every show of each carried member.
 * Known limit: a recheck that fails early may not yet have written every
 * affected show's refresh obligation; a later recheck or scan writes them.
 */
async function recheckAfterCommit(impact: CoverageImpact): Promise<void> {
  try {
    await requestCoverageRecheck(impact);
  } catch (error) {
    console.error("Shelfcheck saved the change but could not recheck Plex results; the comparison stays pending.", error);
  }
}
