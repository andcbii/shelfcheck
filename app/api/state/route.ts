import { patchSingleUserState, readSingleUserScanStatus, readSingleUserState } from "@/lib/sqlite";

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
  const patch = await request.json() as Record<string, unknown>;
  const statePatch = { ...patch };
  delete statePatch.scan;
  patchSingleUserState(statePatch);
  return Response.json({ saved: true });
}
