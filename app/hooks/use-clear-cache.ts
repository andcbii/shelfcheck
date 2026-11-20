"use client";

import { useState } from "react";

/**
 * What one page supplies to the shared Clear cache actions. The two modes differ
 * on purpose in what a successful clear does to the page: Plex's whole clear
 * removes its report, Trakt's keeps its results and empties its cache keys.
 */
export type ClearCacheMode<Show> = {
  /** The whole-cache address, sent a DELETE. */
  cacheAddress: string;
  /** One show's address, carrying its identity, sent a DELETE. */
  showAddress: (show: Show) => string;
  showTitle: (show: Show) => string;
  /** Names the cache in the whole-clear wording, such as "Plex"; omitted for none. */
  cacheName?: string;
  onCacheCleared: () => void;
  onShowCleared: (show: Show) => void;
  closeShowMenu: () => void;
  onError: (message: string) => void;
};

async function sendClear(address: string, fallback: string): Promise<number> {
  const response = await fetch(address, { method: "DELETE" });
  const body = await response.json().catch(() => ({})) as { cleared?: number; error?: string };
  if (!response.ok) throw new Error(body.error || fallback);
  return body.cleared || 0;
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** The whole-cache and single-show Clear cache actions shared by the Trakt and Plex pages. */
export function useClearCache<Show>(mode: ClearCacheMode<Show>) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  const name = mode.cacheName ? `${mode.cacheName} ` : "";

  async function clearCache() {
    const fallback = `Shelfcheck could not clear the ${name}scan cache.`;
    setClearing(true);
    setMessage("");
    try {
      const cleared = await sendClear(mode.cacheAddress, fallback);
      mode.onCacheCleared();
      setConfirmOpen(false);
      setMessage(`${cleared} cached ${name}show results cleared. The next scan will rebuild them.`);
    } catch (clearError) { mode.onError(errorMessage(clearError, fallback)); }
    finally { setClearing(false); }
  }

  async function clearShowCache(show: Show) {
    const title = mode.showTitle(show);
    const fallback = `Shelfcheck could not clear ${title}'s cache.`;
    mode.closeShowMenu();
    setMessage("");
    try {
      const cleared = await sendClear(mode.showAddress(show), fallback);
      mode.onShowCleared(show);
      setMessage(cleared ? `${title} will be rebuilt during the next scan.` : `${title} was not cached.`);
    } catch (clearError) { mode.onError(errorMessage(clearError, fallback)); }
  }

  return {
    confirmOpen,
    clearing,
    message,
    clearMessage: () => setMessage(""),
    openConfirm: () => { setMessage(""); setConfirmOpen(true); },
    cancelConfirm: () => setConfirmOpen(false),
    clearCache,
    clearShowCache,
  };
}
