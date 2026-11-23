import type { CoverageIdentity, CoverageMember, CoverageProvider } from "../lib/manual-coverage-model";

/** A Manual Match member: provider episode `id`, with its saved Report Missing flag when `reportMissing`. */
export const episode = (provider: CoverageProvider, id: number, reportMissing = false): CoverageMember => ({
  provider, id, showId: provider === "TMDB" ? 10 : 20, show: "Show", title: `Episode ${id}`, season: 1, episode: id, url: "", ...(reportMissing ? { reportMissing } : {}),
});

/** A member's identity alone, without its saved flag. */
export const identity = ({ provider, id }: CoverageIdentity): CoverageIdentity => ({ provider, id });
