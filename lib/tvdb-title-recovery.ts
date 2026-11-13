import "server-only";
import { usableTitle } from "@/lib/compound-episodes";
import { providerLookupContext } from "@/lib/coverage-issues";
import { ProviderHttpError } from "@/lib/plex-provider-client";
import type { EpisodeCheckFailure, ProviderEpisode } from "@/lib/plex-comparison";

/**
 * Why an unusable default TVDB title is still unresolved after English fallback.
 * `no-english-title`: TVDB answered, but its English translation has no usable title.
 * `request-failed`: the translation request itself failed (`reason` is safe, readable text).
 */
export type TitleRecoveryState = Record<string, { outcome: "no-english-title" } | { outcome: "request-failed"; reason: string; causedBy?: string[] }>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const untitled = (episode: ProviderEpisode): episode is ProviderEpisode & { providerEpisodeId: number } => episode.source === "TVDB" && Boolean(episode.providerEpisodeId) && !usableTitle(episode.title);

/**
 * Fill unusable default TVDB titles from each episode's own English translation.
 * Merging is by TVDB episode identity and touches only the title: valid default
 * titles, IDs, numbering, dates and runtimes are kept. A title already recovered
 * for the same episode (`previous`, the saved catalogue) is reused without a request.
 * Never throws: each episode's failure stays with that episode.
 */
export async function recoverTvdbTitles(episodes: ProviderEpisode[], previous: ProviderEpisode[] | undefined, requestEnglish: (tvdbEpisodeId: number) => Promise<unknown>, authenticationError?: unknown) {
  const saved = new Map((previous || []).flatMap(episode => episode.source === "TVDB" && episode.titleLanguage === "eng" && episode.providerEpisodeId && usableTitle(episode.title) ? [[episode.providerEpisodeId, episode.title]] : []));
  const merged = episodes.map(episode => untitled(episode) && saved.has(episode.providerEpisodeId) ? { ...episode, title: saved.get(episode.providerEpisodeId), titleLanguage: "eng" as const } : episode);
  const pending = [...new Set(merged.filter(untitled).map(episode => episode.providerEpisodeId))];
  const titles = new Map<number, string>();
  const unresolved: TitleRecoveryState = {};
  await Promise.all(pending.map(async id => {
    try {
      const body = await requestEnglish(id);
      const name = isRecord(body) && isRecord(body.data) ? body.data.name : undefined;
      if (usableTitle(name)) titles.set(id, name);
      else unresolved[id] = { outcome: "no-english-title" };
    } catch (error) {
      // TVDB answers 404 when the episode has no English translation: no title, not an outage.
      if (error instanceof ProviderHttpError && error.status === 404) unresolved[id] = { outcome: "no-english-title" };
      else unresolved[id] = { outcome: "request-failed", reason: providerLookupContext(error, { source: [], impact: "" }).cause, ...(authenticationError !== undefined && error === authenticationError ? { causedBy: ["provider-authentication:TVDB"] } : {}) };
    }
  }));
  return {
    episodes: merged.map(episode => untitled(episode) && titles.has(episode.providerEpisodeId) ? { ...episode, title: titles.get(episode.providerEpisodeId), titleLanguage: "eng" as const } : episode),
    unresolved,
    recovered: [...titles.keys()],
    attempted: pending.length > 0,
  };
}

/** Saved recovery state is untrusted: keep only well-formed entries. */
export function savedTitleRecovery(value: unknown): TitleRecoveryState {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, entry]): [string, TitleRecoveryState[string]][] => !/^\d+$/.test(id) || !isRecord(entry) ? []
    : entry.outcome === "no-english-title" ? [[id, { outcome: "no-english-title" as const }]]
    : entry.outcome === "request-failed" && typeof entry.reason === "string" ? [[id, { outcome: "request-failed" as const, reason: entry.reason, ...(Array.isArray(entry.causedBy) ? { causedBy: entry.causedBy.filter((item): item is string => typeof item === "string") } : {}) }]]
    : []));
}

/**
 * Episode-scoped failures of English title recovery, with title-dependent checks
 * explained by the actual recovery outcome. `carried`: recovery was not attempted
 * in this comparison (an offline recheck or last-good catalogue), so a recorded
 * request failure is kept without claiming a new request.
 */
export function withTitleRecovery(ratingKey: string, failures: EpisodeCheckFailure[], state: TitleRecoveryState, episodes: ProviderEpisode[], carried = false): EpisodeCheckFailure[] {
  const requestFailures = Object.entries(state).flatMap(([id, entry]): EpisodeCheckFailure[] => {
    if (entry.outcome !== "request-failed") return [];
    const episode = episodes.find(item => item.source === "TVDB" && item.providerEpisodeId === Number(id));
    return [{ operation: "title-recovery", episode: { provider: "TVDB", id: Number(id), ...(episode ? { season: episode.season, episode: episode.episode } : {}) }, kind: "request-failed", reason: `${entry.reason}.`, ...(entry.causedBy?.length ? { causedBy: entry.causedBy } : {}), ...(carried ? { carried: true as const } : {}) }];
  });
  const explained = failures.map(failure => {
    const entry = failure.kind === "missing-title" && failure.episode.provider === "TVDB" && failure.episode.id !== undefined ? state[failure.episode.id] : undefined;
    if (!entry) return failure;
    if (entry.outcome === "no-english-title") return { ...failure, reason: "TVDB returned no usable default or English title for this episode." };
    return { ...failure, reason: "TVDB returned no usable default title for this episode, and its English title could not be retrieved.", causedBy: [`episode-check:${ratingKey}:title-recovery:TVDB:${failure.episode.id}`] };
  });
  return [...requestFailures, ...explained];
}
