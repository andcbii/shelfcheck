"use client";

import { useCallback, useEffect, useRef } from "react";

type ScanPollerOptions<TBody> = {
  url: string;
  intervalMs?: number;
  onPollingChange: (polling: boolean) => void;
  onResponse: (body: TBody) => boolean | Promise<boolean>;
};

export function useScanPoller<TBody>(options: ScanPollerOptions<TBody>) {
  const optionsRef = useRef(options);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  useEffect(() => { optionsRef.current = options; }, [options]);

  const abort = useCallback(() => controllerRef.current?.abort(), []);
  const poll = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    const generation = ++generationRef.current;
    controllerRef.current = controller;
    optionsRef.current.onPollingChange(true);
    try {
      while (!controller.signal.aborted) {
        const response = await fetch(optionsRef.current.url, { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => ({})) as TBody & { error?: string };
        if (!response.ok) throw new Error(body.error || "Scan status could not be loaded.");
        if (await optionsRef.current.onResponse(body)) return;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
          const timer = window.setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, optionsRef.current.intervalMs ?? 1000);
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    } finally {
      if (generationRef.current === generation && controllerRef.current === controller) {
        controllerRef.current = null;
        optionsRef.current.onPollingChange(false);
      }
    }
  }, []);

  useEffect(() => abort, [abort]);
  return { poll, abort };
}
