import { catalogueUseExplanation } from "@/lib/catalogue-description";
import { chooseAvailableCatalogue, chooseSavedCatalogue, failedSingleIdUse, multipleIdUse, savedCatalogueUse, singleIdUse, type CatalogueChoice } from "@/lib/catalogue-fallback";
import { PROVIDER_NAME, PROVIDERS, type CatalogueProvider } from "@/lib/catalogue-selection";
import type { CatalogueUse } from "@/lib/catalogue-selection-store";
import { providerLookupContext, type CoverageIssue, type LookupSourceStep } from "@/lib/coverage-issues";
import { MULTIPLE_ID_REFRESH_AGE } from "@/lib/plex-catalogue-policy";

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
 */
export type CatalogueLoad<T> =
  | {
      outcome: "downloaded" | "reused"; id: number; catalogue: T; downloadedAt: string; associatedTvdbId?: number;
      /** The lookup provenance of the series loaded, when the load extended it; the provider's identity then reports it. */
      lookupSource?: LookupSourceStep[];
    }
  | {
      outcome: "failed";
      error: unknown;
      /** A series ID resolved before the failure, which the Coverage Issue then names. */
      resolvedId?: number;
      /** Coverage Issue IDs this failure is caused by, such as provider authentication. */
      causedBy?: string[];
      /** The lookup provenance at the failure, when the attempt extended it. */
      lookupSource?: LookupSourceStep[];
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

/** The live scan downloads; a cached recheck reads saved inputs only, deciding from each provider's prior-selection history. */
export type ResolutionContext = { kind: "live-scan" } | { kind: "cached-recheck"; history: Record<CatalogueProvider, PriorSelection> };

export type ProviderRequest = {
  /** The series IDs Plex reports for this provider. */
  candidates: number[];
  /** The catalogue override, else the lowest Plex-reported ID. */
  preferredId?: number;
  /** Whether this provider has an open refresh obligation for the show. */
  refreshObligation: boolean;
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
  previousComparison?: { tmdbId?: number; tvdbId?: number; complete: boolean };
  tmdb: ProviderRequest;
  tvdb: ProviderRequest;
};

/** What the comparison runs against; `saved` is a saved copy compared because its load failed. */
export type ComparedCatalogue<T> = { id: number; origin: "downloaded" | "reused" | "saved"; downloadedAt: string; catalogue: T; associatedTvdbId?: number };

/** A proposed change to the provider's recorded catalogue use. */
export type CatalogueUseProposal = { action: "set"; use: CatalogueUse } | { action: "clear" } | { action: "unchanged" };

/** A catalogue Coverage Issue (catalogue-refresh or catalogue-fallback-refresh) and what to do with it. */
export type CatalogueIssueAction = { action: "set"; issue: CoverageIssue } | { action: "resolve"; id: string } | { action: "preserve"; id: string };

/**
 * The provider's refresh obligation change, relative to the obligation in the request. A preferred
 * failure sets it; only a downloaded preferred catalogue clears it; reuse and fallback downloads never do.
 */
export type RefreshObligationChange = "set" | "clear" | "unchanged";

export type ProviderResolution<T> = {
  /** The provider's series identity after resolution: the series compared, else the one that is unavailable. */
  identity?: number;
  /** How that identity was found (its lookup provenance), for this provider's later Coverage Issues; empty with no identity. */
  lookupSource: LookupSourceStep[];
  /** Absent when no catalogue is usable. */
  catalogue?: ComparedCatalogue<T>;
  use: CatalogueUseProposal;
  obligation: RefreshObligationChange;
  issues: CatalogueIssueAction[];
  /** The Coverage Issue ID that explains a missing catalogue, for the comparison-inputs issue's causes. */
  unavailableCause?: string;
  /** A warning for the show's result when no catalogue is usable or a derived series could not be loaded. */
  warning?: string;
  /** Saved evidence cannot resolve this provider's series, so the comparison is pending. */
  incomplete?: true;
};

export type ComparisonCatalogueResolution<P extends CataloguePayloads> = {
  /** `pending`: a provider with an identity has no usable catalogue, or its series cannot be resolved, so last-good results stay. */
  outcome: "comparable" | "pending";
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
export type ProviderProgress<P extends CataloguePayloads = CataloguePayloads> = {
  [K in CatalogueProvider]: { provider: K; obligation: RefreshObligationChange; catalogue?: ComparedCatalogue<P[K]> };
}[CatalogueProvider];

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
export const NO_PLEX_IDS_WARNING = "No TMDB or TVDB ID was exposed by Plex.";

/** The Coverage Issue impact of an unavailable preferred series, from the shared description of the catalogue in use. */
export function unavailablePreferredImpact(provider: CatalogueProvider, use: CatalogueUse) {
  return `${catalogueUseExplanation(provider, use)} ${PROVIDER_NAME[provider]} series ${use.preferredId} is retried every scan; the preference is kept.`;
}

/** Resolve both providers' comparison catalogues for one show. */
export async function resolveComparisonCatalogues<P extends CataloguePayloads>(request: ComparisonCatalogueRequest, dependencies: ResolverDependencies<P>): Promise<ComparisonCatalogueResolution<P>> {
  const resolving: Resolving<P> = { request, source: dependencies.source, identities: { tmdb: request.tmdb.preferredId, tvdb: request.tvdb.preferredId }, resolved: {} };
  // Without a Plex TMDB ID, TMDB is derived from the TVDB series compared, so that is chosen first.
  const order: readonly CatalogueProvider[] = !request.tmdb.candidates.length && severalCandidates(request.tvdb) ? ["tvdb", "tmdb"] : PROVIDERS;
  for (const provider of order) {
    const resolution = await resolveProvider(resolving, provider);
    resolving.identities[provider] = resolution.identity;
    try {
      await dependencies.onProviderResolved?.({ provider, obligation: resolution.obligation, ...(resolution.catalogue ? { catalogue: resolution.catalogue } : {}) } as ProviderProgress<P>);
    } catch (error) {
      throw new ProgressPersistenceError(provider, error);
    }
    (resolving.resolved as Record<CatalogueProvider, ProviderResolution<unknown>>)[provider] = resolution;
  }
  const { tmdb, tvdb } = resolving.resolved as Resolved<P>;
  const missing = (resolution: ProviderResolution<unknown>) => (resolution.identity !== undefined && !resolution.catalogue) || !!resolution.incomplete;
  const noIdentity = tmdb.identity === undefined && tvdb.identity === undefined;
  const pending = missing(tmdb) || missing(tvdb) || noIdentity;
  const inOrder = order.map(provider => (resolving.resolved as Resolved<P>)[provider] as ProviderResolution<unknown>);
  const noPlexIds = request.context.kind === "live-scan" && noIdentity && !request.tmdb.candidates.length && !request.tvdb.candidates.length;
  const pendingWarning = request.context.kind === "cached-recheck" ? cachedPendingWarning(request, resolving.resolved as Resolved<P>) : undefined;
  return {
    outcome: pending ? "pending" : "comparable", resolutionOrder: order, comparisonOrder: PROVIDERS,
    unavailableCauses: inOrder.flatMap(resolution => resolution.unavailableCause ? [resolution.unavailableCause] : []),
    warnings: [...inOrder.flatMap(resolution => resolution.warning ? [resolution.warning] : []), ...(noPlexIds ? [NO_PLEX_IDS_WARNING] : [])],
    tmdb, tvdb, ...(pendingWarning !== undefined ? { pendingWarning } : {}),
  };
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
/** Per provider: what a series request is called, and the other provider. */
const PROVIDER_TERMS: Record<CatalogueProvider, { requestedKind: RequestedKind; other: CatalogueProvider }> = {
  tmdb: { requestedKind: "show", other: "tvdb" },
  tvdb: { requestedKind: "series", other: "tmdb" },
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
 * is a failed load too, as in the scan; persistence the caller does after resolution is not a load.
 */
class FailedLoad {
  constructor(readonly failure: Failure) {}
}
const failureOf = (error: unknown): Failure => error instanceof FailedLoad ? error.failure : { outcome: "failed", error };
const comparedFrom = <T>(load: SavedCatalogue<T>, origin: ComparedCatalogue<T>["origin"]): ComparedCatalogue<T> =>
  ({ id: load.id, origin, downloadedAt: load.downloadedAt, catalogue: load.catalogue, ...(load.associatedTvdbId !== undefined ? { associatedTvdbId: load.associatedTvdbId } : {}) });

async function resolveProvider<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K): Promise<ProviderResolution<P[K]>> {
  const { request } = resolving;
  const providerRequest = request[provider];
  if (request.context.kind === "cached-recheck") return resolveCachedProvider(resolving, provider, request.context.history[provider]);
  // A Plex-reported ID always wins: a series is derived only for a provider Plex reports none for.
  if (!providerRequest.candidates.length)
    return (provider === "tvdb" ? deriveTvdb(resolving) : deriveTmdb(resolving, resolving.identities.tvdb)) as Promise<ProviderResolution<P[K]>>;
  const preferred = providerRequest.preferredId ?? Math.min(...providerRequest.candidates);
  return severalCandidates(providerRequest) ? chooseAmongCandidates(resolving, provider, preferred) : singleIdCatalogue(resolving, provider, preferred);
}

/**
 * A provider with one Plex ID (ADR-0003): its catalogue loads under the single-catalogue reuse policy,
 * and after a failed lookup its saved catalogue stays in use at any age. Any successful download
 * clears an open obligation, since the one ID is the preferred catalogue.
 */
async function singleIdCatalogue<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, id: number): Promise<ProviderResolution<P[K]>> {
  const { request, source, identities } = resolving;
  const providerRequest = request[provider];
  const load = await loadSingleCatalogue(source, provider, id, providerRequest.refreshObligation);
  if (load.outcome !== "failed") return {
    identity: load.id, lookupSource: load.lookupSource ?? providerRequest.lookupSource, catalogue: comparedFrom(load, load.outcome),
    use: { action: "set", use: singleIdUse(load.id, true, undefined, load.downloadedAt) },
    obligation: loadedObligation(providerRequest, load.outcome), issues: resolvedIssues(provider, request),
  };
  // Shares the derived series' failure: the saved catalogue at any age, else unavailable.
  const saved = source.savedCatalogue(provider, id);
  const use: CatalogueUseProposal = { action: "set", use: failedSingleIdUse(id, saved?.downloadedAt, request.resolvedAt) };
  return singleCatalogueFailure(provider, request, { ...identities, [provider]: id }, load, { kind: PROVIDER_TERMS[provider].requestedKind, id }, { lookupSource: providerRequest.lookupSource, saved, use });
}

/** A provider's catalogue-refresh and catalogue-fallback-refresh Coverage Issue IDs. */
function catalogueIssueIds(provider: CatalogueProvider, request: ComparisonCatalogueRequest) {
  const name = PROVIDER_NAME[provider];
  return { refreshId: `catalogue-refresh:${name}:${request.show.ratingKey}`, fallbackId: `catalogue-fallback-refresh:${name}:${request.show.ratingKey}` };
}

/** Both catalogue issues resolved: the provider's catalogue loaded, or it has no series. */
function resolvedIssues(provider: CatalogueProvider, request: ComparisonCatalogueRequest): CatalogueIssueAction[] {
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request);
  return [{ action: "resolve", id: refreshId }, { action: "resolve", id: fallbackId }];
}

/** Both catalogue issues kept as they are: a cached recheck, or a series not yet resolvable, never sets or resolves one. */
function preservedIssues(provider: CatalogueProvider, request: ComparisonCatalogueRequest): CatalogueIssueAction[] {
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request);
  return [{ action: "preserve", id: refreshId }, { action: "preserve", id: fallbackId }];
}

