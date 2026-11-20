import type test from "node:test";
import { act } from "react";

// Presses the pointer down on an element, as a click outside or inside a menu starts.
export async function pressOn(target: Element) {
  await act(async () => { target.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); });
}

// Presses Escape with focus outside any dialog.
export async function pressEscape() {
  await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
}

// Counts the document's live pointerdown listeners, the ones that close menus on an outside press.
export function watchDocumentPointerListeners(t: test.TestContext) {
  const live = new Set<unknown>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  t.mock.method(document, "addEventListener", (type: string, listener: EventListener, options?: AddEventListenerOptions) => {
    if (type === "pointerdown") live.add(listener);
    return add(type, listener, options);
  });
  t.mock.method(document, "removeEventListener", (type: string, listener: EventListener, options?: EventListenerOptions) => {
    if (type === "pointerdown") live.delete(listener);
    return remove(type, listener, options);
  });
  return () => live.size;
}
