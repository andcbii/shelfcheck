import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ManualCoverageManager } from "../app/components/manual-coverage-manager";

test("Matching Episodes closes on Esc without saving and holds the page behind it still", async t => {
  const browser = new Window({ url: "http://localhost/plex" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const posts: unknown[] = [];
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, HTMLElement: browser.HTMLElement, KeyboardEvent: browser.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true, fetch: async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: "completed" } });
    if (init?.method) posts.push(init.body);
    return Response.json({ mappings: [], revision: 0, pending: 0 });
  } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let dismissed = 0;
  t.after(async () => {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(async () => root.render(createElement(ManualCoverageManager, { initialUrls: ["tvdb:999"], onClose() { dismissed++; root.render(null); }, onChanged() {} })));
  assert.equal(document.body.style.overflow, "hidden");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(dismissed, 1);
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(document.body.style.overflow, "");
  assert.deepEqual(posts, []);
});
