"use client";

import { useEffect, useState } from "react";
import { activeScanShows, pauseCountdownWording, rateLimitPauseWording, scanPreparationWording, scanStepWording, type ScanProgressStatus } from "@/lib/scan-run-activity";

type ScanProgressBoxProps = {
  /** The overall progress, 0 to 100, for the acid bar along the bottom. */
  progress: number;
  status: ScanProgressStatus;
  /** Whether the page shows the Scan run as paused for a rate limit; the page decides, as it does for its radar and button. */
  paused: boolean;
  /** How many shows the page's scan checks at once; more lines than that are not shown. */
  maxShows: number;
};

/**
 * The box under a report heading while the page follows a Scan run: the shows
 * it is checking right now, each with its step in plain English, or what it is
 * doing before the first show starts, over the acid progress bar. The scan
 * button already shows the "N of M" count, so the box does not repeat it.
 *
 * During a rate-limit pause the box is marked paused (its show lines dim), its
 * heading reads "Waiting", and a notice names the provider with the resume time
 * and a countdown when the status says when the pause ends.
 */
export function ScanProgressBox({ progress, status, paused, maxShows }: ScanProgressBoxProps) {
  const shows = activeScanShows(status.activeShows).slice(0, maxShows);
  const preparing = shows.length === 0 ? scanPreparationWording(status.currentPhase) : null;
  const resumeAt = paused && status.rateLimitResumeAt ? Date.parse(status.rateLimitResumeAt) : NaN;
  const resumesAt = Number.isFinite(resumeAt) ? new Date(resumeAt) : null;
  return <div className="scan-progress" data-paused={paused ? "true" : undefined}>
    <div className="scan-progress-head"><strong>{paused ? "Waiting" : "Now checking"}</strong><span>Progress is saved periodically.</span></div>
    {paused && <p className="scan-progress-pause">
      <span aria-hidden="true">⏸</span>
      <span className="scan-progress-pause-text">{rateLimitPauseWording(status.rateLimitProvider, resumesAt)}</span>
      {/* Keyed by the deadline, so a new deadline starts a fresh countdown from the current clock. */}
      {resumesAt && <PauseCountdown key={resumeAt} resumeAt={resumeAt} />}
    </p>}
    {shows.length > 0 && <ul className="scan-progress-shows">{shows.map((item) => <li key={item.key}>
      <span className="scan-progress-show">{item.show}</span>
      <span className="scan-progress-step">{scanStepWording(item.phase)}</span>
    </li>)}</ul>}
    {preparing && <p className="scan-progress-solo">{preparing}</p>}
    <span className="scan-progress-bar" style={{ width: `${progress}%` }} />
  </div>;
}

/**
 * Whole seconds until the pause's deadline, ticking on its own timer between
 * status answers and stopping at zero. Reaching zero does not end the pause on
 * screen: only a status that clears it does.
 */
function PauseCountdown({ resumeAt }: { resumeAt: number }) {
  const [now, setNow] = useState(Date.now);
  const remaining = Math.max(0, resumeAt - now);
  useEffect(() => {
    if (remaining <= 0) return;
    // Wakes when the shown whole second changes.
    const timer = window.setTimeout(() => setNow(Date.now()), ((remaining - 1) % 1000) + 1);
    return () => window.clearTimeout(timer);
  }, [remaining]);
  return <span className="scan-progress-countdown">{pauseCountdownWording(Math.ceil(remaining / 1000))}</span>;
}
