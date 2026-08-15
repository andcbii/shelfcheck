import { readPlexSettings, writePlexSettings } from "@/lib/sqlite";
import { parsePlexPreferences, parsePlexPreferencesPatch } from "@/lib/preferences";

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
  try {
    const patch = parsePlexPreferencesPatch(await request.json().catch(() => ({})));
    writePlexSettings(parsePlexPreferences({ ...readPlexSettings(), ...patch }));
    return Response.json({ saved: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Plex preferences could not be saved." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
