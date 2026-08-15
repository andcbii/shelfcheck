import { clearScanCache, getScanStatus, startScan } from "@/lib/scan";
import { positiveInteger } from "@/lib/positive-integer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ scan: getScanStatus() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { force?: boolean; traktId?: number };
  const traktId = positiveInteger(body.traktId);
  return Response.json({ scan: startScan(body.force === true, traktId) }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE(request: Request) {
  try {
    const value = new URL(request.url).searchParams.get("traktId");
    const traktId = positiveInteger(value);
    if (value !== null && traktId === undefined) return Response.json({ error: "A positive Trakt show ID is required." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
    return Response.json(clearScanCache(traktId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck could not clear the scan cache." }, { status: 409 });
  }
}
