import { catalogueUseExplanation } from "@/lib/catalogue-description";
import { chooseAvailableCatalogue, chooseSavedCatalogue, failedSingleIdUse, multipleIdUse, savedCatalogueUse, singleIdUse, type CatalogueChoice } from "@/lib/catalogue-fallback";
import { catalogueIssueIds, PROVIDER_NAME, PROVIDERS, type CatalogueProvider } from "@/lib/catalogue-selection";
import type { CatalogueUse } from "@/lib/catalogue-selection-store";
import { providerLookupContext, type CatalogueRefreshState, type CoverageIssue, type LookupSourceStep } from "@/lib/coverage-issues";
import { GONE_RECORD_NOT_FOUND_DAYS, goneProviderRecord, MULTIPLE_ID_REFRESH_AGE } from "@/lib/plex-catalogue-policy";
import { combinePatches, effectivePatch, PREFERRED_REQUIRED, requiresDownload, satisfiedByDownload, type AttemptedCatalogue, type RefreshObligation, type RefreshObligationPatch } from "@/lib/refresh-obligation";

/**
 * The comparison catalogue resolver: for one library show, which comparison catalogue each provider
 * uses and what follows from that choice (ADR-0003, ADR-0005). Its one entry point is
 * `resolveComparisonCatalogues`; catalogues reach it only through a `ComparisonCatalogueSource`, so
 * the live scan and the cached recheck each supply their own source and share these rules.
 *
 * Everything it returns is a value for the caller to apply: catalogue uses are proposals published
 * under the caller's comparison-success and last-good rules, and catalogue Coverage Issues carry an
 * explicit set, resolve or preserve action.
 */

/** Per-provider catalogue payload types; the resolver never looks inside a payload. */
export type CataloguePayloads = Record<CatalogueProvider, unknown>;

/** How a load must treat a saved copy. Computed by the resolver; the source applies its freshness policy with them. */
export type CatalogueLoadSettings = {
  /** Download even when the saved copy would otherwise be reused. */
  mandatory: boolean;
  /** Download once the saved copy is older than this (ms); still reused at exactly this age. */
  refreshAfter?: number;
};

/** How a series association request must treat saved evidence. */
export type SeriesAssociationSettings = {
  /**
   * Request the association even when saved evidence could answer it. When not mandatory, a live
   * source answers from saved evidence (`cached: true`) wherever its reuse policy would reuse the
   * TMDB series last compared for that TVDB series, and requests it otherwise.
   */
  mandatory: boolean;
};

/**
 * One load attempt's outcome. Download and reuse report the original download time; reuse never renews it.
 * A TMDB catalogue reports the TVDB series it names, if any, as `associatedTvdbId`.
 *
 * `no-series`: the provider answered with an empty show for this ID (TMDB `null`), so there is no
 * catalogue to compare. The resolver treats it like a 404 (Andrew, 2026-11-21): a failed load whose
 * saved copy is not kept, so the provider is a Total Provider Lookup Failure with no catalogue and the
 * show is compared with the other provider. It is not a series-request 404, so it never counts
 * toward the series' 404 days.
 */
export type CatalogueLoad<T> =
  | {
      outcome: "downloaded" | "reused"; id: number; catalogue: T; downloadedAt: string; associatedTvdbId?: number;
      /** The lookup provenance of the series loaded, when the load extended it; the provider's identity then reports it. */
      lookupSource?: LookupSourceStep[];
    }
  | { outcome: "no-series" }
  | {
      outcome: "failed";
      error: unknown;
      /** A series ID resolved before the failure, which the Coverage Issue then names. */
      resolvedId?: number;
      /** Coverage Issue IDs this failure is caused by, such as provider authentication. */
      causedBy?: string[];
      /** The lookup provenance at the failure, when the attempt extended it. */
      lookupSource?: LookupSourceStep[];
      /**
       * `series-not-found`: the series request itself (TMDB `/tv/{id}`, TVDB `/series/{id}`) answered
       * 404. A 404 on a season, episode page or any other request is an ordinary failure.
       */
      kind?: "series-not-found";
      /** With `series-not-found`: the series' counted 404 days, this one included (ADR-0006). */
      seriesNotFoundDays?: number;
    };

/** A saved catalogue, whatever its age. */
export type SavedCatalogue<T> = { id: number; catalogue: T; downloadedAt: string; associatedTvdbId?: number };

/**
 * A series association: the TMDB series TMDB associates with a TVDB ID. `known-empty` is a valid
 * answer naming no series; `missing` means saved evidence cannot answer it and it was not requested,
 * so the series cannot be resolved yet; `failed` is a request that failed. `cached` says the answer
 * came from saved evidence rather than a request in this attempt.
 */
export type SeriesAssociation =
  | { outcome: "found"; id: number; cached: boolean }
  | { outcome: "known-empty" }
  | { outcome: "missing" }
  | { outcome: "failed"; error: unknown; causedBy?: string[] };

/** Where the resolver gets catalogues: the live scan's downloading source or the cached recheck's saved one. */
export type ComparisonCatalogueSource<P extends CataloguePayloads> = {
  /** Load a series' catalogue, downloading or reusing it as the settings and the source's freshness policy decide. */
  loadCatalogue<K extends CatalogueProvider>(provider: K, id: number, settings: CatalogueLoadSettings): Promise<CatalogueLoad<P[K]>>;
  /** A series' saved catalogue, at any age, if a usable one is saved. */
  savedCatalogue<K extends CatalogueProvider>(provider: K, id: number): SavedCatalogue<P[K]> | undefined;
  /**
   * The original download time of a series' saved record, even one too incomplete to compare. A live
   * scan's catalogue use for several Plex IDs reports it as the preferred series' download time.
   */
  savedRecordDownloadedAt(provider: CatalogueProvider, id: number): string | undefined;
  /**
   * The series' counted 404 days since its last complete catalogue download (ADR-0006), 0 with no
   * history. A live source records them as it loads; a cached recheck's source only reads them.
   */
  seriesNotFoundDays(provider: CatalogueProvider, id: number): number;
  /** The TMDB series associated with a TVDB series. A rejection is a failed association. A cached recheck asks with `mandatory: false` only. */
  tmdbSeriesForTvdb(tvdbId: number, settings: SeriesAssociationSettings): Promise<SeriesAssociation>;
};

/**
 * One provider's prior-selection history, which a cached recheck decides from. The recorded catalogue
 * use says whether the current preference has been tried (its `preferredId` matches) and keeps the
 * failure provenance a scan recorded. The unresolved catalogue-refresh issue, if any, names the series
 * whose refresh failed and when: it supplies provenance only when it names the current preferred ID,
 * and never permits a cached fallback.
 */
export type PriorSelection = {
  recordedUse?: CatalogueUse;
  refreshIssue?: { seriesId?: number; failedAt?: string };
};

/**
 * A provider's lookup status for one show, judged from the catalogue in use (ADR-0006), never from
 * which IDs Plex reports. `working`: the catalogue in use comes from a series whose latest download
 * attempt succeeded or that was reused without one, whether Plex reported it or it was found through
 * the other provider. `total-failure`: a Total Provider Lookup Failure, comparing a saved copy kept
 * after a failed attempt (`saved`), with nothing usable (`none`), or whose series is a Gone provider
 * record (`gone`: its saved catalogue is kept but never compared); `cause` is its catalogue-refresh
 * Coverage Issue's cause; a missing ID (no Plex ID and none found through the other provider) and an
 * empty show are Total Provider Lookup Failures with no catalogue (Andrew, 2026-11-21). `no-series`:
 * nothing to look up and no failure recorded: a show Plex reports no ID at all for, or a cached
 * recheck of a provider the last scan recorded no status for. `pending`: saved evidence cannot
 * resolve the series yet.
 * Candidates not tried never count as failing.
 */
