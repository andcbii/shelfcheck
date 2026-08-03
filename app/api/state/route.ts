import { readSingleUserState, writeSingleUserState } from "@/lib/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(readSingleUserState(), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function PATCH(request: Request) {
  const patch = await request.json() as Record<string, unknown>;
  const current = readSingleUserState();
  writeSingleUserState({ ...(current.state || {}), ...patch });
  return Response.json({ saved: true });
}
