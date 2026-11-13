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
};
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
  season: number;
  airDate?: string;
};
export type CoverageGroup = {
  mappingId: string;
  health?: CoverageMapping["health"];
  members: (CoverageMember & { status: "direct" | "automatic" | "manual" | "missing" | "alternative" })[];
  missing: (CoverageOutcome & { showKey: string })[];
};
