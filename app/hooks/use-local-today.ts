"use client";

import { useEffect, useState } from "react";
import { localCalendarDate, nextLocalMidnight, type CalendarDate } from "@/lib/results-view";

/**
 * Today as the browser's local calendar date. It updates at each local midnight,
 * and on window focus or when the page becomes visible again, since timers can
 * miss midnight while the computer sleeps. Separate from the Ignore expiry clock.
 */
export function useLocalToday(): CalendarDate {
  const [today, setToday] = useState(() => localCalendarDate(new Date()));

  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      const now = new Date();
      setToday(localCalendarDate(now));
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(refresh, Math.max(0, nextLocalMidnight(now).getTime() - now.getTime()));
    };
    const onVisibilityChange = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return today;
}
