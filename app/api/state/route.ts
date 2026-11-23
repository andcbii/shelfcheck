import { savedScanState } from "@/lib/ignore-results";
import { parseTraktPreferencesPatch } from "@/lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Trakt saved state, built from one snapshot: the options, with the report,
 * Resume point (as checkpoint) and scan status (as scan) nested when saved.
 * updatedAt is the state timestamp, which scan heartbeats do not move. Until the
 * report, Resume point or options are first saved there is no state, even when a
 * scan status is.
 */
function stateResponse() {
  const saved = savedScanState("trakt").snapshot();
  if (!saved?.updatedAt) return { state: null, updatedAt: null };
  return {
    state: {
      ...(saved.options || {}),
      ...(saved.report ? { report: saved.report } : {}),
      ...(saved.resumePoint ? { checkpoint: saved.resumePoint } : {}),
      ...(saved.status ? { scan: saved.status } : {}),
    },
    updatedAt: saved.updatedAt,
  };
}

export async function GET() {
  try {
    return Response.json(stateResponse(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck state could not be loaded." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}

export async function PATCH(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    savedScanState("trakt").options.patch(parseTraktPreferencesPatch(body));
    return Response.json({ saved: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck settings could not be saved." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
