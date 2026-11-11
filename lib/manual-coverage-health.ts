import { setCoverageIssue, resolveCoverageIssue, coverageIssueCause } from "@/lib/coverage-issues";
import { authenticateTvdb } from "@/lib/tvdb-auth";
import "server-only";
import type { CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
import { listCoverageMappings, updateCoverageHealth } from "@/lib/manual-coverage";
import { PlexProviderClient, ProviderHttpError } from "@/lib/plex-provider-client";

type Credentials = {tmdbToken:string;tvdbApiKey:string;tvdbPin?:string};

export async function recheckCoverageHealth(client: PlexProviderClient, config: Credentials) {
  let token: Promise<string> | undefined;
  const tvdbToken = () => token ||= authenticateTvdb(client, config.tvdbApiKey, config.tvdbPin);
  async function memberHealth(member: CoverageMember): Promise<NonNullable<CoverageMapping["health"]>> {
    if (member.provider === "TVDB") {
      // Only the native episode endpoint can confirm deletion. Login/series 404s cannot.
      const authorization = await tvdbToken();
      try {
        const body = await client.json<{data?:{id?:number}}>(`https://api4.thetvdb.com/v4/episodes/${member.id}/extended`,{headers:{Authorization:`Bearer ${authorization}`}},"TVDB");
        if (body.data?.id !== member.id) throw new Error(`TVDB returned episode ${body.data?.id ?? "without an identity"} while verifying saved episode ${member.id}.`);
        return "healthy";
      } catch(error) {
        if (error instanceof ProviderHttpError && error.provider === "TVDB" && error.status === 404) return "needs-review";
        throw error;
      }
    }
    // TMDB coordinates locate a record, not a canonical ID. A missing/moved coordinate
    // cannot establish deletion, and a different returned ID must never retarget it.
    const record = await client.json<{id?:number}>(`https://api.themoviedb.org/3/tv/${member.showId}/season/${member.season}/episode/${member.episode}`,{headers:{Authorization:`Bearer ${config.tmdbToken}`}},"TMDB");
    if (record.id !== member.id) throw new Error(`TMDB returned episode ${record.id ?? "without an identity"} at S${member.season}E${member.episode} while verifying saved episode ${member.id}; the saved identity was not changed.`);
    return "healthy";
  }
  for (const mapping of listCoverageMappings()) {
    if (mapping.health === "needs-review") continue; // A reviewed edit is required to repair it.
    const states = await Promise.all(mapping.members.map(async member => {
      const id = `member-verification:${mapping.id}:${member.provider}:${member.id}`;
      let state: NonNullable<CoverageMapping["health"]>;
      let cause: string | undefined;
      try {
        state = await memberHealth(member);
        if (state === "pending") cause = "The provider returned a different or incomplete episode identity for this member. Review the episode context or retry verification.";
        if (state === "needs-review") cause = "The native TVDB episode endpoint confirmed that this episode no longer exists (404).";
      } catch (error) { state = "pending"; cause = coverageIssueCause(error); }
      if (cause) setCoverageIssue({id,operation:"member-verification",provider:member.provider,scope:"episode",mappingId:mapping.id,show:{title:member.show,...(member.provider === "TMDB" ? {tmdbId:member.showId} : {tvdbId:member.showId})},episode:{provider:member.provider,id:member.id,showId:member.showId,season:member.season,episode:member.episode,title:member.title},cause,action:state === "needs-review" ? "Edit and review this Manual Match to repair the missing member." : "Retry the Plex scan or review this Manual Match's episode context."});
      else resolveCoverageIssue(id);
      return state;
    }));
    const health = states.includes("needs-review") ? "needs-review" : states.includes("pending") ? "pending" : "healthy";
    updateCoverageHealth(mapping,health,health === "needs-review" ? "A provider confirmed an episode is missing. Resolve and review replacements to repair this mapping." : health === "pending" ? "Provider identity could not be verified. Coverage is pending; retry the scan or review the episode context." : undefined);
  }
}