/** A provider's catalogue-refresh Coverage Issue value, in the shape the scan sets it. */
function catalogueIssue(provider: CatalogueProvider, request: ComparisonCatalogueRequest, identities: Identities, input: { id: string; failure: Failure; seriesId: number | undefined; requested: { kind: RequestedKind; id: number }; source: LookupSourceStep[]; impact: string; failedAt?: string }): CoverageIssue {
  const name = PROVIDER_NAME[provider];
  const ids = { ...identities, [provider]: input.seriesId };
  return {
    id: input.id, ...(input.failedAt ? { failedAt: input.failedAt } : {}), ...(input.failure.causedBy?.length ? { causedBy: input.failure.causedBy } : {}),
    operation: "catalogue-refresh", provider: name, scope: "show",
    show: { ...request.show, tmdbId: ids.tmdb, tvdbId: ids.tvdb },
    ...providerLookupContext(input.failure.error, { source: input.failure.lookupSource || input.source, requested: { provider: name, ...input.requested }, impact: input.impact }),
  } as CoverageIssue;
}

const failureWarning = (failure: Failure, fallback: string) => failure.error instanceof Error ? failure.error.message : fallback;

/** No series to derive: the provider compares nothing and its recorded use is cleared; a scan also resolves its catalogue issues. */
function noDerivedSeries(provider: CatalogueProvider, request: ComparisonCatalogueRequest, lookupSource: LookupSourceStep[] = []): ProviderResolution<never> {
  return { lookupSource, use: { action: "clear" }, obligation: "unchanged", issues: loadedIssues(provider, request) };
}

