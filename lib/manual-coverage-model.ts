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
  fingerprint: string;
  identities: {
    provider: CoverageProvider;
    id: number;
  }[];
};
export type CoverageCorrection = CoverageEvidence & { mappingId: string };
export type CoverageMapping = {
  id: string;
  revision: number;
  members: CoverageMember[];
  createdAt: string;
  health?: "healthy" | "pending" | "needs-review";
  healthMessage?: string;
  evidence?: CoverageEvidence[];
  corrections?: CoverageCorrection[];
};
