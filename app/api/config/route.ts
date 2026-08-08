import { readTraktApplication, readTraktCredentials, writeTraktApplication } from "@/lib/server-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const credentials = await readTraktCredentials();
  const application = await readTraktApplication();
  return Response.json({ connected: Boolean(credentials), applicationConfigured: Boolean(application) }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function PUT(request: Request) {
  const body = await request.json() as { clientId?: unknown; clientSecret?: unknown };
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  if (!clientId || !clientSecret) {
    return Response.json({ error: "Both the Trakt Client ID and Client Secret are required." }, { status: 400 });
  }
  await writeTraktApplication({ clientId, clientSecret });
  return Response.json({ connected: false, applicationConfigured: true });
}
