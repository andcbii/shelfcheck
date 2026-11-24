import { setCoverageIssue, resolveCoverageIssue, providerLookupContext, type CoverageIssue } from "@/lib/coverage-issues";
import type { TvdbSignIn } from "@/lib/tvdb-auth";
import { memberVerificationIssueId, TVDB_AUTHENTICATION_ISSUE, type CoverageIssueId } from "@/lib/coverage-issue-ids";
import "server-only";
import type { CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
import { listCoverageMappings, MISSING_MEMBER_MESSAGE, updateCoverageHealth, type CoverageHealthReceipt } from "@/lib/manual-coverage";
import { ProviderClient, ProviderHttpError, ProviderResponseError } from "@/lib/provider-client";

/**
 * Rechecks every Manual Match not already needing review with the scan's one TVDB sign-in; it
 * never signs in to TVDB itself. After a failed sign-in, of whatever kind, its TVDB members are
 * not requested: they wait, pending, under the TVDB sign-in issue the scan already recorded.
 * Returns a receipt for each health change it committed, in commit order.
 */
export async function recheckCoverageHealth(client: ProviderClient, {tmdbToken, tvdbSignIn}: {tmdbToken: string; tvdbSignIn: TvdbSignIn}) {
  async function memberHealth(member: CoverageMember): Promise<NonNullable<CoverageMapping["health"]>> {
    if (member.provider === "TVDB") {
      // Only a missing native episode can require review; sign-in and other failures remain pending.
      if (tvdbSignIn.outcome === "failed") throw tvdbSignIn.error;
      const body = await client.json<{data?:{id?:number}}>(`https://api4.thetvdb.com/v4/episodes/${member.id}/extended`,{headers:{Authorization:`Bearer ${tvdbSignIn.token}`}},"TVDB");
      if (body.data?.id !== member.id) throw new ProviderResponseError("TVDB",{provider:"TVDB",kind:"episode",id:member.id});
      return "healthy";
    }
    // TMDB coordinates locate a record, not a canonical ID. A missing/moved coordinate
    // cannot establish deletion, and a different returned ID must never retarget it.
    const record = await client.json<{id?:number}>(`https://api.themoviedb.org/3/tv/${member.showId}/season/${member.season}/episode/${member.episode}`,{headers:{Authorization:`Bearer ${tmdbToken}`}},"TMDB");
    if (record.id !== member.id) throw new ProviderResponseError("TMDB",{provider:"TMDB",kind:`show ${member.showId} season ${member.season} episode`,id:member.episode});
    return "healthy";
  }
  const receipts: CoverageHealthReceipt[] = [];
  for (const mapping of listCoverageMappings()) {
    if (mapping.health === "needs-review") continue; // A reviewed edit is required to repair it.
    const states = await Promise.all(mapping.members.map(async member => {
      const id = memberVerificationIssueId(mapping.id, member);
      let state: NonNullable<CoverageMapping["health"]>;
      let cause: string | undefined;
      let explanation: Pick<CoverageIssue,"category"|"lookup"|"cause"|"action"> | undefined;
      let causedBy: CoverageIssueId[] | undefined;
      try {
        state = await memberHealth(member);
      } catch (error) {
        state = error instanceof ProviderHttpError && error.provider === "TVDB" && error.status === 404 && error.requested?.kind === "episode" ? "needs-review" : "pending";
        explanation = providerLookupContext(error,{source:[],requested:{provider:member.provider,kind:"episode",id:member.id},impact:"This Manual Match member’s episode identity and additional coverage could not be verified. The saved match was retained for review."});
        cause = explanation.cause;
        // The scan's failed sign-in blocked this member; a failure after a good sign-in is the member's own.
        if (member.provider === "TVDB" && tvdbSignIn.outcome === "failed") causedBy = [TVDB_AUTHENTICATION_ISSUE];
        if (state === "needs-review") explanation.action = "Review the saved episode reference and edit this Manual Match to repair the missing member.";
      }
      if (cause) setCoverageIssue({id,operation:"member-verification",provider:member.provider,scope:"episode",mappingId:mapping.id,show:{title:member.show,...(member.provider === "TMDB" ? {tmdbId:member.showId} : {tvdbId:member.showId})},episode:{provider:member.provider,id:member.id,showId:member.showId,season:member.season,episode:member.episode,title:member.title},...(causedBy ? {causedBy} : {}),cause,action:state === "needs-review" ? "Edit and review this Manual Match to repair the missing member." : "Retry the Plex scan or review this Manual Match's episode context.",...explanation});
      else resolveCoverageIssue(id);
      return state;
    }));
    const health = states.includes("needs-review") ? "needs-review" : states.includes("pending") ? "pending" : "healthy";
    const receipt = updateCoverageHealth(mapping,health,health === "needs-review" ? MISSING_MEMBER_MESSAGE : health === "pending" ? "Provider identity could not be verified. Coverage is pending; retry the scan or review the episode context." : undefined);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}
