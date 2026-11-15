import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type Attributes, type ComponentProps } from "react";
import { Popup, type PopupCloseReason } from "../app/components/popup";
import { mountDom } from "./dom-environment";

// Popup requires children; createElement receives them as arguments after the props.
type PopupProps = Attributes & ComponentProps<typeof Popup>;

async function mount(t: test.TestContext) {
  const { container, root } = mountDom(t);
  const requests: PopupCloseReason[] = [];
  const requestsFrom: Record<string, PopupCloseReason[]> = {};
  // The owner decides whether a close request closes a popup; here it never does,
  // so every trigger can be observed reaching the one close hook. Later titles open on top.
  const popup = (title: string) => createElement(Popup, { key: title, title, className: "manual-coverage-manager", onRequestClose(reason: PopupCloseReason) { requests.push(reason); (requestsFrom[title] ||= []).push(reason); } } as PopupProps,
    createElement("p", null, "Popup content"), createElement("button", null, `${title} action`));
  const render = (titles: string[] = ["Matching Episodes"]) => root.render(createElement("div", null, createElement("button", null, "Opener"), ...titles.map(popup)));
  await act(async () => render());
  const escape = () => act(async () => { (document.activeElement || document).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  const tab = (shiftKey = false) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })); });
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label)!;
  // Names the focused control (comparing DOM nodes directly makes assertion diffs huge).
  const focused = () => { const item = document.activeElement; return item?.getAttribute("aria-label") || item?.textContent; };
  return { container, requests, requestsFrom, render, escape, tab, button, focused };
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

  await act(async () => ui.button("Close Matching Episodes").click());
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => ui.container.querySelector<HTMLElement>(".modal-backdrop")!.click());
  assert.deepEqual(ui.requests, ["close", "escape", "outside"]);
  assert.ok(ui.container.querySelector('[role="dialog"]'), "the owner keeps the popup open until it accepts the close request");
});

test("Popup content scrolls inside it while the page behind it does not", async t => {
  const ui = await mount(t);
  await act(async () => ui.render([]));
  document.body.style.overflow = "auto";
  await act(async () => ui.render());
  assert.equal(document.body.style.overflow, "hidden");
  await act(async () => ui.render([]));
  assert.equal(document.body.style.overflow, "auto");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.deepEqual(ui.requests, [], "a closed popup no longer listens for Esc");
});

test("with popups stacked, one Esc asks only the topmost popup to close", async t => {
  const ui = await mount(t);
  await act(async () => ui.render(["Matching Episodes", "Confirm"]));
  await ui.escape();
  assert.deepEqual(ui.requestsFrom, { Confirm: ["escape"] });
  // Esc reaches the topmost popup even when focus has left every popup.
  await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
  await ui.escape();
  assert.deepEqual(ui.requestsFrom, { Confirm: ["escape", "escape"] });
  await act(async () => ui.render(["Matching Episodes"]));
  await ui.escape();
  assert.deepEqual(ui.requestsFrom, { Confirm: ["escape", "escape"], "Matching Episodes": ["escape"] });
});

test("the page behind stacked popups stays still until the last popup closes, then gets its scrolling back", async t => {
  const ui = await mount(t);
  await act(async () => ui.render([]));
  document.body.style.overflow = "auto";
  await act(async () => ui.render(["Matching Episodes"]));
  await act(async () => ui.render(["Matching Episodes", "Confirm"]));
  await act(async () => ui.render(["Confirm"]));
  assert.equal(document.body.style.overflow, "hidden", "closing the popup underneath keeps the page still under the other");
  await act(async () => ui.render([]));
  assert.equal(document.body.style.overflow, "auto");
});

test("Popup takes focus when it opens, keeps Tab inside it, and gives focus back when it closes", async t => {
  const ui = await mount(t);
  await act(async () => ui.render([]));
  ui.button("Opener").focus();
  await act(async () => ui.render(["Matching Episodes"]));
  assert.equal(ui.focused(), "Close Matching Episodes", "focus moves into the popup");
  await ui.tab(true);
  assert.equal(ui.focused(), "Matching Episodes action", "Shift+Tab from the first control wraps to the last");
  await ui.tab();
  assert.equal(ui.focused(), "Close Matching Episodes", "Tab from the last control wraps to the first");
  await act(async () => ui.render([]));
  assert.equal(ui.focused(), "Opener", "focus returns to where it was");
});

test("Popup keeps links and other native tab stops after its last button reachable before Tab wraps", async t => {
  const { container, root } = mountDom(t);
  await act(async () => root.render(createElement(Popup, { title: "Matching Episodes", className: "manual-coverage-manager", onRequestClose(reason: PopupCloseReason) { void reason; } } as PopupProps,
    createElement("button", null, "Delete"), createElement("a", { href: "https://thetvdb.com/series/x/episodes/1" }, "Open on TVDB"))));
  const tab = (from: HTMLElement) => { from.focus(); const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); act(() => { from.dispatchEvent(event); }); return event.defaultPrevented; };
  const remove = [...container.querySelectorAll("button")].find(item => item.textContent === "Delete")!;
  const link = container.querySelector("a")!;
  assert.equal(tab(remove), false, "Tab from Delete moves on to the link instead of wrapping");
  assert.equal(tab(link), true, "Tab from the last link wraps");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Close Matching Episodes");
});
