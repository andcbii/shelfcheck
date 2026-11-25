"use client";

/* Posters intentionally use native images through the app-owned proxies. */
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";

type TraktPosterProps = {
  title: string;
  /** The Trakt poster link saved in the report, if any. */
  traktPoster?: string;
  /** The thumbnail path of the matched Plex show, if any. */
  plexThumb?: string | null;
};

/**
 * A Trakt show's poster box: the Trakt poster first, then the matched Plex
 * artwork when there is no Trakt link or it fails to load, then the show's
 * initials. Each image source is tried once; a changed source is tried afresh.
 */
export function TraktPoster({ title, traktPoster, plexThumb }: TraktPosterProps) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const sources = [
    traktPoster ? `/api/poster?src=${encodeURIComponent(traktPoster)}` : null,
    plexThumb ? `/api/plex/poster?thumb=${encodeURIComponent(plexThumb)}` : null,
  ];
  const source = sources.find((candidate): candidate is string => candidate !== null && !failed.has(candidate));
  return <div className="show-index">
    <span>{title.slice(0, 2).toUpperCase()}</span>
    {source && <img
      key={source}
      src={source}
      alt={`${title} poster`}
      loading="lazy"
      onError={() => setFailed((current) => new Set(current).add(source))}
    />}
  </div>;
}