/** The TVDB series named by the TMDB catalogue in use, for a show Plex reports no TVDB ID for. */
async function deriveTvdb<P extends CataloguePayloads>(resolving: Resolving<P>): Promise<ProviderResolution<P["tvdb"]>> {
  const { request, source } = resolving;
  const compared = resolving.resolved.tmdb?.catalogue;
  const tvdbId = compared?.associatedTvdbId;
  if (!compared || tvdbId === undefined) return noDerivedSeries("tvdb", request);
  const lookupSource: LookupSourceStep[] = [...request.tmdb.lookupSource, { provider: "TMDB", kind: "external TVDB ID", id: tvdbId, cached: compared.origin !== "downloaded" }];
  const derivedUse = (downloadedAt?: string): CatalogueUseProposal => ({ action: "set", use: { usingId: tvdbId, state: "derived", derivedFrom: compared.id, ...(downloadedAt ? { usingDownloadedAt: downloadedAt } : {}) } });
  const identities = { tmdb: compared.id, tvdb: tvdbId };
  const load = request.context.kind === "cached-recheck" ? readSaved(source, "tvdb", tvdbId) : await loadSingleCatalogue(source, "tvdb", tvdbId, request.tvdb.refreshObligation);
  if (!load) return missingFromSaved("tvdb", request, tvdbId, lookupSource);
  if (load.outcome !== "failed")
    return { identity: load.id, lookupSource: load.lookupSource ?? lookupSource, catalogue: comparedFrom(load, load.outcome), use: derivedUse(load.downloadedAt), obligation: loadedObligation(request.tvdb, load.outcome), issues: loadedIssues("tvdb", request) };
  // A derived series whose load fails keeps its saved catalogue at any age, as a single Plex ID does.
  const saved = source.savedCatalogue("tvdb", tvdbId);
  return singleCatalogueFailure("tvdb", request, identities, load, { kind: "series", id: tvdbId }, { lookupSource, saved, use: derivedUse(saved?.downloadedAt) });
}

