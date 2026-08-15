"use client";

/* Provider artwork is displayed as linked logos. */
/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from "react";
import type { PlexAutoMatch, PlexAutoMatchEpisode, PlexAutoMatchMethod } from "@/lib/plex-scan";
import { ReportPagination } from "@/app/reports/report-pagination";

const MATCH_TYPES: { value: "all" | PlexAutoMatchMethod; label: string }[] = [
  { value: "all", label: "All" },
  { value: "Matched via IMDb", label: "IMDb" },
  { value: "Matched via Trakt", label: "Trakt" },
  { value: "Matched via TMDB External ID", label: "TMDB External ID" },
  { value: "Shelfcheck Compound Match", label: "Compound" },
];

function episodeCode(episode: PlexAutoMatchEpisode) {
  return `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`;
}

function ProviderRecord({ provider, episode }: { provider: "TMDB" | "TVDB"; episode: PlexAutoMatchEpisode }) {
  const href = episode.url;
  const logo = provider === "TMDB" ? "/tmdb-blue-square.svg" : "/tvdb-square.svg";
  return <div className="provider-record">
    <div>{href ? <a className="report-provider-link" href={href} target="_blank" rel="noreferrer" title={`View episode on ${provider}`} aria-label={`View episode on ${provider}`}><img src={logo} alt="" /></a> : <span className="report-provider-link unavailable"><img src={logo} alt="" /></span>}<code>{episodeCode(episode)}</code></div>
    <strong>{episode.show}</strong>
    <p>{episode.name || "Untitled episode"}</p>
    <dl>
      <div><dt>Season</dt><dd>{episode.season}</dd></div>
      <div><dt>Episode</dt><dd>{episode.episode}</dd></div>
      <div><dt>Aired</dt><dd>{episode.airDate || "Not available"}</dd></div>
      <div><dt>ID</dt><dd>{episode.id || "—"}</dd></div>
    </dl>
  </div>;
}

export function AutoMatchReport({ matches }: { matches: PlexAutoMatch[] }) {
  const [filter, setFilter] = useState<"all" | PlexAutoMatchMethod>("all");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => filter === "all" ? matches : matches.filter((match) => match.method === filter), [filter, matches]);
  const counts = useMemo(() => new Map(MATCH_TYPES.map(({ value }) => [value, value === "all" ? matches.length : matches.filter((match) => match.method === value).length])), [matches]);
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  function chooseFilter(value: "all" | PlexAutoMatchMethod) { setFilter(value); setPage(1); }
  function choosePageSize(value: number) { setPageSize(value); setPage(1); }

  return <>
    <div className="match-filter" role="group" aria-label="Filter by match type">
      <span>Match type</span>
      <div>{MATCH_TYPES.map((type) => <button type="button" className={filter === type.value ? "active" : ""} aria-pressed={filter === type.value} onClick={() => chooseFilter(type.value)} key={type.value}>{type.label}<small>{counts.get(type.value)}</small></button>)}</div>
    </div>
    {visible.length ? <div className="auto-match-list">
      {visible.map((match, index) => <article className="auto-match-row" key={`${match.tvdb.id}-${match.tmdb.id}-${index}`}>
        <div className="match-method"><span>Match method</span><strong>{match.method}</strong></div>
        <ProviderRecord provider="TMDB" episode={match.tmdb} />
        <div className="match-bridge" aria-hidden="true">↔</div>
        <ProviderRecord provider="TVDB" episode={match.tvdb} />
      </article>)}
    </div> : <div className="empty auto-match-empty"><div>↔</div><h3>{matches.length ? "No matches of this type" : "No auto matches recorded"}</h3><p>{matches.length ? "Choose another match type to see its records." : "Run a new Plex search to populate this report with episode reconciliation details."}</p></div>}
    <ReportPagination total={filtered.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={choosePageSize} />
  </>;
}
