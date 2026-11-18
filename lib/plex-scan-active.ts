import { scanRuns } from "@/lib/scan-run";

/**
 * Whether a Plex Scan run owns the scan run lock in this process; Manual Match
 * and comparison catalogue changes are rejected meanwhile. A Trakt Scan run
 * does not count.
 */
export function isPlexScanActive(): boolean {
  return scanRuns.isActive("plex");
}
