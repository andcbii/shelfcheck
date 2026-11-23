import "server-only";
import { resolveCoverageUrls, reviewedCoverageMembers } from "@/lib/manual-coverage-resolver";
import { requestCoverageRecheck, type CoverageImpact } from "@/lib/plex-scan";
import { assertCoverageMutationAllowed, deleteCoverageMapping, deleteCoverageMappings, saveCoverageMapping, type ManualMatchEdit } from "@/lib/manual-coverage";
import type { CoverageMapping } from "@/lib/manual-coverage-model";

/**
 * Manual Match changes: each command runs the whole sequence (scan check,
 * provider revalidation for a reviewed save, the store's transactional write,
 * then one cached recheck of the members the committed change affects).
 * Routes only parse requests and map results and errors. Preview resolution is
 * a read and stays outside this module.
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
  await resolveCoverageUrls(reviewed.map(member => member.provider === "TVDB" ? `tvdb:${member.id}` : `tmdb:${member.id} show:${member.showId} season:${member.season} episode:${member.episode}`));
  const { mapping, affectedMembers } = saveCoverageMapping(reviewed, edit, reportMissing);
  await recheckAfterCommit({ members: affectedMembers });
  return { manualMatch: mapping, created: !edit };
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

/**
 * The cached recheck after a committed change. A rejected recheck never undoes
 * the commit: the change and the pending comparison its transaction set stay,
 * so the command still reports the committed change. Only a successful recheck
 * marks the comparison complete, so the Plex page keeps the last results with
 * the comparison pending notice until a later recheck or Plex scan succeeds.
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
