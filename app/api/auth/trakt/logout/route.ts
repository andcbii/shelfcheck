import { clearTraktAuthorization } from "@/lib/server-config";

export const runtime = "nodejs";

export async function POST() {
  await clearTraktAuthorization();
  return Response.json({ connected: false }, { headers: { "Cache-Control": "private, no-store" } });
}
