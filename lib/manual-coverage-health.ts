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
        return body.data?.id === member.id ? "healthy" : "pending";
      } catch(error) {
        if (error instanceof ProviderHttpError && error.provider === "TVDB" && error.status === 404) return "needs-review";
        throw error;
      }
    }
    // TMDB coordinates locate a record, not a canonical ID. A missing/moved coordinate
    // cannot establish deletion, and a different returned ID must never retarget it.
    const record = await client.json<{id?:number}>(`https://api.themoviedb.org/3/tv/${member.showId}/season/${member.season}/episode/${member.episode}`,{headers:{Authorization:`Bearer ${config.tmdbToken}`}},"TMDB");
    return record.id === member.id ? "healthy" : "pending";
  }
  for (const mapping of listCoverageMappings()) {
    if (mapping.health === "needs-review") continue; // A reviewed edit is required to repair it.
    const states = await Promise.all(mapping.members.map(async member => {
      try { return await memberHealth(member); } catch { return "pending" as const; }
    }));
    const health = states.includes("needs-review") ? "needs-review" : states.includes("pending") ? "pending" : "healthy";
    updateCoverageHealth(mapping,health,health === "needs-review" ? "A provider confirmed an episode is missing. Resolve and review replacements to repair this mapping." : health === "pending" ? "Provider identity could not be verified. Coverage is pending; retry the scan or review the episode context." : undefined);
  }
}
