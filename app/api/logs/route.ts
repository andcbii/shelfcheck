import { deleteAllScanLogs, readCurrentScanLog } from "@/lib/scan-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const log = readCurrentScanLog();
  if (!log) return Response.json({ error: "No diagnostic scan log is available." }, { status: 404 });
  return new Response(log, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": "attachment; filename=shelfcheck.log",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function DELETE() {
  return Response.json({ deleted: deleteAllScanLogs() }, { headers: { "Cache-Control": "private, no-store" } });
}