/**
 * TMDB's association for a TVDB series. It may come from saved evidence unless a refresh obligation
 * is open; a live scan requests one that saved evidence cannot answer. A cached recheck never requests.
 */
async function seriesAssociation<P extends CataloguePayloads>(resolving: Resolving<P>, tvdbId: number): Promise<SeriesAssociation> {
  const ask = async (mandatory: boolean): Promise<SeriesAssociation> => {
    try { return await resolving.source.tmdbSeriesForTvdb(tvdbId, { mandatory }); } catch (error) { return { outcome: "failed", error }; }
  };
  if (resolving.request.context.kind === "cached-recheck") return ask(false);
  const mandatory = resolving.request.tmdb.refreshObligation;
  const association = await ask(mandatory);
  return association.outcome === "missing" && !mandatory ? ask(true) : association;
}

/** The TMDB series TMDB associates with the TVDB series in use, for a show Plex reports no TMDB ID for. */
async function deriveTmdb<P extends CataloguePayloads>(resolving: Resolving<P>, tvdbId: number | undefined): Promise<ProviderResolution<P["tmdb"]>> {
  const { request, source } = resolving;
  if (tvdbId === undefined) return noDerivedSeries("tmdb", request);
  const plexStep: LookupSourceStep = { provider: "Plex", kind: "TVDB series", id: tvdbId };
  const association = await seriesAssociation(resolving, tvdbId);
  if (association.outcome === "known-empty") return noDerivedSeries("tmdb", request, [plexStep]);
  // Saved inputs hold no failed lookups: a cached recheck never turns an unreadable association into one.
  if (association.outcome === "missing" || (association.outcome === "failed" && request.context.kind === "cached-recheck")) return {
    lookupSource: [plexStep], use: { action: "unchanged" }, obligation: "unchanged", issues: preservedIssues("tmdb", request), incomplete: true,
    warning: `TMDB's association for TVDB series ${tvdbId} is not saved, so its TMDB series could not be resolved from saved inputs. Last-good results were kept until the next Plex scan.`,
  };
  // A derived TMDB series that cannot be loaded keeps comparing the one last compared for this TVDB series, at any age.
  const previous = request.previousComparison;
  const retainedId = previous?.tvdbId === tvdbId ? previous.tmdbId : undefined;
  const saved = retainedId === undefined ? undefined : source.savedCatalogue("tmdb", retainedId);
  if (association.outcome === "failed") {
    const failure: Failure = { outcome: "failed", error: association.error, ...(association.causedBy ? { causedBy: association.causedBy } : {}) };
    return singleCatalogueFailure("tmdb", request, { tmdb: undefined, tvdb: tvdbId }, failure, { kind: "TVDB ID search", id: tvdbId }, { lookupSource: [plexStep], saved, use: { action: "clear" } });
  }
  const lookupSource: LookupSourceStep[] = [plexStep, { provider: "TMDB", kind: "resolved show", id: association.id, cached: association.cached }];
  const load = request.context.kind === "cached-recheck" ? readSaved(source, "tmdb", association.id) : await loadSingleCatalogue(source, "tmdb", association.id, request.tmdb.refreshObligation);
  if (!load) return missingFromSaved("tmdb", request, association.id, lookupSource);
  if (load.outcome !== "failed") return {
    identity: load.id, lookupSource: load.lookupSource ?? lookupSource, catalogue: comparedFrom(load, load.outcome),
    use: { action: "set", use: { usingId: load.id, state: "derived", derivedFrom: tvdbId, usingDownloadedAt: load.downloadedAt } },
    obligation: loadedObligation(request.tmdb, load.outcome),
    issues: loadedIssues("tmdb", request),
  };
  // The series resolved before the failure is the one its Coverage Issue names, with its provenance.
  const resolvedId = load.resolvedId ?? association.id;
  return singleCatalogueFailure("tmdb", request, { tmdb: resolvedId, tvdb: tvdbId }, load, { kind: "show", id: resolvedId }, { lookupSource, saved, use: { action: "clear" } });
}

