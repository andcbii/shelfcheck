import { readPlexSettings, writePlexSettings } from "@/lib/sqlite";
import { parsePlexPreferences, parsePlexPreferencesPatch, type PlexPreferences } from "@/lib/preferences";
import { activeIgnores } from "@/lib/ignored-shows";
import { applyIgnoreReportMissingCleanup, type IgnoreScope } from "@/lib/plex-scan";
import { CoverageError } from "@/lib/manual-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    return Response.json({ settings: parsePlexPreferences(readPlexSettings()) }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Plex preferences could not be loaded." }, { status: 500, headers });
  }
}

/**
 * Scopes this save newly ignores: shows and seasons active after it that were
 * not actively ignored before. Changing an existing Ignore's duration applies
 * nothing new. Temporary and permanent Ignore are treated the same.
 */
function appliedIgnoreScopes(before: PlexPreferences, after: PlexPreferences): IgnoreScope[] {
  const shows = new Set(activeIgnores(before.ignoredShows).map(show => show.ratingKey));
  const seasons = new Map(activeIgnores(before.ignoredSeasons).map(show => [show.ratingKey, new Set(show.seasons)]));
  return [
    ...activeIgnores(after.ignoredShows).filter(show => !shows.has(show.ratingKey)).map(show => ({ ratingKey: show.ratingKey })),
    ...activeIgnores(after.ignoredSeasons).flatMap(show => {
      const added = show.seasons.filter(season => !seasons.get(show.ratingKey)?.has(season));
      return added.length ? [{ ratingKey: show.ratingKey, seasons: added }] : [];
    }),
  ];
}

export async function PATCH(request: Request) {
  try {
    const patch = parsePlexPreferencesPatch(await request.json().catch(() => ({})));
    const before = parsePlexPreferences(readPlexSettings());
    const next = parsePlexPreferences({ ...readPlexSettings(), ...patch });
    // Ignore is authoritative over Report Missing: applying it deletes flags in its
    // scope in the same transaction that saves the rule.
    await applyIgnoreReportMissingCleanup(appliedIgnoreScopes(before, next), () => writePlexSettings(next));
    return Response.json({ saved: true }, { headers });
  } catch (error) {
    if (error instanceof CoverageError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    return Response.json({ error: error instanceof Error ? error.message : "Plex preferences could not be saved." }, { status: 500, headers });
  }
}
