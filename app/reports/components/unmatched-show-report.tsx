"use client";

import { useState } from "react";
import { OTHER_PROVIDER, PROVIDER_NAME, PROVIDERS, type CatalogueProvider } from "@/lib/catalogue-selection";
import type { ProviderLookupStatus } from "@/lib/comparison-catalogue-resolver";
import type { PlexShowResult } from "@/lib/plex-scan";
import { ReportPagination } from "@/app/reports/report-pagination";

/** Why a provider has no usable catalogue for an Unmatched show. */
function providerCause(provider: CatalogueProvider, status: ProviderLookupStatus) {
  const name = PROVIDER_NAME[provider];
  if (status.state === "total-failure") return status.catalogue === "gone" ? `Gone provider record: ${status.cause}; its saved catalogue is kept but no longer compared` : status.cause;
  if (status.state === "not-looked-up") return status.cause ?? `No ${name} series ID from Plex or ${PROVIDER_NAME[OTHER_PROVIDER[provider]]}`;
  return status.state === "pending" ? `${name} series not resolved yet` : `${name} catalogue in use`;
}

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
          {PROVIDERS.map(provider => {
            const status = show.providerResolution?.providers?.[provider];
            return status ? <div key={provider}><dt>{PROVIDER_NAME[provider]} lookup</dt><dd>{providerCause(provider, status)}</dd></div> : null;
          })}
        </dl>
      </article>)}
    </div> : <div className="empty auto-match-empty"><div>✓</div><h3>No unmatched shows recorded</h3><p>{shows.length ? "There are no records on this page." : "Run a new Plex search to populate show-level resolution reporting."}</p></div>}
    <ReportPagination total={shows.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={choosePageSize} />
  </>;
}
