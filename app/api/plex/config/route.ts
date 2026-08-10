import { readPlexProviderStatus, writePlexProviders, type PlexProviderPatch } from "@/lib/server-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readPlexProviderStatus(), { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const value = (key: string) => typeof body[key] === "string" ? body[key].trim() : "";
  const credentials: PlexProviderPatch = {};
  for (const key of ["plexUrl", "plexToken", "tmdbToken", "tvdbApiKey", "tvdbPin"] as const) {
    if (Object.prototype.hasOwnProperty.call(body, key)) credentials[key] = body[key] === null ? null : value(key);
  }
  if (credentials.plexUrl) {
    try { new URL(credentials.plexUrl); } catch { return Response.json({ error: "Enter a valid Plex server URL." }, { status: 400 }); }
  }
  await writePlexProviders(credentials);
  return Response.json({ saved: true, ...await readPlexProviderStatus() });
}