export type ProviderLookupStatus =
  | { state: "working" }
  | { state: "total-failure"; catalogue: "saved" | "none" | "gone"; cause: string }
  | { state: "no-series" }
  | { state: "pending" };

/**
 * The show's match status: `unmatched` when no provider has a usable catalogue, live or saved (an
 * Unmatched show); `partially-matched` when it has one but some provider is a Total Provider Lookup
 * Failure (a Partially matched show); else `matched`.
 */
export type ShowMatchStatus = "matched" | "partially-matched" | "unmatched";

/** The live scan downloads; a cached recheck reads saved inputs only, deciding from each provider's prior-selection history. */
export type ResolutionContext = { kind: "live-scan" } | { kind: "cached-recheck"; history: Record<CatalogueProvider, PriorSelection> };

export type ProviderRequest = {
  /** The series IDs Plex reports for this provider. */
  candidates: number[];
  /** The catalogue override, else the lowest Plex-reported ID. */
  preferredId?: number;
  /** This provider's refresh obligation for the show, as it was at resolution entry: it governs every attempt. */
  refreshObligation: RefreshObligation;
  /** How the preferred ID was found, for Coverage Issue provenance. */
  lookupSource: LookupSourceStep[];
};

export type ComparisonCatalogueRequest = {
  context: ResolutionContext;
  show: { ratingKey: string; title?: string };
  /** The one time every age decision in this resolution uses. */
  resolvedAt: string;
  /**
   * The show's last saved comparison: the series it compared and whether its results are complete
   * (last-good). A derived TMDB series that cannot be loaded keeps comparing the one last compared
   * for the same TVDB series.
   */
  previousComparison?: {
    tmdbId?: number; tvdbId?: number; complete: boolean;
    /**
     * Each provider's status as the last scan recorded it. A cached recheck never judges a provider
     * again: it keeps this status, and compares no catalogue for a provider the scan had none for.
     */
    status?: Partial<Record<CatalogueProvider, ProviderLookupStatus>>;
  };
  tmdb: ProviderRequest;
  tvdb: ProviderRequest;
};

/** What the comparison runs against; `saved` is a saved copy compared because its load failed. */
export type ComparedCatalogue<T> = { id: number; origin: "downloaded" | "reused" | "saved"; downloadedAt: string; catalogue: T; associatedTvdbId?: number };

/** A proposed change to the provider's recorded catalogue use. */
export type CatalogueUseProposal = { action: "set"; use: CatalogueUse } | { action: "clear" } | { action: "unchanged" };

/** A catalogue Coverage Issue (catalogue-refresh or catalogue-fallback-refresh) and what to do with it. */
export type CatalogueIssueAction = { action: "set"; issue: CoverageIssue } | { action: "resolve"; id: string } | { action: "preserve"; id: string };

export type ProviderResolution<T> = {
  /** The provider's series identity after resolution: the series compared, else the one that is unavailable. */
  identity?: number;
  /** How that identity was found (its lookup provenance), for this provider's later Coverage Issues; empty with no identity. */
  lookupSource: LookupSourceStep[];
  /** Absent when no catalogue is usable. */
  catalogue?: ComparedCatalogue<T>;
  use: CatalogueUseProposal;
  /**
   * The provider's refresh obligation change: only what changes the obligation in the request, so
   * applying it keeps every other part. A preferred failure adds the preferred requirement; a complete
   * successful download removes the requirements it satisfies; reuse and failed loads remove nothing.
   */
  obligation: RefreshObligationPatch;
  issues: CatalogueIssueAction[];
  /** The Coverage Issue ID that explains a missing catalogue, for the comparison-inputs issue's causes. */
  unavailableCause?: string;
  /** A warning for the show's result when no catalogue is usable or a derived series could not be loaded. */
  warning?: string;
  /** Saved evidence cannot resolve this provider's series, so the comparison is pending. */
  incomplete?: true;
  /** The provider's series is a Gone provider record: its saved catalogue is kept but not compared. */
  gone?: true;
  /** Plex reports at most one ID for this provider, so its series is the single Plex ID's or a derived one, under the single-catalogue policy. */
  singleCatalogue?: true;
  /** The provider's lookup status for this show, from the catalogue in use. */
  status: ProviderLookupStatus;
};

/** A provider's resolution before its status is judged. */
type ProviderChoice<T> = Omit<ProviderResolution<T>, "status">;

export type ComparisonCatalogueResolution<P extends CataloguePayloads> = {
  /**
   * `comparable`: at least one provider has a usable catalogue, so the show is compared with whatever
   * catalogues are usable; one provider's failure never blocks the other's comparison. `unmatched`: no
   * provider has a usable catalogue. `pending`: saved evidence cannot resolve a provider's series yet,
   * so last-good results stay; a cached recheck never compares the other provider alone.
   */
  outcome: "comparable" | "unmatched" | "pending";
  showStatus: ShowMatchStatus;
  /** The order the providers were resolved in: TVDB first when TMDB is derived from a TVDB catalogue chosen among several. */
  resolutionOrder: readonly CatalogueProvider[];
  /** The order the comparison runs the catalogues in, whatever the resolution order: TMDB, then TVDB. */
  comparisonOrder: readonly CatalogueProvider[];
  /** The Coverage Issue IDs explaining each missing catalogue, in resolution order: the comparison-inputs issue's causes. */
  unavailableCauses: string[];
  /** The show's result warnings: the providers' in resolution order, then a live scan's warning that Plex reports no ID at all. */
  warnings: string[];
  /**
   * A pending cached recheck's one warning to report, as its comparison-inputs cause: the first
   * provider whose series saved evidence cannot resolve, a provider choosing among several Plex IDs
   * before the other, else TMDB before TVDB. Absent in a live scan and when nothing is pending.
   */
  pendingWarning?: string;
} & { [K in CatalogueProvider]: ProviderResolution<P[K]> };

/**
 * One provider's progress, final once its candidate choice is: a provider-scoped obligation patch to
 * persist, and the catalogue chosen for comparison, if any, which the other provider's loads may depend on.
 */
export type ProviderProgress<P extends CataloguePayloads = CataloguePayloads, K extends CatalogueProvider = CatalogueProvider> = {
  [Q in K]: { provider: Q; obligation: RefreshObligationPatch; catalogue?: ComparedCatalogue<P[Q]> };
}[K];

export type ResolverDependencies<P extends CataloguePayloads> = {
  source: ComparisonCatalogueSource<P>;
  /**
   * The progress sink: persists one provider's obligation change before the other provider's work
   * starts, so an interruption between them loses no progress. Awaited; a rejection propagates as a
   * `ProgressPersistenceError`, never as a provider failure. An acknowledged patch is final: the caller
   * does not reapply or roll it back, even when the overall outcome is pending.
   */
  onProviderResolved?: (progress: ProviderProgress<P>) => Promise<void>;
};

