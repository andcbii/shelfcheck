import { resolveCoverageUrls } from "@/lib/manual-coverage-resolver";
import { deleteManualMatches, saveManualMatch } from "@/lib/manual-match-changes";
import { CoverageError, coverageState, listCoverageMappings, readCoverageEvidence } from "@/lib/manual-coverage";
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
    if (body.action === "resolve") {
      const resolved = await resolveCoverageUrls(body.urls);
      const existingMapping = body.id === undefined ? listCoverageMappings().find(mapping => mapping.members.some(member => resolved.members.some(candidate => candidate.provider === member.provider && candidate.id === member.id))) : undefined;
      return Response.json({ ...resolved, ...(existingMapping ? { existingMapping } : {}) }, { headers });
    }
    if (body.id !== undefined && (typeof body.id !== "string" || !body.id))
      throw new CoverageError("Supply the Manual Match ID to edit.");
    const { mapping, created } = await saveManualMatch({ id: body.id, revision: body.revision, preview: body.preview, reportMissing: body.reportMissing });
    return Response.json({ mapping, ...coverageState() }, { status: created ? 201 : 200, headers });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    const ids = id === null ? (await request.json().catch(() => { throw new CoverageError("Supply the selected Manual Match IDs as JSON."); }))?.ids : undefined;
    const result = await deleteManualMatches(id === null ? { ids } : { id });
    return Response.json({ ...result, ...coverageState() }, { headers });
  } catch (error) {
    return failure(error);
  }
}
function failure(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : "Manual coverage failed.", code: error instanceof CoverageError ? error.code : "provider-unavailable", ...(error instanceof CoverageError && error.mappingId ? { mappingId: error.mappingId } : {}) }, { status: error instanceof CoverageError ? error.status : 503, headers });
}
