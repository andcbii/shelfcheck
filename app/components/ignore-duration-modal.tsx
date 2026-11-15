"use client";

import type { IgnoreDuration } from "@/lib/ignored-shows";
import { IgnoreDurationOptions } from "@/app/components/ignore-duration-controls";
import { useDialogFocus } from "@/app/components/dialog-focus";

// Ignore dialogs close on Esc only while focus is inside them.
export function useIgnoreDialogFocus(onClose: () => void) {
  return useDialogFocus(onClose);
}

type Props = {
  showTitle: string;
  onClose: () => void;
  onSelect: (duration: IgnoreDuration) => void;
};

export function IgnoreDurationModal({ showTitle, onClose, onSelect }: Props) {
  const dialogRef = useIgnoreDialogFocus(onClose);
  return <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
    <section ref={dialogRef} className="modal ignore-duration-modal" role="dialog" aria-modal="true" aria-labelledby="ignore-duration-title" aria-describedby="ignore-duration-description">
      <button className="close" type="button" onClick={onClose} aria-label="Close ignore chooser">×</button>
      <p className="eyebrow">IGNORE SHOW</p><h2 id="ignore-duration-title">{showTitle}</h2>
      <p className="modal-copy" id="ignore-duration-description">Choose how long to ignore this show. It will be removed from saved results and skipped during scans. After expiry or Restore, run a new scan to get its results.</p>
      <IgnoreDurationOptions onSelect={onSelect} />
      <div className="modal-actions"><button className="secondary" type="button" onClick={onClose}>Cancel</button></div>
    </section>
  </div>;
}
