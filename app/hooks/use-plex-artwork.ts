"use client";

import { useEffect, useMemo, useState } from "react";
import { plexArtworkMatcher } from "@/lib/plex-artwork";

/**
 * Fetches the last saved Plex report's artwork index once, and returns the
 * matcher from a Trakt show's IDs to its Plex thumbnail path. Until the index
 * arrives, or when it cannot be read, nothing matches.
 */
export function usePlexArtwork() {
  const [index, setIndex] = useState<unknown[]>([]);
  useEffect(() => {
    let current = true;
    void fetch("/api/plex/artwork", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { shows?: unknown } : null)
      .then((body) => { if (current && Array.isArray(body?.shows)) setIndex(body.shows); })
      .catch(() => { /* the Plex artwork fallback is optional */ });
    return () => { current = false; };
  }, []);
  return useMemo(() => plexArtworkMatcher(index), [index]);
}
