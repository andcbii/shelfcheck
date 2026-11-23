export type CoverageProvider = "TMDB" | "TVDB";
export type CoverageMember = {
  provider: CoverageProvider;
  id: number;
  showId: number;
  show: string;
  title: string;
  season: number;
  episode: number;
  url: string;
  /** Saved Report Missing flag: a local exception that keeps this episode missing. */
  reportMissing?: boolean;
};
export type CoverageIdentity = { provider: CoverageProvider; id: number };
/** A Manual Match member's identity with its saved Report Missing flag. */
export type FlaggableMember = CoverageIdentity & { reportMissing?: boolean };
export type CoverageEvidence = {
  ratingKey: string;
  showKey: string;
  identities: {
    provider: CoverageProvider;
    id: number;
  }[];
};
export type CoverageMapping = {
  id: string;
  revision: number;
  members: CoverageMember[];
  createdAt: string;
  health?: "healthy" | "pending" | "needs-review";
  healthMessage?: string;
  evidence?: CoverageEvidence[];
};

export type CoverageOutcome = {
  provider: CoverageProvider;
  id: number;
  status: "automatic" | "manual" | "missing";
  /** Missing because of an explicit Report Missing flag, whatever normal matching found. */
  reportedMissing?: boolean;
  /** Incomplete combined episode: missing because these mapped parts are reported missing. */
  missingParts?: CoverageIdentity[];
  season: number;
  airDate?: string;
};
/** A Manual Match member's status in Plex results; `memberStatus` sets their order. */
export type MemberStatus = "reported-missing" | "incomplete" | "direct" | "automatic" | "manual" | "missing" | "alternative";
export type CoverageGroup = {
  mappingId: string;
  health?: CoverageMapping["health"];
  members: (CoverageMember & { status: MemberStatus; missingParts?: CoverageIdentity[] })[];
  missing: (CoverageOutcome & { showKey: string })[];
};

/** Stable key for a provider episode, shared by server flag rows and client drafts. */
export const memberKey = (member: { provider: string; id: number }) => `${member.provider}:${member.id}`;

const side = <T extends CoverageIdentity>(members: T[], provider: CoverageProvider) => members.filter(member => member.provider === provider);

/**
 * Manual-save rule for Report Missing selections. A many-to-many Manual Match
 * (several episodes on both provider sides) saves zero flags or at least one
 * explicit flag on each side, so Shelfcheck never guesses which opposite-side
 * episode contains a flagged one. Derived status never counts as a selection.
 * Returns why the selection cannot be saved, or undefined when it can.
 *
 * Only manual saves apply this rule. Reading or comparing persisted flags
 * accepts a one-sided state, which automatic Ignore cleanup may leave behind.
 */
export function reportMissingSelectionProblem(members: FlaggableMember[]): string | undefined {
  const tmdb = side(members, "TMDB"), tvdb = side(members, "TVDB");
  if (tmdb.length < 2 || tvdb.length < 2 || !members.some(member => member.reportMissing)) return undefined;
  const unflagged = !tmdb.some(member => member.reportMissing) ? "TMDB" : !tvdb.some(member => member.reportMissing) ? "TVDB" : undefined;
  return unflagged && `This Manual Match has several episodes on both provider sides, so Report Missing needs an explicit selection on each side. Select Report Missing on at least one ${unflagged} episode that your local copy lacks, or clear Report Missing on every episode.`;
}

/**
 * The combined episode of a one-to-many Manual Match: the single member on one
 * provider side when the other side lists two or more split episodes.
 */
export function combinedMember<T extends CoverageIdentity>(members: T[]): T | undefined {
  const tmdb = side(members, "TMDB"), tvdb = side(members, "TVDB");
  if (tmdb.length === 1 && tvdb.length > 1) return tmdb[0];
  if (tvdb.length === 1 && tmdb.length > 1) return tvdb[0];
  return undefined;
}

/**
 * Split episodes whose saved Report Missing flags leave `member` an incomplete
 * combined episode. Always derived from the current flags, never saved itself.
 */
export function missingPartsOf(members: FlaggableMember[], member: CoverageIdentity): CoverageIdentity[] {
  const combined = combinedMember(members);
  if (!combined || combined.provider !== member.provider || combined.id !== member.id) return [];
  return members.filter(part => part.provider !== member.provider && part.reportMissing).map(({ provider, id }) => ({ provider, id }));
}

/**
 * Whether a Manual Match member is missing because of saved Report Missing
 * flags: reported missing by its own flag, incomplete because flagged split
 * episodes leave it an incomplete combined episode, or neither (undefined).
 * Reported wins over incomplete. Plex results and the comparison both decide
 * this here, so they cannot disagree.
 */
export function reportedOrIncomplete(members: FlaggableMember[], member: CoverageIdentity): { status: "reported-missing" } | { status: "incomplete"; missingParts: CoverageIdentity[] } | undefined {
  if (members.some(item => item.provider === member.provider && item.id === member.id && item.reportMissing)) return { status: "reported-missing" };
  const missingParts = missingPartsOf(members, member);
  return missingParts.length ? { status: "incomplete", missingParts } : undefined;
}

/**
 * The status a Manual Match member shows in Plex results, highest first:
 * Reported missing, Incomplete, Directly owned, Missing, Satisfied
 * automatically, Covered by complete alternative set, then Alternative.
 * `member` identifies one of `members`, whose saved flags decide the first two
 * levels, so the member's own flag is always read from `members`.
 * `direct` says whether a Plex item owns the member directly; `matched` holds
 * the comparison outcomes for this member. Missing parts appear only on an
 * incomplete combined episode.
 */
export function memberStatus({ member, members, direct, matched }: {
  member: CoverageIdentity;
  members: FlaggableMember[];
  direct: boolean;
  matched: Pick<CoverageOutcome, "status">[];
}): { status: MemberStatus; missingParts?: CoverageIdentity[] } {
  // Explicit and derived missing status outrank direct ownership and every collected outcome.
  const explicitOrDerived = reportedOrIncomplete(members, member);
  if (explicitOrDerived) return explicitOrDerived;
  if (direct) return { status: "direct" };
  for (const status of ["missing", "automatic", "manual"] as const) if (matched.some(outcome => outcome.status === status)) return { status };
  return { status: "alternative" };
}

/** Readable label for the derived status, distinct from an explicit "Reported missing". */
export const INCOMPLETE_LABEL = "Incomplete · mapped part missing";

/** Names the flagged part(s) responsible for an incomplete combined episode. */
export function missingPartsExplanation(members: CoverageMember[], parts: CoverageIdentity[]) {
  const names = parts.map(part => {
    const member = members.find(item => item.provider === part.provider && item.id === part.id);
    return `${part.provider} ${member?.title || "episode"} (Episode ID ${part.id})`;
  });
  return `Contains ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}, which you reported missing.`;
}