/** The progress sink could not persist a provider's obligation change; `cause` is the sink's rejection. */
export class ProgressPersistenceError extends Error {
  constructor(readonly provider: CatalogueProvider, cause: unknown) {
    super(`The ${PROVIDER_NAME[provider]} refresh obligation change could not be saved.`, { cause });
    this.name = "ProgressPersistenceError";
  }
}

/** The warning for a live-scanned show Plex reports no TMDB or TVDB ID for. */
const NO_PLEX_IDS_WARNING = "No TMDB or TVDB ID was exposed by Plex.";

/** The Coverage Issue impact of an unavailable preferred series, from the shared description of the catalogue in use. */
function unavailablePreferredImpact(provider: CatalogueProvider, use: CatalogueUse) {
  return `${catalogueUseExplanation(provider, use)} ${PROVIDER_NAME[provider]} series ${use.preferredId} is retried every scan; the preference is kept.`;
}

/** Resolve both providers' comparison catalogues for one show. */
export async function resolveComparisonCatalogues<P extends CataloguePayloads>(request: ComparisonCatalogueRequest, dependencies: ResolverDependencies<P>): Promise<ComparisonCatalogueResolution<P>> {
  const resolving: Resolving<P> = { request, source: dependencies.source, identities: { tmdb: request.tmdb.preferredId, tvdb: request.tvdb.preferredId }, resolved: {} };
  // Without a Plex TMDB ID, TMDB is derived from the TVDB series compared, so that is chosen first.
  const order: readonly CatalogueProvider[] = !request.tmdb.candidates.length && severalCandidates(request.tvdb) ? ["tvdb", "tmdb"] : PROVIDERS;
  for (const provider of order) {
    const resolution = judged(request, provider, await resolveProvider(resolving, provider));
    resolving.identities[provider] = resolution.identity;
    try {
      await dependencies.onProviderResolved?.(progressOf(provider, resolution));
    } catch (error) {
      throw new ProgressPersistenceError(provider, error);
    }
    (resolving.resolved as Record<CatalogueProvider, ProviderResolution<unknown>>)[provider] = resolution;
  }
  const { tmdb, tvdb } = resolving.resolved as Resolved<P>;
  const unresolved = (resolution: ProviderResolution<unknown>) => resolution.status.state === "pending";
  const noIdentity = tmdb.identity === undefined && tvdb.identity === undefined;
  const noCatalogue = !tmdb.catalogue && !tvdb.catalogue;
  const outcome = unresolved(tmdb) || unresolved(tvdb) ? "pending" : noCatalogue ? "unmatched" : "comparable";
  const showStatus: ShowMatchStatus = noCatalogue ? "unmatched" : [tmdb, tvdb].some(resolution => resolution.status.state === "total-failure") ? "partially-matched" : "matched";
  const inOrder = order.map(provider => (resolving.resolved as Resolved<P>)[provider] as ProviderResolution<unknown>);
  const noPlexIds = request.context.kind === "live-scan" && noIdentity && !request.tmdb.candidates.length && !request.tvdb.candidates.length;
  const pendingWarning = request.context.kind === "cached-recheck" ? cachedPendingWarning(request, resolving.resolved as Resolved<P>) : undefined;
  return {
    outcome, showStatus, resolutionOrder: order, comparisonOrder: PROVIDERS,
    unavailableCauses: inOrder.flatMap(resolution => resolution.unavailableCause ? [resolution.unavailableCause] : []),
    warnings: [...inOrder.flatMap(resolution => resolution.warning ? [resolution.warning] : []), ...(noPlexIds ? [NO_PLEX_IDS_WARNING] : [])],
    tmdb, tvdb, ...(pendingWarning !== undefined ? { pendingWarning } : {}),
  };
}

/**
 * A provider's status, judged from the catalogue in use and its catalogue-refresh Coverage Issue. A
 * cached recheck keeps the status the last scan recorded for a provider it can resolve.
 */
function judged<T>(request: ComparisonCatalogueRequest, provider: CatalogueProvider, choice: ProviderChoice<T>): ProviderResolution<T> {
  if (choice.incomplete) return { ...choice, status: { state: "pending" } };
  const recorded = request.context.kind === "cached-recheck" ? request.previousComparison?.status?.[provider] : undefined;
  if (recorded && recorded.state !== "pending") return { ...choice, status: recorded };
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request.show.ratingKey);
  const failure = choice.issues.find(action => action.action === "set" && (action.issue.id === refreshId || action.issue.id === fallbackId));
  const cause = failure?.action === "set" ? failure.issue.cause : undefined;
  if (choice.catalogue) return { ...choice, status: choice.catalogue.origin === "saved" && cause !== undefined ? { state: "total-failure", catalogue: "saved", cause } : { state: "working" } };
  return { ...choice, status: cause !== undefined ? { state: "total-failure", catalogue: choice.gone ? "gone" : "none", cause } : { state: "no-series" } };
}

/** A provider's progress as the progress sink receives it. */
function progressOf<P extends CataloguePayloads, K extends CatalogueProvider>(provider: K, resolution: ProviderResolution<P[K]>): ProviderProgress<P, K> {
  return { provider, obligation: resolution.obligation, ...(resolution.catalogue ? { catalogue: resolution.catalogue } : {}) };
}

/** A cached recheck reports a several-ID provider's problem before any other, then the rest in provider order. */
function cachedPendingWarning(request: ComparisonCatalogueRequest, resolved: Resolved<CataloguePayloads>) {
  const choosesAmongSeveral = (provider: CatalogueProvider) => severalCandidates(request[provider]) && request[provider].preferredId !== undefined;
  const pending = [...PROVIDERS].sort((a, b) => Number(choosesAmongSeveral(b)) - Number(choosesAmongSeveral(a))).find(provider => resolved[provider].incomplete);
  return pending && resolved[pending].warning;
}

type Resolved<P extends CataloguePayloads> = { [K in CatalogueProvider]: ProviderResolution<P[K]> };
type Identities = Record<CatalogueProvider, number | undefined>;

/** One resolution in progress: its request, source, each provider's identity so far (the preferred ID until resolved) and the providers resolved. */
type Resolving<P extends CataloguePayloads> = {
  request: ComparisonCatalogueRequest;
  source: ComparisonCatalogueSource<P>;
  identities: Identities;
  resolved: Partial<Resolved<P>>;
};

type Failure = Extract<CatalogueLoad<unknown>, { outcome: "failed" }>;

/** What a catalogue-refresh Coverage Issue says was requested. */
type RequestedKind = "show" | "series" | "TVDB ID search";
/** Per provider: what a series request is called, the other provider, and the warning for a failure that has no message. */
const PROVIDER_TERMS: Record<CatalogueProvider, { requestedKind: RequestedKind; other: CatalogueProvider; lookupFailed: string }> = {
  tmdb: { requestedKind: "show", other: "tvdb", lookupFailed: "TMDB lookup failed." },
  tvdb: { requestedKind: "series", other: "tmdb", lookupFailed: "Provider lookup failed." },
};

/**
 * A candidate's state in an attempt: loaded, failed this attempt, or not tried yet (a cached
 * recheck's preference no scan has tried). In a cached recheck, a tried preference has the state the
 * scan that last tried it left it in.
 */
export type CandidateState = "loaded" | "failed-this-attempt" | "not-tried-yet";

const severalCandidates = (providerRequest: ProviderRequest) => new Set(providerRequest.candidates).size > 1;

/**
 * A failed load, carried through the shared fallback policy as its error. A load that throws instead
 * is a failed load too; persistence the caller does after resolution is not a load.
 */
