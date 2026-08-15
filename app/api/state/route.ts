import { patchSingleUserState, readSingleUserScanStatus, readSingleUserState } from "@/lib/sqlite";
import { parseTraktPreferencesPatch } from "@/lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stored = readSingleUserState();
    const scan = readSingleUserScanStatus();
    return Response.json({ ...stored, state: stored.state ? { ...stored.state, ...(scan ? { scan } : {}) } : stored.state }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck state could not be loaded." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}

export async function PATCH(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    patchSingleUserState(parseTraktPreferencesPatch(body));
    return Response.json({ saved: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck settings could not be saved." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
