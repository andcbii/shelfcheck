/**
 * ADR-0004 store I/O and request sharing for TMDB external-ID crosswalks, around the pure decisions
 * in `tmdb-crosswalk-policy`. Three rejection boundaries stay separate: the shared request outcome
 * (saved here), a comparison's acceptance of it (`rejectCopy`), and the checked marker (`retained`).
 * Coverage Issue state stays with the caller.
 */
import type { SavedPlexComparison } from "@/lib/plex-catalogues";
import { liveTmdbCrosswalkDecision, type SharedCrosswalkRecord } from "@/lib/tmdb-crosswalk-policy";
import { lookupKey, lookupOfKey, providerLookup } from "@/lib/provider-lookup";
import { responseRecordList } from "@/lib/value-guards";

/** Where shared crosswalk evidence is kept, by TVDB episode. */
export type SharedCrosswalkStore = {
  read(tvdbEpisodeId: number): SharedCrosswalkRecord | undefined;
  save(tvdbEpisodeId: number, record: SharedCrosswalkRecord): void;
};

/** A comparison's saved provider relationships, by relationship key. */
export type CrosswalkRelationships = SavedPlexComparison["relationships"];

/**
 * The episode results of a successful crosswalk response, or why they cannot be interpreted. The one
 * rule for both the shared outcome (readable or rejected) and the comparison's interpretation.
 */
export const tmdbCrosswalkResults = (value: unknown) => responseRecordList(value, "tv_episode_results");
const readableTmdbCrosswalk = (value: unknown) => "records" in tmdbCrosswalkResults(value);

const crosswalkKey = (tvdbEpisodeId: number) => lookupKey(providerLookup.tmdbEpisodeByTvdbEpisode(tvdbEpisodeId));

/**
 * The TMDB external-ID crosswalks of one live scan run. It owns the run's in-flight requests, shared
 * by every comparison in the run (one scan run is active at a time), and saves each request's shared
 * outcome before any waiting comparison continues.
 */
export function tmdbCrosswalkScanRun({ store, now, startedAt }: { store: SharedCrosswalkStore; now: () => string; startedAt: string }) {
  const inFlight = new Map<number, Promise<{ value: unknown; receivedAt: string }>>();
  const requested = new Set<number>();

  function shareRequest(tvdbEpisodeId: number, request: () => Promise<unknown>) {
    const pending = inFlight.get(tvdbEpisodeId);
    if (pending) return pending;
    // A request that throws before returning a promise is a failed request like any other.
    const started = Promise.resolve().then(request).then((value) => {
      const receivedAt = now();
      store.save(tvdbEpisodeId, readableTmdbCrosswalk(value) ? { value, receivedAt } : { value, rejectedAt: receivedAt });
      return { value, receivedAt };
    }, (error: unknown) => {
      store.save(tvdbEpisodeId, { rejectedAt: now() });
      throw error;
    }).finally(() => { inFlight.delete(tvdbEpisodeId); requested.add(tvdbEpisodeId); });
    inFlight.set(tvdbEpisodeId, started);
    return started;
  }

  return {
    /**
     * One comparison's view of the run: its saved relationships, and whether its lookups are forced.
     * `relationships` is the caller's own map, mutated in place: each lookup sets, replaces or removes the
     * comparison's crosswalk copy there, and `rejectCopy` strips a copy's receipt time.
     */
    comparison({ relationships, forced }: { relationships: CrosswalkRelationships; forced: boolean }) {
      /** The crosswalks this comparison has reached, marked before any request, failures included. */
      const checked = new Set<string>();
      return {
        /**
         * Reaches one TVDB episode's crosswalk and returns its answer: reuses current shared evidence, or discards
         * the comparison's copy and requests the lookup, joining the request already in flight. Either answer
         * resolves the comparison's failed request for it; the caller does that. `forced` also forces this lookup
         * alone, as a retry of its failed request does.
         */
        async lookup(tvdbEpisodeId: number, request: () => Promise<unknown>, options: { forced?: boolean } = {}): Promise<unknown> {
          const key = crosswalkKey(tvdbEpisodeId);
          checked.add(key);
          const decision = liveTmdbCrosswalkDecision({ shared: store.read(tvdbEpisodeId), scanStartedAt: startedAt, forced: forced || !!options.forced, requestedInThisScan: requested.has(tvdbEpisodeId) });
          if (decision.action === "reuse") {
            relationships[key] = { provider: "TMDB", ...decision.copy };
            return decision.copy.value;
          }
          delete relationships[key];
          const { value, receivedAt } = await shareRequest(tvdbEpisodeId, request);
          // An unreadable answer is kept only to explain the failure: without a receipt time it is never current.
          relationships[key] = readableTmdbCrosswalk(value) ? { provider: "TMDB", value, receivedAt } : { provider: "TMDB", value };
          return value;
        },
        /**
         * This comparison could not use the crosswalk (a failed request, an unreadable answer or an
         * interpretation failure): its copy loses its receipt time, so it is never current and never
         * grants coverage. The shared outcome is unchanged; another comparison may still use it.
         */
        rejectCopy(tvdbEpisodeId: number) {
          const copy = relationships[crosswalkKey(tvdbEpisodeId)];
          if (copy) delete copy.receivedAt;
        },
        /**
         * The relationships of a last-good comparison retained after this live comparison failed: its saved
         * evidence, except that each crosswalk this comparison checked takes this scan's outcome (removed when
         * it has none), so a rejected or replaced answer is never restored. Other relationships received during
         * the scan are not merged.
         */
        retained(saved: CrosswalkRelationships): CrosswalkRelationships {
          const kept = { ...saved };
          for (const key of checked) if (Object.hasOwn(relationships, key)) kept[key] = relationships[key]; else delete kept[key];
          return kept;
        },
      };
    },
  };
}

