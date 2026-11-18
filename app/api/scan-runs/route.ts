import { scanRuns } from "@/lib/scan-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which Scan run, if any, owns the lock, read from the owner record alone.
 * Pages poll this to lock their scan controls while the other kind runs. It is
 * read-only: it never reads either kind's stored status, so it never reconciles
 * an Interrupted scan or raises a Coverage Issue; the per-kind status routes do that.
 */
export async function GET() {
  const owner = scanRuns.activeScanRun();
  return Response.json({ activeScanRun: owner ? { kind: owner.kind, startedAt: owner.startedAt } : null }, { headers: { "Cache-Control": "private, no-store" } });
}
