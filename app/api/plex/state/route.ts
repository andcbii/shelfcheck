import { readPlexSettings, writePlexSettings } from "@/lib/sqlite";
import { parsePlexPreferences } from "@/lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ settings: parsePlexPreferences(readPlexSettings()) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Plex preferences could not be loaded." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}

export async function PATCH(request: Request) {
  const patch: unknown = await request.json().catch(() => ({}));
  const current = readPlexSettings();
  const source = patch && typeof patch === "object" ? patch as Record<string, unknown> : {};
  writePlexSettings(parsePlexPreferences({ ...current, ...source }));
  return Response.json({ saved: true });
}