/** One live scan run's TMDB external-ID crosswalks. */
export type TmdbCrosswalkScanRun = ReturnType<typeof tmdbCrosswalkScanRun>;
/** One comparison's view of its scan run's TMDB external-ID crosswalks. */
export type TmdbCrosswalkComparison = ReturnType<TmdbCrosswalkScanRun["comparison"]>;

/**
 * A cached recheck's recovered crosswalk answers (see the policy's `recover` decision), by relationship
 * key, and the failed-request Coverage Issues they resolve once saved.
 */
export type RecoveredCrosswalks = { relationships: CrosswalkRelationships; resolves: string[] };

/**
 * Saves a cached recheck's recovered answers as the comparison's own copies first, and only then
 * resolves their failed requests, so a failed save leaves them open and the answers recoverable by a
 * later recheck.
 */
export function saveRecoveredTmdbCrosswalks({ relationships, resolves }: RecoveredCrosswalks, { save, resolveFailedRequest }: { save(copies: CrosswalkRelationships): void; resolveFailedRequest(issueId: string): void }) {
  if (!resolves.length) return;
  save(relationships);
  for (const issueId of resolves) resolveFailedRequest(issueId);
}

/**
 * Clearing one show's cache: the usable shared answer of each TMDB external-ID episode crosswalk
 * among the show's cleared relationships is marked not current for live scans, so its next lookup
 * is requested again. Other lookup kinds (a series association with the same numeric ID included)
 * invalidate nothing. It keeps its original receipt time, and rejections are kept unchanged, so
 * cached rechecks cannot revive an older copy.
 */
export function invalidateShowTmdbCrosswalks({ store, now }: { store: SharedCrosswalkStore; now: () => string }, clearedRelationshipKeys: Iterable<string>) {
  for (const key of clearedRelationshipKeys) {
    const lookup = lookupOfKey(key);
    if (lookup?.kind !== "tmdb-episode-by-tvdb-episode") continue;
    const { tvdbEpisodeId } = lookup;
    const shared = store.read(tvdbEpisodeId);
    if (shared?.receivedAt && !shared.invalidatedAt) store.save(tvdbEpisodeId, { ...shared, invalidatedAt: now() });
  }
}
