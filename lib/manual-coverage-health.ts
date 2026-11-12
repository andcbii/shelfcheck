import { setCoverageIssue, resolveCoverageIssue, providerLookupContext, type CoverageIssue } from "@/lib/coverage-issues";
import { authenticateTvdb } from "@/lib/tvdb-auth";
import "server-only";
import type { CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
import { listCoverageMappings, updateCoverageHealth } from "@/lib/manual-coverage";
import { PlexProviderClient, ProviderHttpError, ProviderResponseError } from "@/lib/plex-provider-client";

type Credentials = {tmdbToken:string;tvdbApiKey:string;tvdbPin?:string};

export async function recheckCoverageHealth(client: PlexProviderClient, config: Credentials) {
  let token: Promise<string> | undefined;
  const tvdbToken = () => token ||= authenticateTvdb(client, config.tvdbApiKey, config.tvdbPin);
  async function memberHealth(member: CoverageMember): Promise<NonNullable<CoverageMapping["health"]>> {
    if (member.provider === "TVDB") {
      // Only a missing native episode can require review; login/series failures remain pending.
      const authorization = await tvdbToken();
      const body = await client.json<{data?:{id?:number}}>(`https://api4.thetvdb.com/v4/episodes/${member.id}/extended`,{headers:{Authorization:`Bearer ${authorization}`}},"TVDB");
      if (body.data?.id !== member.id) throw new ProviderResponseError("TVDB",{provider:"TVDB",kind:"episode",id:member.id});
      return "healthy";
    }
    // TMDB coordinates locate a record, not a canonical ID. A missing/moved coordinate
    // cannot establish deletion, and a different returned ID must never retarget it.
    const record = await client.json<{id?:number}>(`https://api.themoviedb.org/3/tv/${member.showId}/season/${member.season}/episode/${member.episode}`,{headers:{Authorization:`Bearer ${config.tmdbToken}`}},"TMDB");
    if (record.id !== member.id) throw new ProviderResponseError("TMDB",{provider:"TMDB",kind:`show ${member.showId} season ${member.season} episode`,id:member.episode});
    return "healthy";
  }
  for (const mapping of listCoverageMappings()) {
    if (mapping.health === "needs-review") continue; // A reviewed edit is required to repair it.
    const states = await Promise.all(mapping.members.map(async member => {
      const id = `member-verification:${mapping.id}:${member.provider}:${member.id}`;
      let state: NonNullable<CoverageMapping["health"]>;
      let cause: string | undefined;
      let explanation: Pick<CoverageIssue,"category"|"lookup"|"cause"|"action"> | undefined;
      try {
        state = await memberHealth(member);
      } catch (error) {
        state = error instanceof ProviderHttpError && error.provider === "TVDB" && error.status === 404 && error.requested?.kind === "episode" ? "needs-review" : "pending";
        explanation = providerLookupContext(error,{source:[],requested:{provider:member.provider,kind:"episode",id:member.id},impact:"This Manual Match member’s episode identity and additional coverage could not be verified. The saved match was retained for review."});
        cause = explanation.cause;
        if (state === "needs-review") explanation.action = "Review the saved episode reference and edit this Manual Match to repair the missing member.";
      }
      if (cause) setCoverageIssue({id,operation:"member-verification",provider:member.provider,scope:"episode",mappingId:mapping.id,show:{title:member.show,...(member.provider === "TMDB" ? {tmdbId:member.showId} : {tvdbId:member.showId})},episode:{provider:member.provider,id:member.id,showId:member.showId,season:member.season,episode:member.episode,title:member.title},cause,action:state === "needs-review" ? "Edit and review this Manual Match to repair the missing member." : "Retry the Plex scan or review this Manual Match's episode context.",...explanation});
      else resolveCoverageIssue(id);
      return state;
    }));
    const health = states.includes("needs-review") ? "needs-review" : states.includes("pending") ? "pending" : "healthy";
    updateCoverageHealth(mapping,health,health === "needs-review" ? "A provider episode record was not found. Resolve and review replacements to repair this mapping." : health === "pending" ? "Provider identity could not be verified. Coverage is pending; retry the scan or review the episode context." : undefined);
  }
}
