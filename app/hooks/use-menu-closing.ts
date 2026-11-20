"use client";
import { useEffect, useRef } from "react";

// One menu or panel a page closes on Escape. With isInside it also closes on a
// pointer press outside it; without, outside presses leave it open.
export type ClosableMenu = {
  open: boolean;
  isInside?: (target: Element) => boolean;
  close: () => void;
};

// Closes a page's menus on an outside pointer press or Escape. The document
// listeners exist only while a listed menu is open. Escape also runs every
// alsoOnEscape closer, for popups that close on Escape but never arm the listeners.
export function useMenuClosing(menus: ClosableMenu[], alsoOnEscape: (() => void)[] = []) {
  const latest = useRef({ menus, alsoOnEscape });
  useEffect(() => { latest.current = { menus, alsoOnEscape }; });
  const anyOpen = menus.some((menu) => menu.open);

  useEffect(() => {
    if (!anyOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      for (const menu of latest.current.menus) {
        if (menu.open && menu.isInside && !menu.isInside(target)) menu.close();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      for (const menu of latest.current.menus) menu.close();
      for (const close of latest.current.alsoOnEscape) close();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [anyOpen]);
}
