"use client";

import { IGNORE_DURATIONS, type IgnoreDuration } from "@/lib/ignored-shows";

type DurationOptionsProps = {
  currentDuration?: IgnoreDuration;
  onSelect: (duration: IgnoreDuration) => void;
};

export function IgnoreDurationOptions({ currentDuration, onSelect }: DurationOptionsProps) {
  return <div className="ignore-duration-options" role="group" aria-label="Ignore duration">
    {IGNORE_DURATIONS.map(({ value, label }) => <button key={value} type="button" aria-pressed={currentDuration === undefined ? undefined : currentDuration === value} onClick={() => onSelect(value)}>{label}</button>)}
  </div>;
}

type DurationSelectProps = {
  duration: IgnoreDuration;
  onChange: (duration: IgnoreDuration) => void;
};

export function IgnoreDurationSelect({ duration, onChange }: DurationSelectProps) {
  return <label className="ignore-duration-select"><span>Ignore for</span><select value={duration} onChange={(event) => onChange(event.target.value as IgnoreDuration)}>{IGNORE_DURATIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>;
}
