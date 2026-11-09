import { resolveCoverageUrls, reviewedCoverageMembers } from "@/lib/manual-coverage-resolver";
import { requestCoverageRecheck } from "@/lib/plex-scan";
import { CoverageError, coverageState, deleteCoverageMapping, listCoverageMappings, readCoverageEvidence, saveCoverageMapping } from "@/lib/manual-coverage";
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
    if (body.action === "resolve")
      return Response.json(await resolveCoverageUrls(body.urls), { headers });
    const mapping = saveCoverageMapping(reviewedCoverageMembers(body.preview));
    requestCoverageRecheck();
    return Response.json({ mapping, ...coverageState() }, { status: 201, headers });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    deleteCoverageMapping(id);
    requestCoverageRecheck();
    return Response.json({ deleted: [id], ...coverageState() }, { headers });
  } catch (error) {
    return failure(error);
  }
}
function failure(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : "Manual coverage failed.", code: error instanceof CoverageError ? error.code : "provider-unavailable", ...(error instanceof CoverageError && error.mappingId ? { mappingId: error.mappingId } : {}) }, { status: error instanceof CoverageError ? error.status : 503, headers });
}
