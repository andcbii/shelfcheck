import type { ManualMatchMemberRemoval } from "@/lib/manual-coverage";
import type { CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";
import { ProviderHttpError } from "@/lib/provider-client";
import { runWorkerPool } from "@/lib/scan-concurrency";
import { isRecord } from "@/lib/value-guards";

/** How many removal candidates are looked up at their providers at once. */
export const REMOVAL_CONFIRMATION_WORKERS = 3;

/**
 * Looks one saved member's episode up at its provider, as saving it did: a TVDB member by its
 * episode ID, a TMDB member by its show, season and episode numbers. Resolves with the provider's
 * answer, or rejects with the provider client's error.
 */
export type MemberEpisodeLookup = (member: CoverageMember) => Promise<unknown>;

/** Why the provider says a candidate's episode is gone. */
export type GoneReason = "not-found" | "moved-series" | "different-episode";
/** Why a candidate is kept: the provider still has it, answered something unreadable, or could not be asked. */
export type KeptReason = "still-at-provider" | "unreadable-answer" | "lookup-failed" | "unknown-member";

export type CandidateConfirmation = { proposal: ManualMatchMemberRemoval; member?: CoverageMember } & (
  | { gone: true; reason: GoneReason }
  | { gone: false; reason: KeptReason; error?: unknown }
);

const safeId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** What the provider's successful answer says about the member's episode. */
function judgeAnswer(member: CoverageMember, answer: unknown): { gone: true; reason: GoneReason } | { gone: false; reason: KeptReason } {
  if (member.provider === "TVDB") {
    const record = isRecord(answer) && isRecord(answer.data) ? answer.data : undefined;
    if (!record || record.id !== member.id || !safeId(record.seriesId)) return { gone: false, reason: "unreadable-answer" };
    return record.seriesId === member.showId ? { gone: false, reason: "still-at-provider" } : { gone: true, reason: "moved-series" };
  }
  const id = isRecord(answer) ? answer.id : undefined;
  if (!safeId(id)) return { gone: false, reason: "unreadable-answer" };
  return id === member.id ? { gone: false, reason: "still-at-provider" } : { gone: true, reason: "different-episode" };
}

/**
 * Asks each removal candidate's provider whether its episode is really gone (ADR-0008). A fresh,
 * complete list that leaves a member out only makes it a candidate: an episode can exist outside
 * the order a list shows. A candidate is confirmed gone only when its provider answers 404, when
 * TVDB places the episode in another series, or when TMDB's episode at the member's show, season and
 * episode numbers has another ID. Every other outcome keeps it: the provider still has it, answered
 * unreadably, or could not be asked (an HTTP error other than 404, a timeout, a cooldown, an
 * unavailable provider or a failed sign-in). Each member is looked up once, with bounded
 * concurrency; a lookup failure never rejects.
 */
export async function confirmRemovalCandidates(proposals: readonly ManualMatchMemberRemoval[], mappings: readonly CoverageMapping[], lookup: MemberEpisodeLookup, workers = REMOVAL_CONFIRMATION_WORKERS): Promise<CandidateConfirmation[]> {
  const unique = [...new Map(proposals.map(proposal => [`${proposal.mappingId}:${proposal.member.provider}:${proposal.member.id}`, proposal])).values()];
  const confirmations: CandidateConfirmation[] = new Array(unique.length);
  await runWorkerPool(unique, workers, async (proposal, index) => {
    const member = mappings.find(mapping => mapping.id === proposal.mappingId)?.members.find(item => item.provider === proposal.member.provider && item.id === proposal.member.id);
    if (!member) { confirmations[index] = { proposal, gone: false, reason: "unknown-member" }; return; }
    try {
      confirmations[index] = { proposal, member, ...judgeAnswer(member, await lookup(member)) };
    } catch (error) {
      confirmations[index] = error instanceof ProviderHttpError && error.status === 404
        ? { proposal, member, gone: true, reason: "not-found" }
        : { proposal, member, gone: false, reason: "lookup-failed", error };
    }
  });
  return confirmations;
}
