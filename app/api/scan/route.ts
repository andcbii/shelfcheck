import { getScanStatus, startScan } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ scan: getScanStatus() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { force?: boolean };
  return Response.json({ scan: startScan(body.force === true) }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}