class FailedLoad {
  constructor(readonly failure: Failure) {}
}
const failureOf = (error: unknown): Failure => error instanceof FailedLoad ? error.failure : { outcome: "failed", error };
const comparedFrom = <T>(load: SavedCatalogue<T>, origin: ComparedCatalogue<T>["origin"]): ComparedCatalogue<T> =>
  ({ id: load.id, origin, downloadedAt: load.downloadedAt, catalogue: load.catalogue, ...(load.associatedTvdbId !== undefined ? { associatedTvdbId: load.associatedTvdbId } : {}) });

async function resolveProvider<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K): Promise<ProviderChoice<P[K]>> {
  const resolution = await chooseProviderCatalogue(resolving, provider);
  return severalCandidates(resolving.request[provider]) ? resolution : { ...resolution, singleCatalogue: true };
}

async function chooseProviderCatalogue<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K): Promise<ProviderChoice<P[K]>> {
  const { request } = resolving;
  const providerRequest = request[provider];
  if (request.context.kind === "cached-recheck") return resolveCachedProvider(resolving, provider, request.context.history[provider]);
  // A Plex-reported ID always wins: a series is derived only for a provider Plex reports none for.
  if (!providerRequest.candidates.length)
    return (provider === "tvdb" ? deriveTvdb(resolving) : deriveTmdb(resolving, resolving.identities.tvdb)) as Promise<ProviderChoice<P[K]>>;
  const preferred = providerRequest.preferredId ?? Math.min(...providerRequest.candidates);
  return severalCandidates(providerRequest) ? chooseAmongCandidates(resolving, provider, preferred) : singleIdCatalogue(resolving, provider, preferred);
}

/**
 * A provider with one Plex ID (ADR-0003): its catalogue loads under the single-catalogue reuse policy,
 * and after a failed lookup its saved catalogue stays in use at any age. Any successful download
 * clears an open obligation, since the one ID is the preferred catalogue.
 */
async function singleIdCatalogue<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, id: number): Promise<ProviderChoice<P[K]>> {
  const { request, source, identities } = resolving;
  const providerRequest = request[provider];
  const load = await loadSingleCatalogue(source, provider, id, providerRequest.refreshObligation);
  if (load.outcome !== "failed" && load.outcome !== "no-series") return {
    identity: load.id, lookupSource: load.lookupSource ?? providerRequest.lookupSource, catalogue: comparedFrom(load, load.outcome),
    use: { action: "set", use: singleIdUse(load.id, load.downloadedAt) },
    obligation: loadedObligation(providerRequest, id, load), issues: resolvedIssues(provider, request),
  };
  // Shares the derived series' failure: the saved catalogue at any age, else unavailable. An empty show keeps none.
  const gone = goneRecord(source, provider, id, request.resolvedAt);
  const saved = gone || load.outcome === "no-series" ? undefined : source.savedCatalogue(provider, id);
  const use: CatalogueUseProposal = { action: "set", use: failedSingleIdUse(id, saved?.downloadedAt, request.resolvedAt) };
  const failure = load.outcome === "no-series" ? emptySeriesFailure(provider, id) : load;
  return singleCatalogueFailure(provider, request, { ...identities, [provider]: id }, failure, { kind: PROVIDER_TERMS[provider].requestedKind, id }, { lookupSource: providerRequest.lookupSource, saved, use, downloadedAt: source.savedRecordDownloadedAt(provider, id), gone });
}

/** Both catalogue issues resolved: the provider's catalogue loaded, or it has no series. */
function resolvedIssues(provider: CatalogueProvider, request: ComparisonCatalogueRequest): CatalogueIssueAction[] {
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request.show.ratingKey);
  return [{ action: "resolve", id: refreshId }, { action: "resolve", id: fallbackId }];
}

/** Both catalogue issues kept as they are: a cached recheck, or a series not yet resolvable, never sets or resolves one. */
function preservedIssues(provider: CatalogueProvider, request: ComparisonCatalogueRequest): CatalogueIssueAction[] {
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request.show.ratingKey);
  return [{ action: "preserve", id: refreshId }, { action: "preserve", id: fallbackId }];
}

/** A provider's catalogue-refresh Coverage Issue value, in the shape the scan sets it. */
function catalogueIssue(provider: CatalogueProvider, request: ComparisonCatalogueRequest, identities: Identities, input: { id: string; failure: Failure; seriesId: number | undefined; requested: { kind: RequestedKind; id: number }; source: LookupSourceStep[]; impact: string; failedAt?: string; candidates?: CoverageIssue["candidates"]; downloadedAt?: string; gone?: GoneRecord }): CoverageIssue {
  const name = PROVIDER_NAME[provider];
  const ids = { ...identities, [provider]: input.seriesId };
  return {
    id: input.id, ...(input.failedAt ? { failedAt: input.failedAt } : {}), ...(input.failure.causedBy?.length ? { causedBy: input.failure.causedBy } : {}),
    operation: "catalogue-refresh", provider: name, scope: "show",
    show: { ...request.show, tmdbId: ids.tmdb, tvdbId: ids.tvdb },
    ...(input.seriesId !== undefined ? { catalogueRefresh: catalogueRefreshState(request, input.failure, input.downloadedAt, input.gone) } : {}),
    ...providerLookupContext(input.failure.error, { source: input.failure.lookupSource || input.source, requested: { provider: name, ...input.requested }, impact: input.impact }),
    ...(input.candidates ? { candidates: input.candidates } : {}),
  } as CoverageIssue;
}

/** The failed series' catalogue age and 404 progress, as of this resolution. */
function catalogueRefreshState(request: ComparisonCatalogueRequest, failure: Failure, downloadedAt: string | undefined, gone?: GoneRecord): CatalogueRefreshState {
  // A gone record shows its counted 404 days whatever today's failure was.
  const seriesNotFoundDays = gone?.seriesNotFoundDays ?? (failure.kind === "series-not-found" ? failure.seriesNotFoundDays : undefined);
  return {
    checkedAt: request.resolvedAt, ...(downloadedAt ? { downloadedAt } : {}),
    ...(seriesNotFoundDays !== undefined ? { seriesNotFoundDays } : {}),
    ...(gone ? { gone: true } : {}),
  };
}

/** A Gone provider record's counted 404 days. */
export type GoneRecord = { seriesNotFoundDays: number };

/**
 * Whether a series is a Gone provider record as of this resolution (ADR-0006), from the source's
 * counted 404 days and the saved record's last complete download. The one rule for every path that
 * could compare a saved copy: one Plex ID, a derived series, a cached recheck, each of several candidates.
 */
export function goneRecord(source: Pick<ComparisonCatalogueSource<CataloguePayloads>, "seriesNotFoundDays" | "savedRecordDownloadedAt">, provider: CatalogueProvider, id: number, resolvedAt: string): GoneRecord | undefined {
  const seriesNotFoundDays = source.seriesNotFoundDays(provider, id);
  return goneProviderRecord({ seriesNotFoundDays, downloadedAt: source.savedRecordDownloadedAt(provider, id), now: resolvedAt }) ? { seriesNotFoundDays } : undefined;
}

const failureWarning = (failure: Failure, fallback: string) => failure.error instanceof Error ? failure.error.message : fallback;

