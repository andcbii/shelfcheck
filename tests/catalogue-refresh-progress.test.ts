import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CoverageIssueReport } from "../app/reports/components/coverage-issue-report";
import { catalogueRefreshProgress } from "../lib/catalogue-refresh-progress";
import type { CoverageIssue } from "../lib/coverage-issues";

const CHECKED = "2026-11-20T12:00:00.000Z";
const daysBefore = (days: number, ms = 0) => new Date(Date.parse(CHECKED) - days * 86400_000 - ms).toISOString();

test("a 404 still counting toward gone shows its progress and the catalogue's age", () => {
  assert.equal(catalogueRefreshProgress({ checkedAt: CHECKED, downloadedAt: daysBefore(74), seriesNotFoundDays: 7 }), "404 on 7 of 15 days · catalogue 74 days old");
});

test("a never-downloaded series shows its 404 days without a limit or age", () => {
  assert.equal(catalogueRefreshProgress({ checkedAt: CHECKED, seriesNotFoundDays: 3 }), "404 on 3 days · never downloaded");
  assert.equal(catalogueRefreshProgress({ checkedAt: CHECKED, seriesNotFoundDays: 1 }), "404 on 1 day · never downloaded");
});

test("any other failure shows the catalogue's age only, in whole days", () => {
  assert.equal(catalogueRefreshProgress({ checkedAt: CHECKED, downloadedAt: daysBefore(61, 3600_000) }), "Catalogue 61 days old");
  assert.equal(catalogueRefreshProgress({ checkedAt: CHECKED, downloadedAt: daysBefore(1) }), "Catalogue 1 day old");
  assert.equal(catalogueRefreshProgress({ checkedAt: CHECKED, downloadedAt: daysBefore(0, 60_000) }), "Catalogue 0 days old");
  assert.equal(catalogueRefreshProgress({ checkedAt: CHECKED }), "Never downloaded");
});

test("a catalogue-refresh entry in Scan Issues shows its catalogue age and 404 progress", async t => {
  const browser = new Window({ url: "http://localhost/reports/coverage-issues" });
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: browser, self: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) { old.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  const container = document.createElement("div");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, value] of old) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  const issue = (id: string, catalogueRefresh?: CoverageIssue["catalogueRefresh"]): CoverageIssue => ({ id, scope: "show", provider: "TMDB", operation: "catalogue-refresh", show: { title: `Show ${id}`, tmdbId: 323094 }, cause: "404 — record not found", action: "Check the reference.", ...(catalogueRefresh ? { catalogueRefresh } : {}) });
  await act(async () => root.render(createElement(CoverageIssueReport, { issues: [issue("a", { checkedAt: CHECKED, seriesNotFoundDays: 2 }), issue("b", { checkedAt: CHECKED, downloadedAt: daysBefore(74), seriesNotFoundDays: 7 }), issue("c")] })));
  const entries = [...container.querySelectorAll("article")].map(article => article.textContent!);
  assert.match(entries[0], /Catalogue: 404 on 2 days · never downloaded/);
  assert.match(entries[1], /Catalogue: 404 on 7 of 15 days · catalogue 74 days old/);
  assert.doesNotMatch(entries[2], /Catalogue:/, "an issue recorded before this state was kept shows no catalogue line");
});
