"use client";
import { useId } from "react";
import { INCOMPLETE_LABEL, memberKey, missingPartsExplanation, missingPartsOf, type CoverageMember } from "@/lib/manual-coverage-model";

export const episodeCode = (member: CoverageMember) => `S${String(member.season).padStart(2, "0")}E${String(member.episode).padStart(2, "0")}`;
export const episodeName = (member: CoverageMember) => `${member.provider} ${member.title}`;

// A combined episode is incomplete while any of its split episodes is reported missing.
// The status is derived from the given flags (saved, or the draft), never selected itself.
function derivedStatus(members: CoverageMember[], member: CoverageMember) {
  const current = members.find(item => memberKey(item) === memberKey(member));
  if (!current || current.reportMissing) return null;
  const parts = missingPartsOf(members, current);
  return parts.length ? <p className="report-missing-status report-missing-derived"><span>{INCOMPLETE_LABEL}</span> <small>{missingPartsExplanation(members, parts)}</small></p> : null;
}

// Report Missing checkboxes over a draft: the draft as it would be saved and its flagged keys.
export type ReportMissingDraft = {
  members: CoverageMember[];
  flags: string[];
  locked: boolean;
  onToggle: (member: CoverageMember, checked: boolean) => void;
};
type Props = { members: CoverageMember[]; scope: string; draft?: ReportMissingDraft };

// One presentation for saved Manual Match cards, the Matching Episodes popup and the editor form:
// a panel per provider, preserving each provider's identities, numbering and links.
export function ManualMatchPanels({ members, scope, draft }: Props) {
  const uid = useId();
  return <div className="manual-match-panels">{(["TMDB", "TVDB"] as const).map(provider => {
    const side = members.filter(member => member.provider === provider);
    return <section className="show-provider-matches" key={provider}><header><span className={`provider-badge ${provider.toLowerCase()}`}>{provider}</span><strong>{side.length} {side.length === 1 ? "episode" : "episodes"}</strong></header>
      {side.map(member => {
        const contextId = `${uid}-${scope}-${memberKey(member)}`;
        return <div className="provider-record manual-match-record" key={memberKey(member)}>
          <div id={contextId}><strong>{member.provider} / {member.show}</strong><p>{member.title} / {episodeCode(member)} / Episode ID {member.id}</p><p>Show ID {member.showId}</p></div>
          <a href={member.url} target="_blank" rel="noreferrer">{member.url}</a>
          {!draft && member.reportMissing && <p className="report-missing-status">Reported missing</p>}
          {!member.reportMissing && derivedStatus(draft ? draft.members : members, member)}
          {draft && <label className="report-missing-toggle"><input type="checkbox" aria-describedby={contextId} disabled={draft.locked} checked={draft.flags.includes(memberKey(member))} onChange={event => draft.onToggle(member, event.target.checked)}/>Report Missing</label>}
        </div>;
      })}
    </section>;
  })}</div>;
}