/**
 * No series to derive: Plex reports no ID for the provider and none was found through the other
 * provider. It compares nothing and its recorded use is cleared. In a scan that is a Total Provider
 * Lookup Failure for a missing ID (Andrew, 2026-11-21): one catalogue-refresh issue naming the missing
 * ID and the search that found nothing, if any. It adds no result warning or obligation, since there
 * is nothing to retry. A show Plex reports no ID at all for has no other provider to search: it stays
 * an Unmatched show under its one no-Plex-IDs warning, with no catalogue issue for either provider.
 * A cached recheck preserves the catalogue issues, as for any provider.
 */
function noDerivedSeries(provider: CatalogueProvider, request: ComparisonCatalogueRequest, identities: Identities, lookupSource: LookupSourceStep[] = [], searched?: { kind: RequestedKind; id: number }, issueSource = lookupSource): ProviderChoice<never> {
  const unchanged = { lookupSource, use: { action: "clear" as const }, obligation: NO_CHANGE };
  if (request.context.kind === "cached-recheck") return { ...unchanged, issues: preservedIssues(provider, request) };
  if (!request.tmdb.candidates.length && !request.tvdb.candidates.length) return { ...unchanged, issues: resolvedIssues(provider, request) };
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request.show.ratingKey);
  const name = PROVIDER_NAME[provider], other = PROVIDER_NAME[PROVIDER_TERMS[provider].other];
  const ids = { ...identities, [provider]: undefined };
  const issue: CoverageIssue = {
    id: refreshId, operation: "catalogue-refresh", provider: name, scope: "show", show: { ...request.show, tmdbId: ids.tmdb, tvdbId: ids.tvdb }, category: "Provider Lookup",
    lookup: { source: issueSource, ...(searched ? { requested: { provider: "TMDB", ...searched } } : {}), failureKind: "missing-id", impact: `${name} episode coverage could not be verified: no ${name} series ID was found for this show. It is compared with the catalogues that remain usable.` },
    cause: `No ${name} series ID from Plex or ${other}`,
    action: `Fix the show's Plex match so Plex reports a ${name} ID, or add the TVDB ID to its TMDB record, then run a Plex scan.`,
  };
  return { ...unchanged, issues: [{ action: "set", issue }, { action: "resolve", id: fallbackId }], unavailableCause: refreshId };
}

/** A series the provider answered with an empty show for: a failed load, treated like a 404 but never a counted one (Andrew, 2026-11-21). */
const emptySeriesFailure = (provider: CatalogueProvider, id: number): Failure =>
  ({ outcome: "failed", error: new Error(`${PROVIDER_NAME[provider]} returned no ${PROVIDER_TERMS[provider].requestedKind} ${id}.`) });

/** The TVDB series named by the TMDB catalogue in use, for a show Plex reports no TVDB ID for. */
async function deriveTvdb<P extends CataloguePayloads>(resolving: Resolving<P>): Promise<ProviderChoice<P["tvdb"]>> {
  const { request, source } = resolving;
  const compared = resolving.resolved.tmdb?.catalogue;
  const tvdbId = compared?.associatedTvdbId;
  if (!compared || tvdbId === undefined) return noDerivedSeries("tvdb", request, resolving.identities, [], undefined, request.tmdb.lookupSource);
  const lookupSource: LookupSourceStep[] = [...request.tmdb.lookupSource, { provider: "TMDB", kind: "external TVDB ID", id: tvdbId, cached: compared.origin !== "downloaded" }];
  const derivedUse = (downloadedAt?: string): CatalogueUseProposal => ({ action: "set", use: { usingId: tvdbId, state: "derived", derivedFrom: compared.id, ...(downloadedAt ? { usingDownloadedAt: downloadedAt } : {}) } });
  const identities = { tmdb: compared.id, tvdb: tvdbId };
  const load = request.context.kind === "cached-recheck" ? readSaved(source, "tvdb", tvdbId, request.resolvedAt) : await loadSingleCatalogue(source, "tvdb", tvdbId, request.tvdb.refreshObligation);
  if (!load) return missingFromSaved(resolving, "tvdb", tvdbId, lookupSource);
  if (load.outcome !== "failed" && load.outcome !== "no-series")
    return { identity: load.id, lookupSource: load.lookupSource ?? lookupSource, catalogue: comparedFrom(load, load.outcome), use: derivedUse(load.downloadedAt), obligation: loadedObligation(request.tvdb, tvdbId, load), issues: loadedIssues("tvdb", request) };
  // A derived series whose load fails keeps its saved catalogue at any age, as a single Plex ID does; an empty show keeps none.
  const gone = goneRecord(source, "tvdb", tvdbId, request.resolvedAt);
  const saved = gone || load.outcome === "no-series" ? undefined : source.savedCatalogue("tvdb", tvdbId);
  const failure = load.outcome === "no-series" ? emptySeriesFailure("tvdb", tvdbId) : load;
  return singleCatalogueFailure("tvdb", request, identities, failure, { kind: "series", id: tvdbId }, { lookupSource, saved, use: derivedUse(saved?.downloadedAt), downloadedAt: source.savedRecordDownloadedAt("tvdb", tvdbId), gone });
}

/**
 * TMDB's association for a TVDB series. It may come from saved evidence unless its refresh obligation
 * requires a download; a live scan requests one that saved evidence cannot answer. A cached recheck never requests.
 */
async function seriesAssociation<P extends CataloguePayloads>(resolving: Resolving<P>, tvdbId: number): Promise<SeriesAssociation> {
  const ask = async (mandatory: boolean): Promise<SeriesAssociation> => {
    try { return await resolving.source.tmdbSeriesForTvdb(tvdbId, { mandatory }); } catch (error) { return { outcome: "failed", error }; }
  };
  if (resolving.request.context.kind === "cached-recheck") return ask(false);
  const mandatory = requiresDownload(resolving.request.tmdb.refreshObligation, SINGLE_CATALOGUE_UNNAMED);
  const association = await ask(mandatory);
  return association.outcome === "missing" && !mandatory ? ask(true) : association;
}

