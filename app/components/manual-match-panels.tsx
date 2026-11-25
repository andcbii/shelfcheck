"use client";
import { Fragment, useId } from "react";
import { INCOMPLETE_LABEL, memberKey, missingPartsExplanation, missingPartsOf, type CoverageMember } from "@/lib/manual-coverage-model";

const episodeCode = (member: CoverageMember) => `S${String(member.season).padStart(2, "0")}E${String(member.episode).padStart(2, "0")}`;
export const episodeName = (member: CoverageMember) => `${member.provider} ${member.title}`;

// A combined episode is incomplete while any of its split episodes is reported missing.
// The status is derived from the given flags (saved, or the draft), never selected itself.
function derivedStatus(members: CoverageMember[], member: CoverageMember) {
  const current = members.find(item => memberKey(item) === memberKey(member));
  if (!current || current.reportMissing) return null;
  const parts = missingPartsOf(members, current);
  return parts.length ? <><span className="manual-match-tag incomplete">{INCOMPLETE_LABEL}</span> <small>{missingPartsExplanation(members, parts)}</small></> : null;
}

// Report Missing checkboxes over a draft: the draft as it would be saved and its flagged keys.
export type ReportMissingDraft = {
  members: CoverageMember[];
  flags: string[];
  locked: boolean;
  onToggle: (member: CoverageMember, checked: boolean) => void;
};
// idPrefix keeps element ids unique between several panel sets on one page.
type Props = { members: CoverageMember[]; idPrefix: string; draft?: ReportMissingDraft };

const ExternalIcon = () => <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>;

// One presentation for saved Manual Match cards, the Matching Episodes popup and the editor form:
// a compact column per provider whose header names the show and episode count once, then one
// line per episode with its own numbering, ID and provider link, and a status line when it has one.
// A column holding episodes from several shows (ADR-0001 allows it) names each show above its own
// episodes instead, so same-numbered episodes still say which show owns them.
export function ManualMatchPanels({ members, idPrefix, draft }: Props) {
  const uid = useId();
  return <div className="manual-match-panels">{(["TMDB", "TVDB"] as const).map(provider => {
    const side = members.filter(member => member.provider === provider);
    const shows = side.filter((member, index) => side.findIndex(other => other.showId === member.showId) === index);
    const headerId = `${uid}-${idPrefix}-${provider}`;
    // The Show year is part of the show's name, in the same element and style; no known year, name only.
    const showName = (show: CoverageMember) => <><strong>{show.show}{Number.isInteger(show.showYear) && show.showYear! > 0 ? ` (${show.showYear})` : ""}</strong><span className="manual-match-show-id">Show {show.showId}</span></>;
    const line = (member: CoverageMember, describedBy: string) => {
      const contextId = `${uid}-${idPrefix}-${memberKey(member)}`;
      const reported = !draft && member.reportMissing ? <span className="manual-match-tag missing">Reported missing</span> : null;
      const derived = member.reportMissing ? null : derivedStatus(draft ? draft.members : members, member);
      return <Fragment key={memberKey(member)}>
        <div className="manual-match-episode-line" id={contextId}><span className="manual-match-episode-code">{episodeCode(member)}</span><span className="manual-match-episode-title">{member.title}</span><span className="manual-match-episode-id">#{member.id}</span><a href={member.url} target="_blank" rel="noreferrer" aria-label={`Open ${episodeCode(member)} ${member.title}${shows.length > 1 ? ` of ${member.show}` : ""} on ${provider}`}><ExternalIcon/></a></div>
        {(reported || derived || draft) && <div className="manual-match-episode-status">{reported}{derived}
          {draft && <label className="report-missing-toggle"><input type="checkbox" aria-describedby={`${describedBy} ${contextId}`} disabled={draft.locked} checked={draft.flags.includes(memberKey(member))} onChange={event => draft.onToggle(member, event.target.checked)}/>Report Missing</label>}
        </div>}
      </Fragment>;
    };
    const count = <span className="manual-match-count">{side.length} {side.length === 1 ? "episode" : "episodes"}</span>;
    if (shows.length <= 1) return <section className="show-provider-matches" key={provider}>
      <header id={headerId}><span className={`provider-badge ${provider.toLowerCase()}`}>{provider}</span>{shows[0] && showName(shows[0])}{count}</header>
      {side.map(member => line(member, headerId))}
    </section>;
    return <section className="show-provider-matches" key={provider}>
      <header id={headerId}><span className={`provider-badge ${provider.toLowerCase()}`}>{provider}</span>{count}</header>
      {shows.map(show => {
        const showId = `${headerId}-show-${show.showId}`;
        return <div className="manual-match-show-group" key={show.showId}>
          <div className="manual-match-show-heading" id={showId}>{showName(show)}</div>
          {side.filter(member => member.showId === show.showId).map(member => line(member, `${headerId} ${showId}`))}
        </div>;
      })}
    </section>;
  })}</div>;
}
