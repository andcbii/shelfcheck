/**
 * ADR-0004 store I/O and request sharing for TMDB external-ID crosswalks, around the pure decisions
 * in `tmdb-crosswalk-policy`. Three rejection boundaries stay separate: the shared request outcome
 * (saved here), a comparison's acceptance of it (`rejectCopy`), and the checked marker (`retained`).
 * Coverage Issue state stays with the caller.
 */
import { liveTmdbCrosswalkDecision, type SharedCrosswalkRecord } from "@/lib/tmdb-crosswalk-policy";
import { lookupKey, providerLookup, tmdbEpisodeCrosswalkOfKey } from "@/lib/provider-lookup";
import { isRecord } from "@/lib/value-guards";

/** Where shared crosswalk evidence is kept, by TVDB episode. */
export type SharedCrosswalkStore = {
  read(tvdbEpisodeId: number): SharedCrosswalkRecord | undefined;
  save(tvdbEpisodeId: number, record: SharedCrosswalkRecord): void;
};

/** A comparison's saved provider relationships, by relationship key. */
export type CrosswalkRelationships = Record<string, { provider: string; value: unknown; receivedAt?: string }>;

/** One lookup's answer for a comparison; `reused` when it came from current shared evidence without a request. */
export type CrosswalkLookupResult = { value: unknown; reused: boolean };

/** A successful crosswalk response the scan can interpret: an object whose `tv_episode_results`, when present, is a list of records. */
function readableTmdbCrosswalk(value: unknown) {
  if (!isRecord(value)) return false;
  const results = value.tv_episode_results;
  return results === undefined || results === null || (Array.isArray(results) && results.every(isRecord));
}

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
    /** One comparison's view of the run: its saved relationships, and whether its lookups are forced. */
    comparison({ relationships, forced }: { relationships: CrosswalkRelationships; forced: boolean }) {
      /** The crosswalks this comparison has reached, marked before any request, failures included. */
      const checked = new Set<string>();
      return {
        /**
         * Reaches one TVDB episode's crosswalk: reuses current shared evidence (the caller then resolves the
         * comparison's failed request for it), or discards the comparison's copy and requests the lookup, joining
         * the request already in flight. `forced` also forces this lookup alone, as a retry of its failed request does.
         */
        async lookup(tvdbEpisodeId: number, request: () => Promise<unknown>, options: { forced?: boolean } = {}): Promise<CrosswalkLookupResult> {
          const key = crosswalkKey(tvdbEpisodeId);
          checked.add(key);
          const decision = liveTmdbCrosswalkDecision({ shared: store.read(tvdbEpisodeId), scanStartedAt: startedAt, forced: forced || !!options.forced, requestedInThisScan: requested.has(tvdbEpisodeId) });
          if (decision.action === "reuse") {
            relationships[key] = { provider: "TMDB", ...decision.copy };
            return { value: decision.copy.value, reused: true };
          }
          delete relationships[key];
          const { value, receivedAt } = await shareRequest(tvdbEpisodeId, request);
          // An unreadable answer is kept only to explain the failure: without a receipt time it is never current.
          relationships[key] = readableTmdbCrosswalk(value) ? { provider: "TMDB", value, receivedAt } : { provider: "TMDB", value };
          return { value, reused: false };
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

/** One comparison's view of its scan run's TMDB external-ID crosswalks. */
export type TmdbCrosswalkComparison = ReturnType<ReturnType<typeof tmdbCrosswalkScanRun>["comparison"]>;

/**
 * Clearing one show's cache: each usable shared answer among the show's cleared relationships is
 * marked not current for live scans, so its next lookup is requested again. It keeps its original
 * receipt time, and rejections are kept unchanged, so offline rechecks cannot revive an older copy.
 */
export function invalidateShowTmdbCrosswalks({ store, now }: { store: SharedCrosswalkStore; now: () => string }, clearedRelationshipKeys: Iterable<string>) {
  for (const key of clearedRelationshipKeys) {
    const tvdbEpisodeId = tmdbEpisodeCrosswalkOfKey(key);
    if (tvdbEpisodeId === undefined) continue;
    const shared = store.read(tvdbEpisodeId);
    if (shared?.receivedAt && !shared.invalidatedAt) store.save(tvdbEpisodeId, { ...shared, invalidatedAt: now() });
  }
}
