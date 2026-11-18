import "server-only";
import { getPlexScanStatus } from "@/lib/plex-scan";
import { getScanStatus } from "@/lib/scan";
import type { ScanRunConflictError } from "@/lib/scan-run";

/**
 * The 409 for a start refused because another Scan run owns the lock: the
 * message naming the running scan, and the running kind with its own status.
 * The running status sits under `activeScanRun`, never under `scan`, so it is
 * never presented as the requested scan. This lives outside the lifecycle
 * module because reading each kind's status needs the scan modes.
 */
export function scanRunConflictResponse(conflict: ScanRunConflictError): Response {
  const { kind, startedAt } = conflict.owner;
  const status = kind === "plex" ? getPlexScanStatus() : getScanStatus();
  return Response.json({ error: conflict.message, activeScanRun: { kind, startedAt, status } }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
}
