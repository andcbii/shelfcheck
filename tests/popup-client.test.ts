import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Popup, type PopupCloseReason } from "../app/components/popup";

async function mount(t: test.TestContext) {
  const browser = new Window({ url: "http://localhost/plex" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, HTMLElement: browser.HTMLElement, KeyboardEvent: browser.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const requests: PopupCloseReason[] = [];
  t.after(async () => {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  });
  // The owner decides whether a close request closes the popup; here it never does,
  // so every trigger can be observed reaching the one close hook.
  const render = (open = true) => root.render(open ? createElement(Popup, { title: "Matching Episodes", className: "manual-coverage-manager", onRequestClose(reason: PopupCloseReason) { requests.push(reason); } }, createElement("p", null, "Popup content")) : null);
  await act(async () => render());
  return { container, browser, requests, render };
}

test("Popup asks its owner to close on Close, Esc and a click outside, through one close hook", async t => {
  const ui = await mount(t);
  const dialog = ui.container.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-label"), "Matching Episodes");
  assert.equal(dialog.querySelector("h2")?.textContent, "Matching Episodes");

  await act(async () => dialog.querySelector("p")!.click());
  await act(async () => dialog.click());
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.deepEqual(ui.requests, []);

  await act(async () => ui.container.querySelector<HTMLElement>('[aria-label="Close Matching Episodes"]')!.click());
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => ui.container.querySelector<HTMLElement>(".modal-backdrop")!.click());
  assert.deepEqual(ui.requests, ["close", "escape", "outside"]);
  assert.ok(ui.container.querySelector('[role="dialog"]'), "the owner keeps the popup open until it accepts the close request");
});

test("Popup content scrolls inside it while the page behind it does not", async t => {
  const ui = await mount(t);
  await act(async () => ui.render(false));
  document.body.style.overflow = "auto";
  await act(async () => ui.render(true));
  assert.equal(document.body.style.overflow, "hidden");
  await act(async () => ui.render(false));
  assert.equal(document.body.style.overflow, "auto");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.deepEqual(ui.requests, [], "a closed popup no longer listens for Esc");
});
