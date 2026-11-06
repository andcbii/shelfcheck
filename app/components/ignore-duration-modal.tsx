"use client";

import { useEffect, useRef } from "react";
import type { IgnoreDuration } from "@/lib/ignored-shows";
import { IgnoreDurationOptions } from "@/app/components/ignore-duration-controls";

export function useIgnoreDialogFocus(onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.querySelector<HTMLElement>("button, select, input")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return dialogRef;
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
