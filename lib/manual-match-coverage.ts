import { memberKey, reportedOrIncomplete, type CoverageEvidence, type CoverageIdentity, type CoverageMapping, type CoverageOutcome, type CoverageProvider } from "@/lib/manual-coverage-model";

/** A Manual Match that covers a provider episode, with the Library inventory records that directly own its other side. */
export type ManualMatchCoverage = { match: CoverageMapping; source: CoverageEvidence[] };

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
    const match = mappings.find(mapping => (!mapping.health || mapping.health === "healthy") && mapping.members.some(member => sameEpisode(member, episode)));
    if (!match) return undefined;
    const sourceMembers = match.members.filter(member => member.provider !== episode.provider);
    const owns = (item: CoverageEvidence, member: CoverageIdentity) => item.identities.some(identity => sameEpisode(identity, member));
    const source = directInventory.filter(item => sourceMembers.some(member => owns(item, member)));
    const complete = sourceMembers.length > 0 && sourceMembers.every(member => source.some(item => owns(item, member)));
    return complete ? { match, source } : undefined;
  }
}

const sameEpisode = (a: CoverageIdentity, b: CoverageIdentity) => memberKey(a) === memberKey(b);

/** A provider episode as the scan and the comparison list it. */
export type DecidableEpisode = { source: CoverageProvider; providerEpisodeId?: number; season: number; airDate?: string };
/**
 * Report Missing precedence for one episode: whether an unflagged special is skipped, and
 * otherwise its explicit Report Missing flag or derived Incomplete parts, with the coverage
 * outcome of its Manual Match membership when it is a member.
 */
export type ReportMissingPrecedence = { skip: true } | { skip: false; reported: boolean; missingParts: CoverageIdentity[]; outcome: CoverageOutcome | undefined };

/** The precedence of an episode treated as unflagged, used when its Report Missing check fails. */
export function unflaggedPrecedence(episode: DecidableEpisode | undefined): ReportMissingPrecedence {
  return episode?.season === 0 ? { skip: true } : { skip: false, reported: false, missingParts: [], outcome: undefined };
}

/**
 * Whether a Manual Match decides each episode (ADR-0007), shared by the scan's crosswalk
 * exclusion, the comparison's combined/split exclusion and its per-episode decisions, so
 * they cannot disagree. Report Missing (explicit, or a derived Incomplete combined episode)
 * and the season 0 visibility rule come first; then `coverage`, the shared rule, decides.
 */
export function manualMatchDecisions({ mappings, coverage }: { mappings: readonly CoverageMapping[]; coverage: ManualMatchCoverageRule }) {
  /** Throws when the episode's Manual Match membership is unreadable. */
  const reportMissingPrecedence = (episode: DecidableEpisode): ReportMissingPrecedence => {
    const self = episode.providerEpisodeId ? { provider: episode.source, id: episode.providerEpisodeId } : undefined;
    const memberMapping = self && mappings.find(mapping => mapping.members.some(member => sameEpisode(member, self)));
    // A combined episode whose split episodes are reported missing is incomplete,
    // with the same precedence. It is derived from the saved flags, never stored.
    const explicitOrDerived = memberMapping && self && reportedOrIncomplete(memberMapping.members, self);
    const reported = explicitOrDerived?.status === "reported-missing";
    const missingParts = explicitOrDerived?.status === "incomplete" ? explicitOrDerived.missingParts : [];
    if (episode.season === 0 && !reported && !missingParts.length) return { skip: true };
    const outcome: CoverageOutcome | undefined = memberMapping && self ? { ...self, status: "missing", season: episode.season, airDate: episode.airDate } : undefined;
    return { skip: false, reported, missingParts, outcome };
  };
  /**
   * Whether the final decision credits the episode to its Manual Match: no Report Missing or
   * derived Incomplete precedes it and the shared rule covers it. A check that fails here
   * counts as not covered; the comparison's final decision records that failure.
   */
  const decidedByManualMatch = (episode: DecidableEpisode | undefined) => {
    if (episode?.providerEpisodeId === undefined) return false;
    let precedence: ReportMissingPrecedence;
    try { precedence = reportMissingPrecedence(episode); } catch { precedence = unflaggedPrecedence(episode); }
    if (precedence.skip || precedence.reported || precedence.missingParts.length) return false;
    try { return Boolean(coverage({ provider: episode.source, id: episode.providerEpisodeId })); } catch { return false; }
  };
  return { reportMissingPrecedence, decidedByManualMatch };
}
