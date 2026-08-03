import { readTraktCredentials, writeTraktCredentials } from "@/lib/server-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const credentials = await readTraktCredentials();
  return Response.json({ configured: Boolean(credentials) }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function PUT(request: Request) {
  const body = await request.json() as { clientId?: unknown; accessToken?: unknown };
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (!clientId || !accessToken) {
    return Response.json({ error: "Both the Trakt client ID and access token are required." }, { status: 400 });
  }
  await writeTraktCredentials({ clientId, accessToken });
  return Response.json({ configured: true });
}
