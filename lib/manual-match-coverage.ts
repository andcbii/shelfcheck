import { memberKey, type CoverageEvidence, type CoverageIdentity, type CoverageMapping } from "@/lib/manual-coverage-model";

/** A Manual Match that covers a provider episode, with the Library inventory records that directly own its other side. */
export type ManualMatchCoverage = { mapping: CoverageMapping; source: CoverageEvidence[] };

/**
 * Which Manual Match covers a provider episode, keyed by provider plus episode ID;
 * undefined when none does. Throws when a Manual Match or evidence record it reads is
 * unreadable: the caller records that as an Episode-scoped failure for this episode.
 */
export type ManualMatchCoverageRule = (episode: CoverageIdentity) => ManualMatchCoverage | undefined;

/**
 * The shared Manual Match coverage rule (ADR-0007). The first Healthy Manual Match
 * containing the episode decides it; a Manual Match with no saved health counts as
 * Healthy, and Pending or Needs review matches are passed over. It covers the episode
 * only when every member on the other provider side is directly owned by a record in
 * `directInventory`, the comparison's library-wide direct identities, including
 * records in other or ignored shows.
 *
 * It reads only the comparison's Manual Match health snapshot (`mappings`) and those
 * direct identities: never season and episode numbers, inferred matches, or coverage
 * granted by another Manual Match. Report Missing is not applied here.
 *
 * Evaluation is lazy and per episode, so one unreadable Manual Match or evidence
 * record fails only the episodes that read it. Answers are memoised per episode.
 */
export function manualMatchCoverageRule({ mappings, directInventory }: { mappings: readonly CoverageMapping[]; directInventory: readonly CoverageEvidence[] }): ManualMatchCoverageRule {
  const answers = new Map<string, ManualMatchCoverage | undefined>();
  return episode => {
    const key = memberKey(episode);
    if (answers.has(key)) return answers.get(key);
    const answer = coverageOf(episode);
    answers.set(key, answer);
    return answer;
  };

  function coverageOf(episode: CoverageIdentity): ManualMatchCoverage | undefined {
    const mapping = mappings.find(mapping => (!mapping.health || mapping.health === "healthy") && mapping.members.some(member => member.provider === episode.provider && member.id === episode.id));
    if (!mapping) return undefined;
    const sourceMembers = mapping.members.filter(member => member.provider !== episode.provider);
    const owns = (item: CoverageEvidence, member: CoverageIdentity) => item.identities.some(identity => identity.provider === member.provider && identity.id === member.id);
    const source = directInventory.filter(item => sourceMembers.some(member => owns(item, member)));
    const complete = sourceMembers.length > 0 && sourceMembers.every(member => source.some(item => owns(item, member)));
    return complete ? { mapping, source } : undefined;
  }
}
