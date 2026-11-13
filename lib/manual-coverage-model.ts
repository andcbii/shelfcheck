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
  season: number;
  airDate?: string;
};
export type CoverageGroup = {
  mappingId: string;
  health?: CoverageMapping["health"];
  members: (CoverageMember & { status: "reported-missing" | "direct" | "automatic" | "manual" | "missing" | "alternative" })[];
  missing: (CoverageOutcome & { showKey: string })[];
};
