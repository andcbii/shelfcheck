import assert from "node:assert/strict";
import type test from "node:test";
import { act, createElement, StrictMode, type ComponentType } from "react";
import { mountDom } from "./dom-environment";

// Mounts a page in happy-dom, optionally under StrictMode, with the extra
// globals the pages read, and returns helpers for clicking and finding.
export async function renderPage(t: test.TestContext, Page: ComponentType, fetcher: typeof fetch, strictMode = false) {
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const listeners = watchDocumentListeners(t);
  await act(async () => { root.render(strictMode ? createElement(StrictMode, null, createElement(Page)) : createElement(Page)); });
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((element) => (element.getAttribute("aria-label") || element.textContent || "").includes(label));
    assert.ok(button, `Expected button: ${label}`);
    await act(async () => { button.click(); });
  }
  const find = (selector: string) => {
    const element = container.querySelector(selector);
    assert.ok(element, `Expected element: ${selector}`);
    return element;
  };
  const has = (selector: string) => () => container.querySelector(selector) !== null;
  return { container, root, click, find, has, listeners };
}

// Presses the pointer down on an element, as a click outside or inside a menu starts.
export async function pressOn(target: Element) {
  await act(async () => { target.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); });
}

// Presses Escape with focus outside any dialog.
export async function pressEscape() {
  await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
}

// Counts the document's live pointerdown and keydown listeners, the ones that
// close menus on an outside press or Escape.
function watchDocumentListeners(t: test.TestContext) {
  const live = { pointerdown: new Set<unknown>(), keydown: new Set<unknown>() };
  const watched = (type: string): type is keyof typeof live => type in live;
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  t.mock.method(document, "addEventListener", (type: string, listener: EventListener, options?: AddEventListenerOptions) => {
    if (watched(type)) live[type].add(listener);
    return add(type, listener, options);
  });
  t.mock.method(document, "removeEventListener", (type: string, listener: EventListener, options?: EventListenerOptions) => {
    if (watched(type)) live[type].delete(listener);
    return remove(type, listener, options);
  });
  return () => ({ pointerdown: live.pointerdown.size, keydown: live.keydown.size });
}
