export type TvdbResolutionEvidence = {
  directTvdb: boolean;
  directImdb: boolean;
  trakt: boolean;
  tmdb: boolean;
  compound: boolean;
};

export type TvdbResolutionOutcome = "direct-tvdb" | "direct-imdb" | "trakt" | "tmdb" | "compound" | "missing";

export function resolveTvdbEpisode(evidence: TvdbResolutionEvidence, autoCompoundEpisodes: boolean): TvdbResolutionOutcome {
  if (evidence.directTvdb) return "direct-tvdb";
  if (evidence.directImdb) return "direct-imdb";
  if (evidence.trakt) return "trakt";
  if (evidence.tmdb) return "tmdb";
  if (autoCompoundEpisodes && evidence.compound) return "compound";
  return "missing";
}

export function providerEpisodeIsOwned(input: {
  source: "TMDB" | "TVDB";
  providerEpisodeId?: number;
  localTmdbEpisodeIds: Set<number>;
  tvdbEvidence: TvdbResolutionEvidence;
  autoCompoundEpisodes: boolean;
}) {
  if (!input.providerEpisodeId) return false;
  if (input.source === "TMDB") return input.localTmdbEpisodeIds.has(input.providerEpisodeId);
  return resolveTvdbEpisode(input.tvdbEvidence, input.autoCompoundEpisodes) !== "missing";
}
