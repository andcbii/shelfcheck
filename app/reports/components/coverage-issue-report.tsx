"use client";

import Link from "next/link";
import type { CoverageIssue } from "@/lib/coverage-issues";

export function CoverageWarning({ issues }: { issues: CoverageIssue[] }) {
  return issues.length ? <p role="status" className="plex-warning">Some scan checks need attention. Review <Link href="/reports/coverage-issues">Scan Issues ({issues.length})</Link> for affected shows, failed lookups, and next steps.</p> : null;
}

function Issue({ issue }: { issue: CoverageIssue }) {
  const {show,episode}=issue;
  const episodeNumber = episode?.season !== undefined && episode?.episode !== undefined ? `S${String(episode.season).padStart(2,"0")}E${String(episode.episode).padStart(2,"0")}` : undefined;
  return <article className="coverage-issue">
    <h3>{show?.title || (issue.scope === "library" ? "Library-wide issue" : "Unassigned issue")}</h3>
    {show && <p className="coverage-issue-identities">{[show.ratingKey && `Plex ${show.ratingKey}`,show.tmdbId !== undefined && `TMDB ${show.tmdbId}`,show.tvdbId !== undefined && `TVDB ${show.tvdbId}`].filter(Boolean).join(" · ")}</p>}
    {episode && <p>{[episode.provider,episode.id !== undefined && String(episode.id),episode.showId !== undefined && `show ${episode.showId}`,episodeNumber,episode.title].filter(Boolean).join(" ")}</p>}
    <p className="coverage-issue-operation">{issue.provider && <strong>{issue.provider} · </strong>}{issue.category || issue.operation.replaceAll("-"," ")}</p>
    <p><strong>ID source: </strong>{issue.lookup?.source.length ? issue.lookup.source.map(step=>`${step.kind.startsWith(step.provider) ? "" : `${step.provider} `}${step.kind}${step.id !== undefined ? ` ${step.id}` : ""}${step.cached ? " (cached)" : ""}`).join(" → ") : "Source unknown"}</p>
    {issue.lookup?.requested && <p><strong>Failed lookup: </strong>{issue.lookup.requested.provider} {issue.lookup.requested.kind}{issue.lookup.requested.id !== undefined ? ` ${issue.lookup.requested.id}` : ""}</p>}
    <p>{issue.category === "Provider Lookup" && <strong>Response: </strong>}{issue.cause}</p>
    {issue.lookup && <p><strong>Impact: </strong>{issue.lookup.impact}</p>}
    {issue.impacts?.map(impact=><p key={impact}><strong>Impact: </strong>{impact}</p>)}
    <p className="coverage-issue-action"><strong>Next step: </strong>{issue.action}</p>
  </article>;
}

export function CoverageIssueReport({ issues }: { issues: CoverageIssue[] }) {
  const assigned = issues.filter(issue=>issue.scope !== "library" && (issue.show || issue.episode));
  const unassigned = issues.filter(issue=>!assigned.includes(issue));
  return <div className="coverage-issues-report"><p className="coverage-issues-count">{issues.length} current {issues.length === 1 ? "issue" : "issues"}</p>
    {!issues.length && <div className="report-empty"><h2>No current Scan Issues</h2><p>The shared coverage state has no unresolved causes.</p></div>}
    {!!assigned.length && <section aria-label="Show and episode issues"><h2>Show and episode issues</h2>{assigned.map(issue=><Issue key={issue.id} issue={issue}/>)}</section>}
    {!!unassigned.length && <section aria-label="Library-wide and unassigned issues"><h2>Library-wide and unassigned issues</h2>{unassigned.map(issue=><Issue key={issue.id} issue={issue}/>)}</section>}
  </div>;
}
