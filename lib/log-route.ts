import { deleteAllScanLogs, readCurrentScanLog } from "@/lib/scan-log";

export function createLogRoute(baseName: string, filename: string, unavailableMessage: string) {
  return {
    GET() {
      const log = readCurrentScanLog(baseName);
      if (!log) return Response.json({ error: unavailableMessage }, { status: 404 });
      return new Response(log, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename=${filename}`, "Cache-Control": "private, no-store" } });
    },
    DELETE() {
      return Response.json({ deleted: deleteAllScanLogs(baseName) }, { headers: { "Cache-Control": "private, no-store" } });
    },
  };
}
