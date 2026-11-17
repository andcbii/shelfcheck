import { CatalogueSelectionError, readShowCatalogueSelection, saveCatalogueOverride } from "@/lib/catalogue-selection-store";
import { requestCatalogueRecheck } from "@/lib/plex-scan";
import { coverageState } from "@/lib/manual-coverage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/**
 * Save (`seriesId`: a Plex-reported candidate) or clear (`seriesId`: null) one show's catalogue
 * override for one provider, then recheck only that show from saved inputs. Rejected while a
 * Plex scan is active, before any validation; every response carries the persisted selection for the show.
 */
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => undefined);
  const { identity, provider, seriesId } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const persisted = () => typeof identity === "string" && identity ? readShowCatalogueSelection(identity) || null : null;
  try {
    saveCatalogueOverride(identity, provider, seriesId);
    await requestCatalogueRecheck(identity as string, provider as "tmdb" | "tvdb");
    return Response.json({ selection: persisted(), ...coverageState() }, { headers });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "The catalogue selection could not be saved.",
      code: error instanceof CatalogueSelectionError ? error.code : "recheck-failed",
      selection: persisted(),
    }, { status: error instanceof CatalogueSelectionError ? error.status : 500, headers });
  }
}
