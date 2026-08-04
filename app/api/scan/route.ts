import { getScanStatus, startScan } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ scan: getScanStatus() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST() {
  return Response.json({ scan: startScan() }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}