/** A series that loads, or a provider with no series, resolves its catalogue issues in a scan; a cached recheck preserves them. */
const loadedIssues = (provider: CatalogueProvider, request: ComparisonCatalogueRequest): CatalogueIssueAction[] =>
  request.context.kind === "cached-recheck" ? preservedIssues(provider, request) : resolvedIssues(provider, request);

/** A single Plex ID or derived series loads under the single-catalogue reuse policy: no 20-day refresh, mandatory while an obligation is open. */
async function loadSingleCatalogue<P extends CataloguePayloads, K extends CatalogueProvider>(source: ComparisonCatalogueSource<P>, provider: K, id: number, mandatory: boolean): Promise<CatalogueLoad<P[K]>> {
  try { return await source.loadCatalogue(provider, id, { mandatory }); } catch (error) { return { outcome: "failed", error }; }
}

/** A single catalogue that loads clears an open obligation only by downloading. */
const loadedObligation = (providerRequest: ProviderRequest, outcome: "downloaded" | "reused"): RefreshObligationChange =>
  outcome === "downloaded" && providerRequest.refreshObligation ? "clear" : "unchanged";

/** A preferred catalogue that could not be loaded sets the obligation, unless one is already open. */
const failedObligation = (providerRequest: ProviderRequest): RefreshObligationChange => providerRequest.refreshObligation ? "unchanged" : "set";

/** The impact of a single catalogue that could not be loaded, as the scan's single-catalogue failure states it. */
function singleCatalogueFailureImpact(provider: CatalogueProvider, request: ComparisonCatalogueRequest, retained: boolean) {
  return `${PROVIDER_NAME[provider]} episode coverage could not be fully verified. ${retained ? "Last-good catalogue data was retained." : "No previous catalogue data is available."} ${request.previousComparison?.complete ? "Last-good comparison results remain available." : "No previous comparison results are available."}`;
}

/**
 * A single Plex ID or derived series that could not be resolved or loaded: its catalogue-refresh issue,
 * and the saved catalogue kept (any age), if any.
 */
