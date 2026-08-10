import { clearPlexScanCache, getPlexReport, getPlexScanStatus, startPlexScan } from "@/lib/plex-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() { return Response.json({ scan: getPlexScanStatus(), report: getPlexReport() }, { headers: { "Cache-Control": "private, no-store" } }); }
export async function POST() { return Response.json({ scan: startPlexScan() }, { status: 202, headers: { "Cache-Control": "private, no-store" } }); }
export async function DELETE() {
  try {
    return Response.json(clearPlexScanCache(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck could not clear the Plex scan cache." }, { status: 409 });
  }
}
