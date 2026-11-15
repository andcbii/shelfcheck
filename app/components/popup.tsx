"use client";
import { useEffect, type ReactNode } from "react";
import { useDialogFocus } from "@/app/components/dialog-focus";

export type PopupCloseReason = "close" | "escape" | "outside";
type Props = {
  title: string;
  className?: string;
  // The single close hook. Close, Esc and a click outside only ask to close;
  // the owner closes the popup by no longer rendering it, so it can intercept
  // (for example, to ask "Discard your changes?") before doing so.
  onRequestClose: (reason: PopupCloseReason) => void;
  children: ReactNode;
};

// The page behind open popups stays put; it gets its own overflow back when the last one closes.
let scrollLocks = 0;
let pageOverflow = "";
function lockPageScroll() {
  if (scrollLocks++ === 0) {
    pageOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  return () => { if (--scrollLocks === 0) document.body.style.overflow = pageOverflow; };
}

export function Popup({ title, className = "", onRequestClose, children }: Props) {
  const dialogRef = useDialogFocus<HTMLElement>(() => onRequestClose("escape"), "document");
  useEffect(lockPageScroll, []);
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onRequestClose("outside"); }}><section ref={dialogRef} className={`modal popup ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={() => onRequestClose("close")} aria-label={`Close ${title}`}>Close</button></header>{children}</section></div>;
}
