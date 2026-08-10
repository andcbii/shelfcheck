"use client";

import { useState } from "react";
import type { PlexShowResult } from "@/lib/plex-scan";

export function UnmatchedShowReport({ shows }: { shows: PlexShowResult[] }) {
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(shows.length / pageSize));
  const visible = shows.slice((page - 1) * pageSize, page * pageSize);
  function choosePageSize(value: number) { setPageSize(value); setPage(1); }

  return <>
    {visible.length ? <div className="unmatched-show-list">
      {visible.map((show) => <article className="unmatched-show-row" key={show.ratingKey}>
        <div><span>Plex show</span><h3>{show.title}{show.year ? <small>{show.year}</small> : null}</h3><p>{show.warning || "No TMDB or TVDB show match was resolved."}</p></div>
        <dl>
          <div><dt>Plex episodes</dt><dd>{show.plexEpisodes}</dd></div>
          <div><dt>Plex rating key</dt><dd>{show.ratingKey}</dd></div>
          <div><dt>TMDB ID from Plex</dt><dd>{show.tmdbId || "None"}</dd></div>
          <div><dt>TVDB ID from Plex</dt><dd>{show.tvdbId || "None"}</dd></div>
        </dl>
      </article>)}
    </div> : <div className="empty auto-match-empty"><div>✓</div><h3>No unmatched shows recorded</h3><p>{shows.length ? "There are no records on this page." : "Run a new Plex search to populate show-level resolution reporting."}</p></div>}
    {shows.length > 0 && <div className="report-pagination"><p>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, shows.length)} of {shows.length}</p><label>Results per page<select value={pageSize} onChange={(event) => choosePageSize(Number(event.target.value))}>{[10, 25, 50, 100].map((size) => <option value={size} key={size}>{size}</option>)}</select></label><div><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>← Previous</button><span>{page} / {totalPages}</span><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages}>Next →</button></div></div>}
  </>;
}
