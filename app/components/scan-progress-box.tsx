"use client";

import { activeScanShows, scanPreparationWording, scanStepWording, type ScanProgressStatus } from "@/lib/scan-run-activity";

type ScanProgressBoxProps = {
  /** The overall progress, 0 to 100, for the acid bar along the bottom. */
  progress: number;
  status: ScanProgressStatus;
  /** How many shows the page's scan checks at once; more lines than that are not shown. */
  maxShows: number;
};

/**
 * The box under a report heading while the page follows a Scan run: the shows
 * it is checking right now, each with its step in plain English, or what it is
 * doing before the first show starts, over the acid progress bar. The scan
 * button already shows the "N of M" count, so the box does not repeat it.
 */
export function ScanProgressBox({ progress, status, maxShows }: ScanProgressBoxProps) {
  const shows = activeScanShows(status.activeShows).slice(0, maxShows);
  const preparing = shows.length === 0 ? scanPreparationWording(status.currentPhase) : null;
  return <div className="scan-progress">
    <div className="scan-progress-head"><strong>Now checking</strong><span>Progress is saved periodically.</span></div>
    {shows.length > 0 && <ul className="scan-progress-shows">{shows.map((item) => <li key={item.key}>
      <span className="scan-progress-show">{item.show}</span>
      <span className="scan-progress-step">{scanStepWording(item.phase)}</span>
    </li>)}</ul>}
    {preparing && <p className="scan-progress-solo">{preparing}</p>}
    <span className="scan-progress-bar" style={{ width: `${progress}%` }} />
  </div>;
}
