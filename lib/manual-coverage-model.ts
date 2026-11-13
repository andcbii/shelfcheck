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

const side = (members: CoverageIdentity[], provider: CoverageProvider) => members.filter(member => member.provider === provider);

/**
 * Report Missing flags may be saved when one provider side is a single episode:
 * one-to-one, or a combined episode and its split episodes in either direction.
 * Many-to-many mappings cannot carry flags yet.
 */
export function reportMissingSupported(members: CoverageIdentity[]) {
  return side(members, "TMDB").length === 1 || side(members, "TVDB").length === 1;
}

/**
 * The combined episode of a one-to-many Manual Match: the single member on one
 * provider side when the other side lists two or more split episodes.
 */
export function combinedMember<T extends CoverageIdentity>(members: T[]): T | undefined {
  const tmdb = members.filter(member => member.provider === "TMDB"), tvdb = members.filter(member => member.provider === "TVDB");
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