/** The TMDB series TMDB associates with the TVDB series in use, for a show Plex reports no TMDB ID for. */
async function deriveTmdb<P extends CataloguePayloads>(resolving: Resolving<P>, tvdbId: number | undefined): Promise<ProviderChoice<P["tmdb"]>> {
  const { request, source } = resolving;
  if (tvdbId === undefined) return noDerivedSeries("tmdb", request, resolving.identities);
  const plexStep: LookupSourceStep = { provider: "Plex", kind: "TVDB series", id: tvdbId };
  const association = await seriesAssociation(resolving, tvdbId);
  if (association.outcome === "known-empty") return noDerivedSeries("tmdb", request, { ...resolving.identities, tvdb: tvdbId }, [plexStep], { kind: "TVDB ID search", id: tvdbId });
  // Saved inputs hold no failed lookups: a cached recheck never turns an unreadable association into one.
  if (association.outcome === "missing" || (association.outcome === "failed" && request.context.kind === "cached-recheck")) return {
    lookupSource: [plexStep], use: { action: "unchanged" }, obligation: NO_CHANGE, issues: preservedIssues("tmdb", request), incomplete: true,
    warning: `TMDB's association for TVDB series ${tvdbId} is not saved, so its TMDB series could not be resolved from saved inputs. Last-good results were kept until the next Plex scan.`,
  };
  // A derived TMDB series that cannot be loaded keeps comparing the one last compared for this TVDB series, at any age.
  const previous = request.previousComparison;
  const retainedId = previous?.tvdbId === tvdbId ? previous.tmdbId : undefined;
  // A retained series that is a Gone provider record is never compared.
  const saved = retainedId === undefined || goneRecord(source, "tmdb", retainedId, request.resolvedAt) ? undefined : source.savedCatalogue("tmdb", retainedId);
  const resolvedStep = (id: number, cached: boolean): LookupSourceStep => ({ provider: "TMDB", kind: "resolved show", id, cached });
  if (association.outcome === "failed") {
    const failure: Failure = { outcome: "failed", error: association.error, ...(association.causedBy ? { causedBy: association.causedBy } : {}) };
    const failed = singleCatalogueFailure("tmdb", request, { tmdb: undefined, tvdb: tvdbId }, failure, { kind: "TVDB ID search", id: tvdbId }, { lookupSource: [plexStep], saved, use: { action: "clear" } });
    // The kept series is the one resolved before, so its provenance ends with that resolution from saved evidence.
    return failed.catalogue ? { ...failed, lookupSource: [plexStep, resolvedStep(failed.catalogue.id, true)] } : failed;
  }
  const lookupSource: LookupSourceStep[] = [plexStep, resolvedStep(association.id, association.cached)];
  const load = request.context.kind === "cached-recheck" ? readSaved(source, "tmdb", association.id, request.resolvedAt) : await loadSingleCatalogue(source, "tmdb", association.id, request.tmdb.refreshObligation);
  if (!load) return missingFromSaved(resolving, "tmdb", association.id, lookupSource);
  // An empty show is treated like a failed load, but the series last compared is not kept in its place.
  if (load.outcome === "no-series")
    return singleCatalogueFailure("tmdb", request, { tmdb: association.id, tvdb: tvdbId }, emptySeriesFailure("tmdb", association.id), { kind: "show", id: association.id }, { lookupSource, saved: undefined, use: { action: "set", use: { usingId: association.id, state: "derived", derivedFrom: tvdbId } }, downloadedAt: source.savedRecordDownloadedAt("tmdb", association.id), gone: goneRecord(source, "tmdb", association.id, request.resolvedAt) });
  if (load.outcome !== "failed") return {
    identity: load.id, lookupSource: load.lookupSource ?? lookupSource, catalogue: comparedFrom(load, load.outcome),
    use: { action: "set", use: { usingId: load.id, state: "derived", derivedFrom: tvdbId, usingDownloadedAt: load.downloadedAt } },
    obligation: loadedObligation(request.tmdb, association.id, load),
    issues: loadedIssues("tmdb", request),
  };
  // The series resolved before the failure is the one its Coverage Issue names, with its provenance.
  const resolvedId = load.resolvedId ?? association.id;
  return singleCatalogueFailure("tmdb", request, { tmdb: resolvedId, tvdb: tvdbId }, load, { kind: "show", id: resolvedId }, { lookupSource, saved, use: { action: "clear" }, downloadedAt: source.savedRecordDownloadedAt("tmdb", resolvedId), gone: goneRecord(source, "tmdb", resolvedId, request.resolvedAt) });
}

/** A series that loads resolves its catalogue issues in a scan; a cached recheck preserves them. */
const loadedIssues = (provider: CatalogueProvider, request: ComparisonCatalogueRequest): CatalogueIssueAction[] =>
  request.context.kind === "cached-recheck" ? preservedIssues(provider, request) : resolvedIssues(provider, request);

/**
 * A single Plex ID or derived series loads under the single-catalogue reuse policy: no 20-day
 * refresh, mandatory when its obligation requires it. It is the provider's one catalogue, so the preferred one.
 */
async function loadSingleCatalogue<P extends CataloguePayloads, K extends CatalogueProvider>(source: ComparisonCatalogueSource<P>, provider: K, id: number, obligation: RefreshObligation): Promise<CatalogueLoad<P[K]>> {
  const mandatory = requiresDownload(obligation, attemptedCatalogue(source, provider, id, true));
  try { return await source.loadCatalogue(provider, id, { mandatory }); } catch (error) { return { outcome: "failed", error }; }
}

const NO_CHANGE: RefreshObligationPatch = {};
/**
 * The catalogue a series ID requests, named also by the ID its saved copy reports, before its load
 * decides between download and reuse: a specific requirement applies before that reuse decision.
 */
function attemptedCatalogue<P extends CataloguePayloads>(source: ComparisonCatalogueSource<P>, provider: CatalogueProvider, id: number, preferred: boolean): AttemptedCatalogue {
  const reportedId = source.savedCatalogue(provider, id)?.id;
  return { id, ...(reportedId !== undefined && reportedId !== id ? { reportedId } : {}), preferred };
}
/**
 * A derived provider's one catalogue before its series ID is known, when deciding whether its
 * association must be requested: only the preferred and every-attempted requirements can apply to it.
 */
const SINGLE_CATALOGUE_UNNAMED: AttemptedCatalogue = { preferred: true };

/** A single catalogue that loads satisfies requirements only by downloading: those naming the ID requested or the ID the download reports. */
const loadedObligation = (providerRequest: ProviderRequest, requestedId: number, load: { outcome: "downloaded" | "reused"; id: number }): RefreshObligationPatch =>
  load.outcome === "downloaded" ? effectivePatch(providerRequest.refreshObligation, satisfiedByDownload({ id: requestedId, reportedId: load.id, preferred: true })) : NO_CHANGE;

/** A preferred catalogue that could not be loaded adds the preferred requirement, keeping every other part. */
const failedObligation = (providerRequest: ProviderRequest): RefreshObligationPatch => effectivePatch(providerRequest.refreshObligation, PREFERRED_REQUIRED);

/** The impact of a single catalogue that could not be loaded. */
function singleCatalogueFailureImpact(provider: CatalogueProvider, request: ComparisonCatalogueRequest, retained: boolean, goneId?: number) {
  const name = PROVIDER_NAME[provider];
  if (goneId !== undefined) return `${name} episode coverage could not be verified. ${name} series ${goneId} is a gone provider record: its series request has answered 404 on ${GONE_RECORD_NOT_FOUND_DAYS} or more days and its saved catalogue is more than 60 days old, so that catalogue is kept but no longer compared. One complete download makes it usable again.`;
  return `${PROVIDER_NAME[provider]} episode coverage could not be fully verified. ${retained ? "Last-good catalogue data was retained." : "No previous catalogue data is available."} ${request.previousComparison?.complete ? "Last-good comparison results remain available." : "No previous comparison results are available."}`;
}

/**
 * A single Plex ID or derived series that could not be resolved or loaded: its catalogue-refresh issue,
 * and the saved catalogue kept (any age), if any.
 */
