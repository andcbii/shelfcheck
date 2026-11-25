import { savedScanState } from "@/lib/ignore-results";
import { plexArtworkIndex } from "@/lib/plex-artwork";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };

/**
 * The artwork index of the last saved Plex report, for the Trakt page's Plex
 * artwork fallback. It reads saved data only: no Plex or provider request, no
 * report change, and no Plex address or token in the answer.
 */
export async function GET() {
  try {
    return Response.json({ shows: plexArtworkIndex(savedScanState("plex").report.read()) }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Plex artwork could not be loaded." }, { status: 500, headers });
  }
}
