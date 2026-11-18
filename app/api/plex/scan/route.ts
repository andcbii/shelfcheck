import { readCatalogueSelections } from "@/lib/catalogue-selection-store";
import { coverageState } from "@/lib/manual-coverage";
import { clearPlexScanCache, getPlexReport, getPlexScanStatus, startPlexScan } from "@/lib/plex-scan";
import { scanRunConflictResponse } from "@/lib/scan-run-conflict";
import { ScanRunConflictError } from "@/lib/scan-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The saved report, each show carrying its persisted comparison catalogue selection for the results notice. */
function reportWithCatalogueSelections() {
  const report = getPlexReport();
  if (!report) return report;
  const selections = readCatalogueSelections();
  return { ...report, shows: report.shows.map((show) => selections[show.ratingKey] ? { ...show, catalogueSelection: selections[show.ratingKey] } : show) };
}

export async function GET() { return Response.json({ scan: getPlexScanStatus(), report: reportWithCatalogueSelections(), coverage: coverageState() }, { headers: { "Cache-Control": "private, no-store" } }); }
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { ratingKey?: string };
    const ratingKey = typeof body.ratingKey === "string" ? body.ratingKey.trim() || undefined : undefined;
    return Response.json({ scan: startPlexScan(ratingKey) }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ScanRunConflictError) return scanRunConflictResponse(error);
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck could not start the Plex scan." }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
  }
}
export async function DELETE(request: Request) {
  try {
    const ratingKey = new URL(request.url).searchParams.get("ratingKey")?.trim() || undefined;
    return Response.json(clearPlexScanCache(ratingKey), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck could not clear the Plex scan cache." }, { status: 409 });
  }
}
