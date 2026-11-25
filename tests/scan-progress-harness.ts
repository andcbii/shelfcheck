import type { TestContext } from "node:test";
import { act, createElement, type FunctionComponent } from "react";
import PlexPage from "../app/plex/page";
import TraktPage from "../app/trakt/page";
import { mountDom } from "./dom-environment";
import { installWindowClock } from "./window-clock";
import type { ActiveScanRun } from "../lib/scan-run-activity";

// Mounts the real Trakt or Plex page with every server answer faked and a test
// clock (Date and the page's window timers) that moves only when a test moves
// it, one second at a time, for the scan progress box tests.

export type Status = Record<string, unknown>;
type Reply = Status | Error | Promise<Status>;

export const START = new Date("2026-11-24T12:00:00.000Z");
export const SHOWS = ["Severance", "The Bear", "Slow Horses", "Andor", "Shrinking", "Fallout", "Silo"];
export const running = (extra: Status = {}): Status => ({ status: "running", processed: 41, total: 312, rateLimitPaused: false, ...extra });
export const active = (...shows: [show: string, phase: string][]) => shows.map(([show, phase], index) => ({ key: String(index + 1), show, phase }));

type Server = {
  /** What GET /api/scan-runs answers: the Scan run that owns the lock, if any. */
  activity: ActiveScanRun | null;
  /** The page's own status answers, in order; the last one repeats. */
  statuses: Reply[];
  statusRequests: number;
  /** How many scans the page started. */
  starts: number;
  /** The Trakt status the page bootstraps from /api/state. */
  stateScan: Status;
  /** The saved Trakt report /api/state carries, and the saved Plex report every Plex status answer carries. */
  traktReport?: unknown;
  plexReport: unknown;
  /** The Plex artwork index the Trakt page reads for poster fallbacks. */
  artwork: unknown[];
};

export async function mountPage(t: TestContext, page: "trakt" | "plex", initial: Partial<Server> = {}) {
  const server: Server = { activity: null, statuses: [{ status: "completed", processed: 1, total: 1 }], statusRequests: 0, starts: 0, stateScan: { status: "idle", processed: 0, total: 0 }, plexReport: null, artwork: [], ...initial };
  const status = async () => {
    const reply = server.statuses[Math.min(server.statusRequests++, server.statuses.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const fetcher: typeof fetch = async (input, init) => {
    if (input === "/api/scan-runs") return Response.json({ activeScanRun: server.activity });
    if (init?.method === "POST") { server.starts += 1; return Response.json({}); }
    if (input === "/api/config") return Response.json({ connected: true, applicationConfigured: true });
    if (input === "/api/state") return Response.json({ state: { ignoredShows: [], ignoredSeasons: [], diagnosticsEnabled: true, airingGraceDays: 0, report: server.traktReport, scan: server.stateScan } });
    if (input === "/api/scan") return Response.json({ scan: await status() });
    if (input === "/api/plex/config") return Response.json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state") return Response.json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (input === "/api/plex/scan") return Response.json({ scan: await status(), report: server.plexReport, coverage: { revision: 0, pending: 0, issues: [] } });
    if (input === "/api/plex/artwork") return Response.json({ shows: server.artwork });
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const { browser, container, root } = mountDom(t, { fetch: fetcher });
  for (const [key, value] of Object.entries({ self: browser, navigator: browser.navigator, Element: browser.Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const clock = installWindowClock(t, browser, START);
  await act(async () => { root.render(createElement((page === "trakt" ? TraktPage : PlexPage) as FunctionComponent)); });
  await settle();
  const box = () => container.querySelector(".scan-progress");
  const lines = () => Array.from(container.querySelectorAll(".scan-progress-shows li")).map((line) => [line.querySelector(".scan-progress-show")?.textContent, line.querySelector(".scan-progress-step")?.textContent]);
  /** Moves the clock one second at a time, settling fetch and React work after each. */
  const advance = async (seconds = 1) => {
    for (let second = 0; second < seconds; second += 1) {
      await act(async () => { clock.advanceTo(new Date(Date.now() + 1000)); });
      await settle();
    }
  };
  /** Replaces the status answers and restarts their count, so the next poll gets the first. */
  const nextStatuses = (...statuses: Reply[]) => { server.statuses = statuses; server.statusRequests = 0; };
  const unmount = async () => { await act(async () => { root.unmount(); }); };
  return { server, container, clock, box, lines, advance, nextStatuses, unmount };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
}

export function pending() {
  let resolve!: (status: Status) => void;
  const promise = new Promise<Status>((done) => { resolve = done; });
  return { promise, resolve };
}
export const paused = (provider: string | undefined, resumeAt: string | undefined, extra: Status = {}) => running({ rateLimitPaused: true, rateLimitProvider: provider, rateLimitResumeAt: resumeAt, activeShows: active(["Severance", "starting"], ["Bluey", "starting"]), ...extra });

/** Mounts a page whose first status is `first` and whose next poll stays pending until released. */
export async function mountPaused(t: TestContext, page: "trakt" | "plex", first: Status) {
  const nextPoll = pending();
  const mounted = await mountPage(t, page, page === "trakt" ? { stateScan: first, statuses: [nextPoll.promise] } : { statuses: [first, nextPoll.promise] });
  const notice = () => mounted.box()?.querySelector(".scan-progress-pause");
  const notes = () => notice()?.querySelector(".scan-progress-pause-text")?.textContent ?? null;
  const countdown = () => notice()?.querySelector(".scan-progress-countdown")?.textContent ?? null;
  const heading = () => mounted.box()?.querySelector(".scan-progress-head strong")?.textContent;
  const radar = () => mounted.container.querySelector(".radar small")?.textContent;
  const button = () => mounted.container.querySelector("button.primary")?.textContent || "";
  return { ...mounted, nextPoll, notice, notes, countdown, heading, radar, button };
}