function singleCatalogueFailure<T>(provider: CatalogueProvider, request: ComparisonCatalogueRequest, identities: Identities, failure: Failure, requested: { kind: RequestedKind; id: number }, kept: { lookupSource: LookupSourceStep[]; saved: SavedCatalogue<T> | undefined; use: CatalogueUseProposal }): ProviderResolution<T> {
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request);
  const { lookupSource, saved, use } = kept;
  const issues: CatalogueIssueAction[] = [
    { action: "set", issue: catalogueIssue(provider, request, identities, { id: refreshId, failure, seriesId: identities[provider], requested, source: lookupSource, impact: singleCatalogueFailureImpact(provider, request, !!saved) }) },
    { action: "resolve", id: fallbackId },
  ];
  const warning = failureWarning(failure, provider === "tmdb" ? "TMDB lookup failed." : "Provider lookup failed.");
  const obligation = failedObligation(request[provider]);
  const provenance = failure.lookupSource || lookupSource;
  if (saved) return { identity: saved.id, lookupSource: provenance, catalogue: comparedFrom(saved, "saved"), use, obligation, issues, warning };
  const identity = identities[provider];
  return { ...(identity !== undefined ? { identity } : {}), lookupSource: provenance, use, obligation, issues, unavailableCause: refreshId, warning };
}

/** A provider with several Plex candidates: preferred, its saved copy within 60 days, the lowest usable fallback, else unavailable. */
async function chooseAmongCandidates<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, preferredId: number): Promise<ProviderResolution<P[K]>> {
  const { request, source, identities } = resolving;
  const providerRequest = request[provider];
  const now = request.resolvedAt;
  const settings: CatalogueLoadSettings = { mandatory: providerRequest.refreshObligation, refreshAfter: MULTIPLE_ID_REFRESH_AGE };
  let preferredProvenance: LookupSourceStep[] | undefined;
  const choice: CatalogueChoice<ComparedCatalogue<P[K]>> = await chooseAvailableCatalogue<ComparedCatalogue<P[K]>>({
    preferredId, candidates: providerRequest.candidates, now,
    load: async id => {
      const load = await source.loadCatalogue(provider, id, settings);
      if (load.outcome === "failed") throw new FailedLoad(load);
      if (id === preferredId) preferredProvenance = load.lookupSource;
      return { value: comparedFrom(load, load.outcome), downloadedAt: load.downloadedAt };
    },
    saved: id => {
      const saved = source.savedCatalogue(provider, id);
      return saved && { value: comparedFrom(saved, "saved"), downloadedAt: saved.downloadedAt };
    },
  });
  const preferredState: CandidateState = choice.preferredError ? "failed-this-attempt" : "loaded";
  // The preferred series' download time comes from its saved record, even one too incomplete to compare.
  const use = multipleIdUse(choice, preferredId, source.savedRecordDownloadedAt(provider, preferredId), now);
  const catalogue = choice.loaded?.value;
  const identity = catalogue ? catalogue.id : preferredId;
  const kind = PROVIDER_TERMS[provider].requestedKind;
  const { refreshId, fallbackId } = catalogueIssueIds(provider, request);
  const issues: CatalogueIssueAction[] = [];
  let warning: string | undefined, unavailableCause: string | undefined;
  if (preferredState === "failed-this-attempt") {
    const failure = failureOf(choice.preferredError);
    issues.push({ action: "set", issue: catalogueIssue(provider, request, identities, { id: refreshId, failure, seriesId: preferredId, requested: { kind, id: preferredId }, source: providerRequest.lookupSource, impact: unavailablePreferredImpact(provider, use), failedAt: now }) });
    if (!catalogue) {
      unavailableCause = refreshId;
      warning = failureWarning(failure, `${PROVIDER_NAME[provider]} lookup failed.`);
    }
  } else issues.push({ action: "resolve", id: refreshId });
  // A fallback compared from saved data after its own failed refresh is unverified too.
  if (choice.fallbackError && choice.usingId) {
    const failure = failureOf(choice.fallbackError);
    issues.push({ action: "set", issue: catalogueIssue(provider, request, identities, { id: fallbackId, failure, seriesId: choice.usingId, requested: { kind, id: choice.usingId }, source: providerRequest.lookupSource, impact: catalogueUseExplanation(provider, use)! }) });
  } else issues.push({ action: "resolve", id: fallbackId });
  // Decided only now that candidate choice is final, so every load above used the obligation as it was.
  const obligation: RefreshObligationChange = preferredState === "failed-this-attempt"
    ? failedObligation(providerRequest)
    : catalogue?.origin === "downloaded" && providerRequest.refreshObligation ? "clear" : "unchanged";
  // A fallback keeps the preference's provenance, as the scan does.
  const lookupSource = (preferredState === "loaded" && preferredProvenance) || providerRequest.lookupSource;
  return { identity, lookupSource, ...(catalogue ? { catalogue } : {}), use: { action: "set", use }, obligation, issues, ...(unavailableCause ? { unavailableCause } : {}), ...(warning ? { warning } : {}) };
}

