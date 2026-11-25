import type { ComparedCatalogue } from "@/lib/comparison-catalogue-resolver";
import type { ManualMatchMemberRemoval } from "@/lib/manual-coverage";
import type { CoverageMapping } from "@/lib/manual-coverage-model";

/**
 * The Manual Match members one successfully compared show proves gone (ADR-0008): a member of
 * the provider show whose catalogue this scan run downloaded fresh and complete, whose episode ID
 * is absent from that download's raw episode-ID universe. Only a catalogue carrying that
 * universe counts, and only for its own provider show ID: a reused, saved, failed, incomplete or
 * fallback catalogue carries none, so it proves nothing absent. Each proposal names the Manual
 * Match revision the scan read.
 */
export function manualMatchRemovalCandidates(mappings: readonly CoverageMapping[], catalogues: readonly (ComparedCatalogue<unknown> | undefined)[]): ManualMatchMemberRemoval[] {
  const proposals: ManualMatchMemberRemoval[] = [];
  for (const catalogue of catalogues) {
    const universe = catalogue?.episodeIds;
    if (!catalogue || !universe || universe.showId !== catalogue.id) continue;
    for (const mapping of mappings) for (const member of mapping.members) {
      if (member.provider !== universe.provider || member.showId !== catalogue.id || member.showId !== universe.showId || universe.ids.has(member.id)) continue;
      proposals.push({ mappingId: mapping.id, member: { provider: member.provider, id: member.id }, expectedRevision: mapping.revision });
    }
  }
  return proposals;
}
