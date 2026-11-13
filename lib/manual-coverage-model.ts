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
export type CoverageGroup = {
  mappingId: string;
  health?: CoverageMapping["health"];
  members: (CoverageMember & { status: "reported-missing" | "incomplete" | "direct" | "automatic" | "manual" | "missing" | "alternative"; missingParts?: CoverageIdentity[] })[];
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
export function reportMissingSelectionProblem(members: (CoverageIdentity & { reportMissing?: boolean })[]): string | undefined {
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
export function missingPartsOf(members: (CoverageIdentity & { reportMissing?: boolean })[], member: CoverageIdentity): CoverageIdentity[] {
  const combined = combinedMember(members);
  if (!combined || combined.provider !== member.provider || combined.id !== member.id) return [];
  return members.filter(part => part.provider !== member.provider && part.reportMissing).map(({ provider, id }) => ({ provider, id }));
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