/**
 * A provider in a cached recheck, from saved inputs only: nothing is loaded, no obligation changes and
 * every catalogue-refresh and catalogue-fallback-refresh issue is preserved. A provider with several
 * Plex candidates chooses among their saved copies; a derived series is derived again only when the
 * series it follows changed; anything else keeps the series last compared.
 */
function resolveCachedProvider<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, history: PriorSelection): Promise<ProviderResolution<P[K]>> | ProviderResolution<P[K]> {
  const { request, resolved } = resolving;
  const providerRequest = request[provider];
  const previous = request.previousComparison;
  if (!providerRequest.candidates.length) {
    const followedProvider = PROVIDER_TERMS[provider].other;
    const followed = resolved[followedProvider];
    const followedId = previous?.[`${followedProvider}Id`];
    // Unchanged (or not yet chosen) selected IDs keep their saved derived identity without new evidence.
    if (!followed?.catalogue || followed.identity === followedId) return keepCompared(resolving, provider, keptDerivedSource(provider, request));
    return (provider === "tvdb" ? deriveTvdb(resolving) : deriveTmdb(resolving, followed.identity)) as Promise<ProviderResolution<P[K]>>;
  }
  if (severalCandidates(providerRequest) && providerRequest.preferredId !== undefined) return chooseAmongSavedCandidates(resolving, provider, providerRequest.preferredId, history);
  return keepCompared(resolving, provider, providerRequest.lookupSource);
}

const unchangedResolution = { use: { action: "unchanged" }, obligation: "unchanged" } as const;
const missingSavedCatalogue = (provider: CatalogueProvider, id: number) =>
  `Saved ${PROVIDER_NAME[provider]} catalogue ${id} is missing or incomplete. Run a Plex scan to download the ${PROVIDER_NAME[provider]} catalogue.`;

/** A cached read of a series' saved catalogue, as a reuse; absent when no usable copy is saved. */
function readSaved<P extends CataloguePayloads, K extends CatalogueProvider>(source: ComparisonCatalogueSource<P>, provider: K, id: number): CatalogueLoad<P[K]> | undefined {
  const saved = source.savedCatalogue(provider, id);
  return saved && { outcome: "reused", ...saved };
}

/** A series the cached recheck compares but cannot read: pending, with last-good results kept. */
function missingFromSaved(provider: CatalogueProvider, request: ComparisonCatalogueRequest, id: number, lookupSource: LookupSourceStep[]): ProviderResolution<never> {
  return { identity: id, lookupSource, ...unchangedResolution, issues: preservedIssues(provider, request), incomplete: true, warning: missingSavedCatalogue(provider, id) };
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
function keepCompared<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, lookupSource: LookupSourceStep[]): ProviderResolution<P[K]> {
  const { request, source } = resolving;
  const issues = preservedIssues(provider, request);
  const id = request.previousComparison?.[`${provider}Id`];
  if (id === undefined) return { lookupSource: [], ...unchangedResolution, issues };
  const saved = source.savedCatalogue(provider, id);
  if (!saved) return missingFromSaved(provider, request, id, lookupSource);
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
function chooseAmongSavedCandidates<P extends CataloguePayloads, K extends CatalogueProvider>(resolving: Resolving<P>, provider: K, preferredId: number, history: PriorSelection): ProviderResolution<P[K]> {
  const { request, source } = resolving;
  const providerRequest = request[provider];
  const name = PROVIDER_NAME[provider];
  const issues = preservedIssues(provider, request);
  const recorded = history.recordedUse;
  const preferredState = cachedPreferenceState(recorded, preferredId);
  const tried = preferredState !== "not-tried-yet";
  const savedAt = (id: number) => source.savedCatalogue(provider, id)?.downloadedAt;
  const usingId = chooseSavedCatalogue({ preferredId, candidates: providerRequest.candidates, now: request.resolvedAt, tried, downloadedAt: savedAt });
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
  return { identity: usingId, lookupSource: providerRequest.lookupSource, catalogue: comparedFrom(saved, "reused"), use: { action: "set", use }, obligation: "unchanged", issues };
}
