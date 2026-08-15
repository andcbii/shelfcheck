import { clearPlexScanCache, getPlexReport, getPlexScanStatus, startPlexScan } from "@/lib/plex-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() { return Response.json({ scan: getPlexScanStatus(), report: getPlexReport() }, { headers: { "Cache-Control": "private, no-store" } }); }
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { ratingKey?: string };
    const ratingKey = typeof body.ratingKey === "string" ? body.ratingKey.trim() || undefined : undefined;
    return Response.json({ scan: startPlexScan(ratingKey) }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
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
