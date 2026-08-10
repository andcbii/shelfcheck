import { patchSingleUserState, readSingleUserScanStatus, readSingleUserState } from "@/lib/sqlite";
import { parseTraktPreferencesPatch } from "@/lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const stored = readSingleUserState();
  const scan = readSingleUserScanStatus();
  return Response.json({ ...stored, state: stored.state ? { ...stored.state, ...(scan ? { scan } : {}) } : stored.state }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function PATCH(request: Request) {
  const body: unknown = await request.json().catch(() => ({}));
  patchSingleUserState(parseTraktPreferencesPatch(body));
  return Response.json({ saved: true });
}
