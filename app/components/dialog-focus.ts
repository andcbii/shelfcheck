"use client";
import { useEffect, useRef } from "react";

// Dialogs listening for Esc on the whole document, topmost last: only the topmost one closes.
const documentEscapeStack: object[] = [];

type EscapeScope =
  // Esc closes the dialog only while focus is inside it, and goes no further.
  | "dialog"
  // Esc closes the topmost open dialog wherever focus is.
  | "document";

// Moves focus into the dialog when it opens, keeps Tab within it, closes it on Esc
// (always calling the latest onEscape) and gives focus back when it closes.
export function useDialogFocus<T extends HTMLElement = HTMLElement>(onEscape: () => void, escapeScope: EscapeScope = "dialog") {
  const dialogRef = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => { onEscapeRef.current = onEscape; }, [onEscape]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.querySelector<HTMLElement>("button, select, input")?.focus();
    const token = {};
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (escapeScope === "document" && documentEscapeStack.at(-1) !== token) return;
      event.preventDefault();
      event.stopPropagation();
      onEscapeRef.current();
    };
    const keepTabInside = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const escapeTarget: Pick<EventTarget, "addEventListener" | "removeEventListener"> = escapeScope === "document" ? document : dialog;
    if (escapeScope === "document") documentEscapeStack.push(token);
    escapeTarget.addEventListener("keydown", closeOnEscape as EventListener);
    dialog.addEventListener("keydown", keepTabInside);
    return () => {
      escapeTarget.removeEventListener("keydown", closeOnEscape as EventListener);
      dialog.removeEventListener("keydown", keepTabInside);
      const index = documentEscapeStack.indexOf(token);
      if (index >= 0) documentEscapeStack.splice(index, 1);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [escapeScope]);

  return dialogRef;
}