function singleCatalogueFailure<T>(provider: CatalogueProvider, request: ComparisonCatalogueRequest, identities: Identities, failure: Failure, requested: { kind: RequestedKind; id: number }, kept: { lookupSource: LookupSourceStep[]; saved: SavedCatalogue<T> | undefined; use: CatalogueUseProposal; downloadedAt?: string; gone?: GoneRecord }): ProviderChoice<T> {
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request.show.ratingKey);
  const { lookupSource, saved, use, downloadedAt } = kept;
  const seriesId = identities[provider];
  // Only the failed series itself is reported gone, and only when nothing else is compared in its place.
  const gone = !saved && seriesId !== undefined ? kept.gone : undefined;
  const issues: CatalogueIssueAction[] = [
    { action: "set", issue: catalogueIssue(provider, request, identities, { id: refreshId, failure, seriesId, requested, source: lookupSource, impact: singleCatalogueFailureImpact(provider, request, !!saved, gone && seriesId), downloadedAt, gone }) },
    { action: "resolve", id: fallbackId },
  ];
  const warning = failureWarning(failure, PROVIDER_TERMS[provider].lookupFailed);
  const obligation = failedObligation(request[provider]);
  const provenance = failure.lookupSource || lookupSource;
  if (saved) return { identity: saved.id, lookupSource: provenance, catalogue: comparedFrom(saved, "saved"), use, obligation, issues, warning };
  return { ...(seriesId !== undefined ? { identity: seriesId } : {}), lookupSource: provenance, use, obligation, issues, unavailableCause: refreshId, warning, ...(gone ? { gone: true as const } : {}) };
}

/** A provider with several Plex candidates: preferred, its saved copy within 60 days, the lowest usable fallback, else unavailable. */
async function chooseAmongCandidates<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, preferredId: number): Promise<ProviderChoice<P[K]>> {
  const { request, source, identities } = resolving;
  const providerRequest = request[provider];
  const now = request.resolvedAt;
  // Requirements are read once, at entry: a preferred failure found below never forces a fallback in the same attempt.
  const obligation = providerRequest.refreshObligation;
  const attempted = (id: number) => attemptedCatalogue(source, provider, id, id === preferredId);
  let preferredProvenance: LookupSourceStep[] | undefined;
  const goneOf = (id: number) => goneRecord(source, provider, id, now);
  const choice: CatalogueChoice<ComparedCatalogue<P[K]>> = await chooseAvailableCatalogue<ComparedCatalogue<P[K]>>({
    preferredId, candidates: providerRequest.candidates, now,
    load: async id => {
      // A specific requirement applies to whichever candidate is attempted, before its reuse decision.
      const load = await source.loadCatalogue(provider, id, { mandatory: requiresDownload(obligation, attempted(id)), refreshAfter: MULTIPLE_ID_REFRESH_AGE });
      if (load.outcome === "failed") throw new FailedLoad(load);
      if (load.outcome === "no-series") throw new FailedLoad(emptySeriesFailure(provider, id));
      if (id === preferredId) preferredProvenance = load.lookupSource;
      return { value: comparedFrom(load, load.outcome), downloadedAt: load.downloadedAt };
    },
    saved: id => {
      const saved = source.savedCatalogue(provider, id);
      return saved && { value: comparedFrom(saved, "saved"), downloadedAt: saved.downloadedAt };
    },
    gone: id => goneOf(id) !== undefined,
  });
  const preferredState: CandidateState = choice.preferredError ? "failed-this-attempt" : "loaded";
  // The preferred series' download time comes from its saved record, even one too incomplete to compare.
  const use = multipleIdUse(choice, preferredId, source.savedRecordDownloadedAt(provider, preferredId), now);
  const catalogue = choice.loaded?.value;
  const identity = catalogue ? catalogue.id : preferredId;
  const kind = PROVIDER_TERMS[provider].requestedKind;
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request.show.ratingKey);
  const issues: CatalogueIssueAction[] = [];
  let warning: string | undefined, unavailableCause: string | undefined;
  // No catalogue from a working candidate: a Total Provider Lookup Failure, whose one entry lists each candidate tried and why it failed.
  const failing = !catalogue || catalogue.origin === "saved";
  if (preferredState === "failed-this-attempt") {
    const failure = failureOf(choice.preferredError);
    const candidates = failing ? choice.failures.map(({ id, error }) => {
      const candidateFailure = failureOf(error);
      return { id, cause: providerLookupContext(candidateFailure.error, { source: [], requested: { provider: PROVIDER_NAME[provider], kind, id }, impact: "" }).cause, catalogueRefresh: catalogueRefreshState(request, candidateFailure, source.savedRecordDownloadedAt(provider, id), goneOf(id)) };
    }) : undefined;
    const impact = choice.gone ? severalGoneImpact(provider, choice.failures.map(({ id }) => id)) : unavailablePreferredImpact(provider, use);
    issues.push({ action: "set", issue: catalogueIssue(provider, request, identities, { id: refreshId, failure, seriesId: preferredId, requested: { kind, id: preferredId }, source: providerRequest.lookupSource, impact, failedAt: now, downloadedAt: source.savedRecordDownloadedAt(provider, preferredId), candidates, gone: goneOf(preferredId) }) });
    if (!catalogue) {
      unavailableCause = refreshId;
      warning = failureWarning(failure, `${PROVIDER_NAME[provider]} lookup failed.`);
    }
  } else issues.push({ action: "resolve", id: refreshId });
  // A fallback compared from saved data after its own failed refresh is listed in that one entry, never a second one.
  issues.push({ action: "resolve", id: fallbackId });
  // Decided only now that candidate choice is final, so every load above used the obligation as it was.
  // The candidate requested (`usingId`) decides whether the download was the preferred catalogue, whatever ID the provider reports.
  const satisfied = catalogue?.origin === "downloaded" && choice.usingId !== undefined
    ? satisfiedByDownload({ id: choice.usingId, reportedId: catalogue.id, preferred: choice.usingId === preferredId }) : NO_CHANGE;
  const obligationChange = effectivePatch(obligation, preferredState === "failed-this-attempt" ? combinePatches(satisfied, PREFERRED_REQUIRED) : satisfied);
  // A fallback keeps the preference's provenance.
  const lookupSource = (preferredState === "loaded" && preferredProvenance) || providerRequest.lookupSource;
  return { identity, lookupSource, ...(catalogue ? { catalogue } : {}), use: { action: "set", use }, obligation: obligationChange, issues, ...(unavailableCause ? { unavailableCause } : {}), ...(warning ? { warning } : {}), ...(choice.gone ? { gone: true as const } : {}) };
}

/** The impact of a provider whose every candidate is a Gone provider record. */
function severalGoneImpact(provider: CatalogueProvider, ids: number[]) {
  const name = PROVIDER_NAME[provider];
  return `${name} episode coverage could not be verified. Every reported ${name} series (${ids.join(", ")}) is a gone provider record: its series request has answered 404 on ${GONE_RECORD_NOT_FOUND_DAYS} or more days and its saved catalogue is more than 60 days old, so those catalogues are kept but no longer compared. One complete download makes a series usable again.`;
}

/**
 * A provider in a cached recheck, from saved inputs only: nothing is loaded, no obligation changes and
 * every catalogue-refresh and catalogue-fallback-refresh issue is preserved. A provider with several
 * Plex candidates chooses among their saved copies; a derived series is derived again only when the
 * series it follows changed; anything else keeps the series last compared.
 */
function resolveCachedProvider<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, history: PriorSelection): Promise<ProviderChoice<P[K]>> | ProviderChoice<P[K]> {
  const { request, resolved } = resolving;
  const providerRequest = request[provider];
  const previous = request.previousComparison;
  if (!providerRequest.candidates.length) {
    const followedProvider = PROVIDER_TERMS[provider].other;
    const followed = resolved[followedProvider];
    const followedId = previous?.[`${followedProvider}Id`];
    // Unchanged (or not yet chosen) selected IDs keep their saved derived identity without new evidence.
    if (!followed?.catalogue || followed.identity === followedId) return keepCompared(resolving, provider, keptDerivedSource(provider, request));
    return (provider === "tvdb" ? deriveTvdb(resolving) : deriveTmdb(resolving, followed.identity)) as Promise<ProviderChoice<P[K]>>;
  }
  if (severalCandidates(providerRequest) && providerRequest.preferredId !== undefined) return chooseAmongSavedCandidates(resolving, provider, providerRequest.preferredId, history);
  return keepCompared(resolving, provider, providerRequest.lookupSource);
}

