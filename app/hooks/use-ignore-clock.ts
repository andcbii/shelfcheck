"use client";

import { useEffect, useState } from "react";
import type { IgnoreTiming } from "@/lib/ignored-shows";

const MAX_TIMEOUT_MS = 2_147_483_647;

export function useIgnoreClock(rules: readonly IgnoreTiming[]): number {
  const [now, setNow] = useState(Date.now);
  let nextExpiry: number | undefined;
  for (const rule of rules) {
    if (!rule.expiresAt) continue;
    const expiry = Date.parse(rule.expiresAt);
    if (expiry > now && (nextExpiry === undefined || expiry < nextExpiry)) nextExpiry = expiry;
  }

  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const onVisibilityChange = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = nextExpiry === undefined ? undefined : window.setTimeout(refresh, Math.min(MAX_TIMEOUT_MS, Math.max(0, nextExpiry - Date.now())));
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [nextExpiry, now]);

  return now;
}
