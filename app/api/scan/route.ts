import { clearScanCache, getScanStatus, startScan } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ scan: getScanStatus() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { force?: boolean };
  return Response.json({ scan: startScan(body.force === true) }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE() {
  try {
    return Response.json(clearScanCache(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shelfcheck could not clear the scan cache." }, { status: 409 });
  }
}
