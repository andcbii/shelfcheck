import { CatalogueSelectionError, readCatalogueSelections, saveCatalogueOverride } from "@/lib/catalogue-selection-store";
import { requestCatalogueRecheck } from "@/lib/plex-scan";
import { coverageState } from "@/lib/manual-coverage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/**
 * Save (`seriesId`: a Plex-reported candidate) or clear (`seriesId`: null) one show's catalogue
 * override for one provider, then recheck only that show from saved inputs. Rejected while a
 * Plex scan is active; every response carries the persisted selection for the show.
 */
export async function POST(request: Request) {
  let identity: string | undefined;
  try {
    const body = await request.json().catch(() => { throw new CatalogueSelectionError("Supply a valid JSON request."); });
    if (!body || typeof body !== "object" || typeof body.identity !== "string" || !body.identity)
      throw new CatalogueSelectionError("Supply the Plex show identity.");
    identity = body.identity as string;
    const provider: unknown = body.provider;
    if (provider !== "tmdb" && provider !== "tvdb") throw new CatalogueSelectionError("Choose a TMDB or TVDB catalogue.");
    const seriesId = body.seriesId;
    if (seriesId !== null && !(Number.isSafeInteger(seriesId) && seriesId > 0))
      throw new CatalogueSelectionError("Choose a series ID, or clear the override.");
    if (seriesId !== null && (readCatalogueSelections()[identity]?.[provider].candidates.length || 0) < 2)
      throw new CatalogueSelectionError(`Plex reports only one ${provider.toUpperCase()} series for this show, so there is nothing to override.`);
    saveCatalogueOverride(identity, provider, seriesId);
    await requestCatalogueRecheck(identity, provider);
    return Response.json({ selection: readCatalogueSelections()[identity] || null, ...coverageState() }, { headers });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "The catalogue selection could not be saved.",
      code: error instanceof CatalogueSelectionError ? error.code : "recheck-failed",
      selection: identity ? readCatalogueSelections()[identity] || null : null,
    }, { status: error instanceof CatalogueSelectionError ? error.status : 500, headers });
  }
}
