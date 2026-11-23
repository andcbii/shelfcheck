import "server-only";
import { resolveCoverageUrls, reviewedCoverageMembers } from "@/lib/manual-coverage-resolver";
import { requestCoverageRecheck } from "@/lib/plex-scan";
import { assertCoverageMutationAllowed, deleteCoverageMapping, deleteCoverageMappings, saveCoverageMapping } from "@/lib/manual-coverage";
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
 * `preview` (new, or an edit of `id` at `revision`), or, with no preview, a
 * Report Missing flag edit of the existing Manual Match `id`.
 */
export type ManualMatchSave = { id?: string; revision?: unknown; preview?: unknown; reportMissing?: unknown };

/** Save a Manual Match. `created` is true for a new Manual Match, false for an edit. */
export async function saveManualMatch(request: ManualMatchSave): Promise<{ mapping: CoverageMapping; created: boolean }> {
  // The store validates the revision inside its transaction.
  const edit = request.id === undefined ? undefined : { id: request.id, revision: request.revision as number };
  if (request.preview === undefined && edit && request.reportMissing !== undefined) {
    // Changing only Report Missing keeps the saved members, so it needs no provider review.
    const { mapping, affectedMembers } = saveCoverageMapping(undefined, edit, request.reportMissing);
    await requestCoverageRecheck({ members: affectedMembers });
    return { mapping, created: false };
  }
  // Fail fast before contacting providers; the store's check inside its transaction stays authoritative.
  assertCoverageMutationAllowed();
  const reviewed = reviewedCoverageMembers(request.preview);
  // Revalidate the exact reviewed canonical identities. Coordinates can locate a
  // different TMDB record since preview, but must never replace that identity.
  await resolveCoverageUrls(reviewed.map(member => member.provider === "TVDB" ? `tvdb:${member.id}` : `tmdb:${member.id} show:${member.showId} season:${member.season} episode:${member.episode}`));
  const { mapping, affectedMembers } = saveCoverageMapping(reviewed, edit, request.reportMissing);
  await requestCoverageRecheck({ members: affectedMembers });
  return { mapping, created: !edit };
}

/**
 * Delete one Manual Match (`id`: a missing one is "not found") or each listed
 * one once (`ids`: missing ones are listed). A delete that removed nothing
 * starts no cached recheck.
 */
export async function deleteManualMatches(target: { id: string } | { ids: unknown }): Promise<{ deleted: string[]; missing: string[] }> {
  const { deleted, missing, affectedMembers } = "id" in target ? deleteCoverageMapping(target.id) : deleteCoverageMappings(target.ids);
  if (deleted.length) await requestCoverageRecheck({ members: affectedMembers });
  return { deleted, missing };
}
