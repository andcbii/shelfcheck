import type test from "node:test";
import type { Window } from "happy-dom";

type PendingTimer = { id: number; at: number; callback: () => void };

/**
 * A test clock for a mounted page: it fakes Date and replaces the timers on the
 * happy-dom window itself (the ones the page schedules with window.setTimeout),
 * because happy-dom keeps its own reference to Node's timers and Node's timer
 * mocks do not reach it. Time moves only when the test moves it.
 */
export function installWindowClock(t: test.TestContext, browser: Window, start: Date) {
  t.mock.timers.enable({ apis: ["Date"], now: start.getTime() });
  let nextId = 1;
  const timers = new Map<number, PendingTimer>();
  const setTimeoutFake = (callback: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { id, at: Date.now() + Math.max(0, Number(delay) || 0), callback });
    return id;
  };
  const clearTimeoutFake = (id: number | undefined) => { if (id !== undefined) timers.delete(id); };
  Object.defineProperty(browser, "setTimeout", { configurable: true, writable: true, value: setTimeoutFake });
  Object.defineProperty(browser, "clearTimeout", { configurable: true, writable: true, value: clearTimeoutFake });
  return {
    /** Due times of the timers still waiting, earliest first. */
    pending: () => Array.from(timers.values()).map((timer) => timer.at).sort((a, b) => a - b),
    /** Moves the clock to the moment, running each timer due by then in order. */
    advanceTo(moment: Date) {
      const target = moment.getTime();
      for (;;) {
        const due = Array.from(timers.values()).filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        t.mock.timers.setTime(Math.max(Date.now(), due.at));
        due.callback();
      }
      t.mock.timers.setTime(target);
    },
    /** Moves the clock without running any timer, as while the computer sleeps. */
    sleepUntil(moment: Date) { t.mock.timers.setTime(moment.getTime()); },
  };
}

/** Counts the listeners added and not yet removed for one event type on a target. */
export function countListeners(page: object, type: string) {
  const target = page as EventTarget;
  const live = new Set<unknown>();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  Object.defineProperty(target, "addEventListener", { configurable: true, writable: true, value: (eventType: string, listener: unknown, options?: unknown) => {
    if (eventType === type) live.add(listener);
    add(eventType, listener as EventListener, options as AddEventListenerOptions);
  } });
  Object.defineProperty(target, "removeEventListener", { configurable: true, writable: true, value: (eventType: string, listener: unknown, options?: unknown) => {
    if (eventType === type) live.delete(listener);
    remove(eventType, listener as EventListener, options as EventListenerOptions);
  } });
  return () => live.size;
}
