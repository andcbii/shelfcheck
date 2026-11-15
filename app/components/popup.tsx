"use client";
import { useEffect, useRef, type ReactNode } from "react";

export type PopupCloseReason = "close" | "escape" | "outside";
type Props = {
  title: string;
  className?: string;
  // The single close hook. Close, Esc and a click outside only ask to close;
  // the owner closes the popup by no longer rendering it, so it can intercept
  // (for example, to ask "Discard your changes?") before doing so.
  onRequestClose: (reason: PopupCloseReason) => void;
  children?: ReactNode;
};

export function Popup({ title, className = "", onRequestClose, children }: Props) {
  const requestClose = useRef(onRequestClose);
  useEffect(() => { requestClose.current = onRequestClose; });
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") requestClose.current("escape"); };
    // The popup scrolls inside itself; the page behind it stays put while it is open.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = overflow;
    };
  }, []);
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onRequestClose("outside"); }}><section className={`modal popup ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={() => onRequestClose("close")} aria-label={`Close ${title}`}>Close</button></header>{children}</section></div>;
}