const unchangedResolution = { use: { action: "unchanged" } as const, obligation: NO_CHANGE };
const missingSavedCatalogue = (provider: CatalogueProvider, id: number) =>
  `Saved ${PROVIDER_NAME[provider]} catalogue ${id} is missing or incomplete. Run a Plex scan to download the ${PROVIDER_NAME[provider]} catalogue.`;

/**
 * A cached read of a series' saved catalogue, as a reuse; absent when no usable copy is saved or the
 * series is a Gone provider record, which a cached recheck never compares.
 */
function readSaved<P extends CataloguePayloads, K extends CatalogueProvider>(source: ComparisonCatalogueSource<P>, provider: K, id: number, resolvedAt: string): CatalogueLoad<P[K]> | undefined {
  if (goneRecord(source, provider, id, resolvedAt)) return undefined;
  const saved = source.savedCatalogue(provider, id);
  return saved && { outcome: "reused", ...saved };
}

/**
 * A series the cached recheck compares but cannot read, or that has become a Gone provider record
 * since the last scan: pending, with last-good results kept until the next scan judges it. A recheck
 * never judges a provider again, so it never changes the show's status by itself.
 */
function missingFromSaved<P extends CataloguePayloads>(resolving: Resolving<P>, provider: CatalogueProvider, id: number, lookupSource: LookupSourceStep[]): ProviderChoice<never> {
  const { request, source } = resolving;
  const warning = goneRecord(source, provider, id, request.resolvedAt)
    ? `${PROVIDER_NAME[provider]} series ${id} is a gone provider record, so its saved catalogue is no longer compared. Last-good results were kept until the next Plex scan.`
    : missingSavedCatalogue(provider, id);
  return { identity: id, lookupSource, ...unchangedResolution, issues: preservedIssues(provider, request), incomplete: true, warning };
}

/** The provenance of a derived series a cached recheck keeps: the derivation chain from the series it follows. */
function keptDerivedSource(provider: CatalogueProvider, request: ComparisonCatalogueRequest): LookupSourceStep[] {
  const previous = request.previousComparison;
  if (provider === "tvdb") return previous?.tvdbId === undefined ? [] : [...request.tmdb.lookupSource, { provider: "TMDB", kind: "external TVDB ID", id: previous.tvdbId, cached: true }];
  if (previous?.tmdbId === undefined) return [];
  const plexStep: LookupSourceStep[] = previous.tvdbId === undefined ? [] : [{ provider: "Plex", kind: "TVDB series", id: previous.tvdbId }];
  return [...plexStep, { provider: "TMDB", kind: "resolved show", id: previous.tmdbId, cached: true }];
}

/** The series last compared, kept by a cached recheck with its recorded use unchanged. */
function keepCompared<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, lookupSource: LookupSourceStep[]): ProviderChoice<P[K]> {
  const { request, source } = resolving;
  const issues = preservedIssues(provider, request);
  const id = request.previousComparison?.[`${provider}Id`];
  if (id === undefined) return { lookupSource: [], ...unchangedResolution, issues };
  // The last scan had no catalogue for this provider, or judged its series gone, so the recheck compares none either and keeps that status.
  const recorded = request.previousComparison?.status?.[provider];
  if (recorded?.state === "total-failure" && recorded.catalogue !== "saved") return { identity: id, lookupSource, ...unchangedResolution, issues, ...(recorded.catalogue === "gone" ? { gone: true as const } : {}) };
  const saved = goneRecord(source, provider, id, request.resolvedAt) ? undefined : source.savedCatalogue(provider, id);
  if (!saved) return missingFromSaved(resolving, provider, id, lookupSource);
  return { identity: id, lookupSource, catalogue: comparedFrom(saved, "reused"), ...unchangedResolution, issues };
}

/** The state a cached recheck's preference was left in: not tried yet unless the recorded use names it. */
function cachedPreferenceState(recorded: CatalogueUse | undefined, preferredId: number): CandidateState {
  if (recorded?.preferredId !== preferredId) return "not-tried-yet";
  return recorded.state === "preferred" ? "loaded" : "failed-this-attempt";
}

/**
 * Several Plex candidates in a cached recheck: the preferred saved copy within 60 days, else, once a
 * scan has tried this preference, the lowest remaining candidate with one. A preference not tried yet
 * is never replaced by a fallback: without a usable saved copy the comparison is pending.
 */
function chooseAmongSavedCandidates<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, preferredId: number, history: PriorSelection): ProviderChoice<P[K]> {
  const { request, source } = resolving;
  const providerRequest = request[provider];
  const name = PROVIDER_NAME[provider];
  const issues = preservedIssues(provider, request);
  const recorded = history.recordedUse;
  const preferredState = cachedPreferenceState(recorded, preferredId);
  const tried = preferredState !== "not-tried-yet";
  const savedAt = (id: number) => source.savedCatalogue(provider, id)?.downloadedAt;
  const usingId = chooseSavedCatalogue({ preferredId, candidates: providerRequest.candidates, now: request.resolvedAt, tried, downloadedAt: savedAt, gone: id => goneRecord(source, provider, id, request.resolvedAt) !== undefined });
  // The last scan had no catalogue for this provider, or judged it gone, so a recheck that finds none compares none either and keeps that status.
  const recordedStatus = request.previousComparison?.status?.[provider];
  if (usingId === undefined && tried && recordedStatus?.state === "total-failure" && recordedStatus.catalogue !== "saved")
    return { identity: preferredId, lookupSource: providerRequest.lookupSource, ...unchangedResolution, issues, ...(recordedStatus.catalogue === "gone" ? { gone: true as const } : {}) };
  if (usingId === undefined) return {
    identity: preferredId, lookupSource: providerRequest.lookupSource, ...unchangedResolution, issues, incomplete: true,
    warning: tried
      ? `No reported ${name} series has a saved catalogue from the last 60 days, so this show could not be rechecked from saved inputs. Last-good results were kept.`
      : `${name} series ${preferredId} has no saved catalogue from the last 60 days, so it could not be compared yet. Results from the previously compared catalogue were kept.`,
  };
  const saved = source.savedCatalogue(provider, usingId)!;
  // The recorded failure provenance, else an unresolved catalogue-refresh issue naming this same preferred series.
  const issue = history.refreshIssue;
  const preferredFailedAt = tried ? recorded?.preferredFailedAt : issue?.seriesId === preferredId ? issue.failedAt : undefined;
  const use = savedCatalogueUse({
    preferredId, usingId, preferredDownloadedAt: savedAt(preferredId) ?? (tried ? recorded?.preferredDownloadedAt : undefined),
    usingDownloadedAt: saved.downloadedAt, preferredFailedAt,
    ...(tried && recorded?.usingId === usingId ? { usingFailedAt: recorded.usingFailedAt } : {}),
  });
  return { identity: usingId, lookupSource: providerRequest.lookupSource, catalogue: comparedFrom(saved, "reused"), use: { action: "set", use }, obligation: NO_CHANGE, issues };
}
