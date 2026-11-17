/** The in-flight Plex scan, shared across module instances through `globalThis`. */
export type PlexScanGlobal = typeof globalThis & { __shelfcheckPlexScan?: Promise<void> };

/** Whether a Plex scan is running in this process; mutations of scan inputs are rejected meanwhile. */
export function isPlexScanActive(): boolean {
  return Boolean((globalThis as PlexScanGlobal).__shelfcheckPlexScan);
}
