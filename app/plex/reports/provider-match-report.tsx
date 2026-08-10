"use client";

import { useState } from "react";
import type { PlexProviderShowMatch, PlexShowResult } from "@/lib/plex-scan";

function ProviderList({ provider, matches }: { provider: "TMDB" | "TVDB"; matches: PlexProviderShowMatch[] }) {
  return <section className="show-provider-matches"><header><span className={`provider-badge ${provider.toLowerCase()}`}>{provider}</span><strong>{matches.length} {matches.length === 1 ? "match" : "matches"}</strong></header><div>{matches.map((match) => {
    const href = provider === "TMDB" ? `https://www.themoviedb.org/tv/${match.id}` : match.slug ? `https://thetvdb.com/series/${encodeURIComponent(match.slug)}` : `https://thetvdb.com/dereferrer/series/${match.id}`;
    return <a href={href} target="_blank" rel="noreferrer" key={`${provider}-${match.id}`}><div><strong>{match.name || `${provider} series ${match.id}`}</strong>{match.year ? <small>{match.year}</small> : null}</div><code>{match.id}</code><span>↗</span></a>;
  })}</div></section>;
}

export function ProviderMatchReport({ shows }: { shows: PlexShowResult[] }) {
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(shows.length / pageSize));
  const visible = shows.slice((page - 1) * pageSize, page * pageSize);
  function choosePageSize(value: number) { setPageSize(value); setPage(1); }

  return <>
    {visible.length ? <div className="provider-match-list">{visible.map((show) => <article className="provider-match-row" key={show.ratingKey}>
      <header><div><span>Plex show</span><h2>{show.title}{show.year ? <small>{show.year}</small> : null}</h2></div><div className="plex-guid-list">{(show.plexGuids?.length ? show.plexGuids : show.plexGuid ? [show.plexGuid] : []).map((guid) => <code key={guid}>{guid}</code>)}</div></header>
      <div className="provider-match-columns"><ProviderList provider="TMDB" matches={show.providerMatches?.tmdb || []} /><ProviderList provider="TVDB" matches={show.providerMatches?.tvdb || []} /></div>
    </article>)}</div> : <div className="empty auto-match-empty"><div>✓</div><h3>No multiple provider matches</h3><p>Run a new Plex scan to find Plex shows associated with multiple TMDB or TVDB records.</p></div>}
    {shows.length > 0 && <div className="report-pagination"><p>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, shows.length)} of {shows.length}</p><label>Results per page<select value={pageSize} onChange={(event) => choosePageSize(Number(event.target.value))}>{[10, 25, 50, 100].map((size) => <option value={size} key={size}>{size}</option>)}</select></label><div><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>← Previous</button><span>{page} / {totalPages}</span><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages}>Next →</button></div></div>}
  </>;
}
