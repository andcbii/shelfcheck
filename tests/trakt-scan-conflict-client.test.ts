import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import TraktPage from "../app/trakt/page";
import { mountDom } from "./dom-environment";

const message = "A Plex scan is running. You can start a Trakt scan when it finishes.";

test("the Trakt page shows the server's message when a start is refused", async (t) => {
  const starts: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (input === "/api/scan-runs") return Response.json({ activeScanRun: null });
    if (input === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (input === "/api/state") return Response.json({ state: { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0 } });
    if (input === "/api/scan" && init?.method === "POST") {
      starts.push(JSON.parse(String(init.body)));
      return Response.json({ error: message, activeScanRun: { kind: "plex", startedAt: "2026-11-18T12:00:00.000Z", status: { status: "running", processed: 3, total: 9 } } }, { status: 409 });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  await act(async () => { root.render(createElement(TraktPage)); });
  const quickScan = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Quick scan"));
  assert.ok(quickScan, "Quick scan is offered");
  await act(async () => { quickScan.click(); });
  assert.equal(starts.length, 1);
  assert.ok(container.querySelector(".error")?.textContent?.includes(message), container.querySelector(".error")?.textContent || "no error shown");
});
