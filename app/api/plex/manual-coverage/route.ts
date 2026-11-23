import { resolveCoverageUrls, reviewedCoverageMembers } from "@/lib/manual-coverage-resolver";
import { requestCoverageRecheck } from "@/lib/plex-scan";
import { assertCoverageMutationAllowed, CoverageError, type CoverageDeletion, coverageState, deleteCoverageMapping, deleteCoverageMappings, listCoverageMappings, readCoverageEvidence, saveCoverageMapping } from "@/lib/manual-coverage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  const evidence = readCoverageEvidence();
  const mappings = listCoverageMappings().map(mapping => ({ ...mapping, evidence: evidence.filter(item => item.identities.some(identity => mapping.members.some(member => identity.provider === member.provider && identity.id === member.id))) }));
  return Response.json({ ...coverageState(), mappings: id ? mappings.filter(m => m.id === id) : mappings }, { headers });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => {
      throw new CoverageError("Supply a valid JSON request.");
    });
    if (!body || typeof body !== "object")
      throw new CoverageError("Supply a valid request.");
    // Only mapping resolution and saves are accepted; ownership corrections were retired.
    if (body.action !== "resolve" && body.action !== "save" && body.action !== undefined)
      throw new CoverageError("This Manual Match action is not supported.", 400, "unsupported-action");
    if (body.action !== "resolve") assertCoverageMutationAllowed();
    if (body.action === "resolve") {
      const resolved = await resolveCoverageUrls(body.urls);
      const existingMapping = body.id === undefined ? listCoverageMappings().find(mapping => mapping.members.some(member => resolved.members.some(candidate => candidate.provider === member.provider && candidate.id === member.id))) : undefined;
      return Response.json({ ...resolved, ...(existingMapping ? { existingMapping } : {}) }, { headers });
    }
    if (body.id !== undefined && (typeof body.id !== "string" || !body.id))
      throw new CoverageError("Supply the Manual Match ID to edit.");
    if (body.preview === undefined && body.id !== undefined && body.reportMissing !== undefined) {
      // Changing only Report Missing keeps the saved members, so it needs no provider review.
      const { mapping, affectedMembers } = saveCoverageMapping(undefined, { id: body.id, revision: body.revision }, body.reportMissing);
      await requestCoverageRecheck({ members: affectedMembers });
      return Response.json({ mapping, ...coverageState() }, { headers });
    }
    const reviewed = reviewedCoverageMembers(body.preview);
    // Revalidate the exact reviewed canonical identities. Coordinates can locate a
    // different TMDB record since preview, but must never replace that identity.
    await resolveCoverageUrls(reviewed.map(member => member.provider === "TVDB" ? `tvdb:${member.id}` : `tmdb:${member.id} show:${member.showId} season:${member.season} episode:${member.episode}`));
    assertCoverageMutationAllowed();
    const { mapping, affectedMembers } = saveCoverageMapping(reviewed, body.id === undefined ? undefined : { id: body.id, revision: body.revision }, body.reportMissing);
    await requestCoverageRecheck({ members: affectedMembers });
    return Response.json({ mapping, ...coverageState() }, { status: body.id === undefined ? 201 : 200, headers });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertCoverageMutationAllowed();
    const id = new URL(request.url).searchParams.get("id");
    let result: CoverageDeletion;
    if (id !== null) {
      result = deleteCoverageMapping(id);
    } else {
      const body = await request.json().catch(() => { throw new CoverageError("Supply the selected Manual Match IDs as JSON."); });
      result = deleteCoverageMappings(body?.ids);
    }
    if (result.deleted.length) await requestCoverageRecheck({ members: result.affectedMembers });
    // The affected members stay internal: only the public delete fields are sent.
    return Response.json({ deleted: result.deleted, missing: result.missing, ...coverageState() }, { headers });
  } catch (error) {
    return failure(error);
  }
}
function failure(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : "Manual coverage failed.", code: error instanceof CoverageError ? error.code : "provider-unavailable", ...(error instanceof CoverageError && error.mappingId ? { mappingId: error.mappingId } : {}) }, { status: error instanceof CoverageError ? error.status : 503, headers });
}
