"use client";

import { useState } from "react";
import type { PlexShowResult } from "@/lib/plex-scan";
import { ReportPagination } from "@/app/reports/report-pagination";

export function UnmatchedShowReport({ shows }: { shows: PlexShowResult[] }) {
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const visible = shows.slice((page - 1) * pageSize, page * pageSize);
  function choosePageSize(value: number) { setPageSize(value); setPage(1); }

  return <>
    {visible.length ? <div className="unmatched-show-list">
      {visible.map((show) => <article className="unmatched-show-row" key={show.ratingKey}>
        <div><span>Plex show</span><h3>{show.title}{show.year ? <small>{show.year}</small> : null}</h3><p>{show.warning || "No TMDB or TVDB show match was resolved."}</p></div>
        <dl>
          <div><dt>Plex episodes</dt><dd>{show.plexEpisodes}</dd></div>
          <div><dt>Plex rating keys</dt><dd>{show.plexRatingKeys?.join(", ") || show.ratingKey}</dd></div>
          <div><dt>TMDB ID from Plex</dt><dd>{show.tmdbId || "None"}</dd></div>
          <div><dt>TVDB ID from Plex</dt><dd>{show.tvdbId || "None"}</dd></div>
        </dl>
      </article>)}
    </div> : <div className="empty auto-match-empty"><div>✓</div><h3>No unmatched shows recorded</h3><p>{shows.length ? "There are no records on this page." : "Run a new Plex search to populate show-level resolution reporting."}</p></div>}
    <ReportPagination total={shows.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={choosePageSize} />
  </>;
}
