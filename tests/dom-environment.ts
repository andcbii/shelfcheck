import type test from "node:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// A happy-dom page with a React root, installed as the globals React reads and
// removed again, with the previous globals restored, when the test ends.
export function mountDom(t: test.TestContext, globals: Record<string, unknown> = {}): { browser: Window; container: HTMLElement; root: Root } {
  const browser = new Window({ url: "http://localhost/plex" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, HTMLElement: browser.HTMLElement, KeyboardEvent: browser.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true, ...globals })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  });
  return { browser, container, root };
}
