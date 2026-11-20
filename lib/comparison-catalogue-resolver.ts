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

/**
 * One load attempt's outcome. Download and reuse report the original download time; reuse never renews it.
 * A TMDB catalogue reports the TVDB series it names, if any, as `associatedTvdbId`.
 */
export type CatalogueLoad<T> =
  | { outcome: "downloaded" | "reused"; id: number; catalogue: T; downloadedAt: string; associatedTvdbId?: number }
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
 * answer naming no series; `missing` means the evidence is not available (saved inputs only), so the
 * series cannot be resolved yet; `failed` is a lookup that failed. `cached` says the answer was not
 * requested in this attempt.
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
  /** The TMDB series associated with a TVDB series. A rejection is a failed association. */
  tmdbSeriesForTvdb(tvdbId: number): Promise<SeriesAssociation>;
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
  /** The providers' warnings for the show's result, in resolution order. */
  warnings: string[];
} & { [K in CatalogueProvider]: ProviderResolution<P[K]> };

/** One provider's progress, final once its candidate choice is: a provider-scoped patch to persist. */
export type ProviderProgress = { provider: CatalogueProvider; obligation: RefreshObligationChange };

export type ResolverDependencies<P extends CataloguePayloads> = {
  source: ComparisonCatalogueSource<P>;
  /**
   * The progress sink: persists one provider's obligation change before the other provider's work
   * starts, so an interruption between them loses no progress. Awaited; a rejection propagates as a
   * persistence failure, never as a provider failure. An acknowledged patch is final: the caller does
   * not reapply or roll it back, even when the overall outcome is pending.
   */
  onProviderResolved?: (progress: ProviderProgress) => Promise<void>;
};

/** The impact a Coverage Issue states when the preferred series could not be loaded. */
export function unavailablePreferredImpact(provider: CatalogueProvider, use: CatalogueUse) {
  return `${catalogueUseExplanation(provider, use)} ${PROVIDER_NAME[provider]} series ${use.preferredId} is retried every scan; the preference is kept.`;
}

/** Resolve both providers' comparison catalogues for one show. */
export async function resolveComparisonCatalogues<P extends CataloguePayloads>(request: ComparisonCatalogueRequest, dependencies: ResolverDependencies<P>): Promise<ComparisonCatalogueResolution<P>> {
  const identities: Record<CatalogueProvider, number | undefined> = { tmdb: request.tmdb.preferredId, tvdb: request.tvdb.preferredId };
  const resolved: Partial<Resolved<P>> = {};
  // Without a Plex TMDB ID, TMDB is derived from the TVDB series compared, so that is chosen first.
  const order: readonly CatalogueProvider[] = !request.tmdb.candidates.length && severalCandidates(request.tvdb) ? ["tvdb", "tmdb"] : PROVIDERS;
  for (const provider of order) {
    const resolution = await resolveProvider(provider, request, identities, resolved, dependencies.source);
    identities[provider] = resolution.identity;
    await dependencies.onProviderResolved?.({ provider, obligation: resolution.obligation });
    (resolved as Record<CatalogueProvider, ProviderResolution<unknown>>)[provider] = resolution;
  }
  const { tmdb, tvdb } = resolved as Resolved<P>;
  const missing = (resolution: ProviderResolution<unknown>) => (resolution.identity !== undefined && !resolution.catalogue) || !!resolution.incomplete;
  const pending = missing(tmdb) || missing(tvdb) || (tmdb.identity === undefined && tvdb.identity === undefined);
  const inOrder = order.map(provider => (resolved as Resolved<P>)[provider] as ProviderResolution<unknown>);
  return {
    outcome: pending ? "pending" : "comparable", resolutionOrder: order, comparisonOrder: PROVIDERS,
    unavailableCauses: inOrder.flatMap(resolution => resolution.unavailableCause ? [resolution.unavailableCause] : []),
    warnings: inOrder.flatMap(resolution => resolution.warning ? [resolution.warning] : []),
    tmdb, tvdb,
  };
}

type Resolved<P extends CataloguePayloads> = { [K in CatalogueProvider]: ProviderResolution<P[K]> };
type Failure = Extract<CatalogueLoad<unknown>, { outcome: "failed" }>;
const severalCandidates = (providerRequest: ProviderRequest) => new Set(providerRequest.candidates).size > 1;

/**
 * A failed load, carried through the shared fallback policy as its error. A load that throws instead
 * is a failed load too, as it is today; persistence the caller does after resolution is not a load.
 */
class FailedLoad {
  constructor(readonly failure: Failure) {}
}
const failureOf = (error: unknown): Failure => error instanceof FailedLoad ? error.failure : { outcome: "failed", error };
const comparedFrom = <T>(load: SavedCatalogue<T>, origin: ComparedCatalogue<T>["origin"]): ComparedCatalogue<T> =>
  ({ id: load.id, origin, downloadedAt: load.downloadedAt, catalogue: load.catalogue, ...(load.associatedTvdbId !== undefined ? { associatedTvdbId: load.associatedTvdbId } : {}) });

async function resolveProvider<P extends CataloguePayloads, K extends CatalogueProvider>(provider: K, request: ComparisonCatalogueRequest, identities: Record<CatalogueProvider, number | undefined>, resolved: Partial<Resolved<P>>, source: ComparisonCatalogueSource<P>): Promise<ProviderResolution<P[K]>> {
  const providerRequest = request[provider];
  const preferredId = providerRequest.preferredId;
  if (request.context.kind === "cached-recheck") return resolveCachedProvider(provider, request, request.context.history[provider], resolved, source);
  // A Plex-reported ID always wins: a series is derived only for a provider Plex reports none for.
  if (!providerRequest.candidates.length)
    return (provider === "tvdb" ? deriveTvdb(request, resolved.tmdb, source) : deriveTmdb(request, identities.tvdb, source)) as Promise<ProviderResolution<P[K]>>;
  const preferred = preferredId ?? Math.min(...providerRequest.candidates);
  return severalCandidates(providerRequest)
    ? chooseAmongCandidates(provider, preferred, request, identities, source)
    : singleIdCatalogue(provider, preferred, request, identities, source);
}

/**
 * A provider with one Plex ID (ADR-0003): its catalogue loads under the single-catalogue reuse policy,
 * and after a failed lookup its saved catalogue stays in use at any age. Any successful download
 * clears an open obligation, since the one ID is the preferred catalogue.
 */
async function singleIdCatalogue<P extends CataloguePayloads, K extends CatalogueProvider>(provider: K, id: number, request: ComparisonCatalogueRequest, identities: Record<CatalogueProvider, number | undefined>, source: ComparisonCatalogueSource<P>): Promise<ProviderResolution<P[K]>> {
  const providerRequest = request[provider];
  const load = await loadDerived(source, provider, id, providerRequest.refreshObligation);
  if (load.outcome !== "failed") return {
    identity: load.id, lookupSource: providerRequest.lookupSource, catalogue: comparedFrom(load, load.outcome),
    use: { action: "set", use: singleIdUse(load.id, true, undefined, load.downloadedAt) },
    obligation: loadedObligation(providerRequest, load.outcome), issues: catalogueIssues(provider, request, identities).resolvedIssues,
  };
  // Shares the derived series' failure: the saved catalogue at any age, else unavailable.
  const saved = source.savedCatalogue(provider, id);
  const use: CatalogueUseProposal = { action: "set", use: failedSingleIdUse(id, saved?.downloadedAt, request.resolvedAt) };
  return derivedFailure(provider, request, { ...identities, [provider]: id }, load, { kind: provider === "tmdb" ? "show" : "series", id }, providerRequest.lookupSource, saved, use);
}

/** A provider's catalogue-refresh and catalogue-fallback-refresh Coverage Issue IDs, and their values in today's shape. */
function catalogueIssues(provider: CatalogueProvider, request: ComparisonCatalogueRequest, identities: Record<CatalogueProvider, number | undefined>) {
  const name = PROVIDER_NAME[provider];
  const other = provider === "tmdb" ? "tvdb" : "tmdb";
  const refreshId = `catalogue-refresh:${name}:${request.show.ratingKey}`, fallbackId = `catalogue-fallback-refresh:${name}:${request.show.ratingKey}`;
  const issue = (input: { id: string; failure: Failure; seriesId: number | undefined; requested: { kind: string; id: number }; source: LookupSourceStep[]; impact: string; failedAt?: string }): CoverageIssue => ({
    id: input.id, ...(input.failedAt ? { failedAt: input.failedAt } : {}), ...(input.failure.causedBy?.length ? { causedBy: input.failure.causedBy } : {}),
    operation: "catalogue-refresh", provider: name, scope: "show",
    show: { ...request.show, [`${provider}Id`]: input.seriesId, [`${other}Id`]: identities[other] } as NonNullable<CoverageIssue["show"]>,
    ...providerLookupContext(input.failure.error, { source: input.failure.lookupSource || input.source, requested: { provider: name, ...input.requested } as Parameters<typeof providerLookupContext>[1]["requested"], impact: input.impact }),
  }) as CoverageIssue;
  const warning = (failure: Failure, fallback: string) => failure.error instanceof Error ? failure.error.message : fallback;
  const resolvedIssues: CatalogueIssueAction[] = [{ action: "resolve", id: refreshId }, { action: "resolve", id: fallbackId }];
  return { name, refreshId, fallbackId, issue, warning, resolvedIssues };
}

/** No series to derive: the provider compares nothing and its recorded use is cleared; a scan also resolves its catalogue issues. */
function noDerivedSeries(provider: CatalogueProvider, request: ComparisonCatalogueRequest, lookupSource: LookupSourceStep[] = []): ProviderResolution<never> {
  return { lookupSource, use: { action: "clear" }, obligation: "unchanged", issues: request.context.kind === "cached-recheck" ? [] : catalogueIssues(provider, request, { tmdb: undefined, tvdb: undefined }).resolvedIssues };
}

/** The TVDB series named by the TMDB catalogue in use, for a show Plex reports no TVDB ID for. */
async function deriveTvdb<P extends CataloguePayloads>(request: ComparisonCatalogueRequest, tmdb: ProviderResolution<P["tmdb"]> | undefined, source: ComparisonCatalogueSource<P>): Promise<ProviderResolution<P["tvdb"]>> {
  const compared = tmdb?.catalogue;
  const tvdbId = compared?.associatedTvdbId;
  if (!compared || tvdbId === undefined) return noDerivedSeries("tvdb", request);
  const lookupSource: LookupSourceStep[] = [...request.tmdb.lookupSource, { provider: "TMDB", kind: "external TVDB ID", id: tvdbId, cached: compared.origin !== "downloaded" }];
  const derivedUse = (downloadedAt?: string): CatalogueUseProposal => ({ action: "set", use: { usingId: tvdbId, state: "derived", derivedFrom: compared.id, ...(downloadedAt ? { usingDownloadedAt: downloadedAt } : {}) } });
  const identities = { tmdb: compared.id, tvdb: tvdbId };
  const load = request.context.kind === "cached-recheck" ? readSaved(source, "tvdb", tvdbId) : await loadDerived(source, "tvdb", tvdbId, request.tvdb.refreshObligation);
  if (!load) return missingFromSaved("tvdb", tvdbId, lookupSource);
  if (load.outcome !== "failed")
    return { identity: load.id, lookupSource, catalogue: comparedFrom(load, load.outcome), use: derivedUse(load.downloadedAt), obligation: loadedObligation(request.tvdb, load.outcome), issues: loadedIssues("tvdb", request, identities) };
  // A derived series whose load fails keeps its saved catalogue at any age, as a single Plex ID does.
  const saved = source.savedCatalogue("tvdb", tvdbId);
  return derivedFailure("tvdb", request, identities, load, { kind: "series", id: tvdbId }, lookupSource, saved, derivedUse(saved?.downloadedAt));
}

/** The TMDB series TMDB associates with the TVDB series in use, for a show Plex reports no TMDB ID for. */
async function deriveTmdb<P extends CataloguePayloads>(request: ComparisonCatalogueRequest, tvdbId: number | undefined, source: ComparisonCatalogueSource<P>): Promise<ProviderResolution<P["tmdb"]>> {
  if (tvdbId === undefined) return noDerivedSeries("tmdb", request);
  const plexStep: LookupSourceStep = { provider: "Plex", kind: "TVDB series", id: tvdbId };
  let association: SeriesAssociation;
  try { association = await source.tmdbSeriesForTvdb(tvdbId); } catch (error) { association = { outcome: "failed", error }; }
  if (association.outcome === "known-empty") return noDerivedSeries("tmdb", request, [plexStep]);
  // Saved inputs hold no failed lookups: a cached recheck never turns an unreadable association into one.
  if (association.outcome === "missing" || (association.outcome === "failed" && request.context.kind === "cached-recheck")) return {
    lookupSource: [plexStep], use: { action: "unchanged" }, obligation: "unchanged", issues: [], incomplete: true,
    warning: `TMDB's association for TVDB series ${tvdbId} is not saved, so its TMDB series could not be resolved from saved inputs. Last-good results were kept until the next Plex scan.`,
  };
  // A derived TMDB series that cannot be loaded keeps comparing the one last compared for this TVDB series, at any age.
  const previous = request.previousComparison;
  const retainedId = previous?.tvdbId === tvdbId ? previous.tmdbId : undefined;
  const saved = retainedId === undefined ? undefined : source.savedCatalogue("tmdb", retainedId);
  if (association.outcome === "failed") {
    const failure: Failure = { outcome: "failed", error: association.error, ...(association.causedBy ? { causedBy: association.causedBy } : {}) };
    return derivedFailure("tmdb", request, { tmdb: undefined, tvdb: tvdbId }, failure, { kind: "TVDB ID search", id: tvdbId }, [plexStep], saved, { action: "clear" });
  }
  const lookupSource: LookupSourceStep[] = [plexStep, { provider: "TMDB", kind: "resolved show", id: association.id, cached: association.cached }];
  const load = request.context.kind === "cached-recheck" ? readSaved(source, "tmdb", association.id) : await loadDerived(source, "tmdb", association.id, request.tmdb.refreshObligation);
  if (!load) return missingFromSaved("tmdb", association.id, lookupSource);
  if (load.outcome !== "failed") return {
    identity: load.id, lookupSource, catalogue: comparedFrom(load, load.outcome),
    use: { action: "set", use: { usingId: load.id, state: "derived", derivedFrom: tvdbId, usingDownloadedAt: load.downloadedAt } },
    obligation: loadedObligation(request.tmdb, load.outcome),
    issues: loadedIssues("tmdb", request, { tmdb: load.id, tvdb: tvdbId }),
  };
  // The series resolved before the failure is the one its Coverage Issue names, with its provenance.
  const resolvedId = load.resolvedId ?? association.id;
  return derivedFailure("tmdb", request, { tmdb: resolvedId, tvdb: tvdbId }, load, { kind: "show", id: resolvedId }, lookupSource, saved, { action: "clear" });
}

/** A derived series that loads resolves its catalogue issues in a scan; a cached recheck sets or resolves none. */
const loadedIssues = (provider: CatalogueProvider, request: ComparisonCatalogueRequest, identities: Record<CatalogueProvider, number | undefined>): CatalogueIssueAction[] =>
  request.context.kind === "cached-recheck" ? [] : catalogueIssues(provider, request, identities).resolvedIssues;

/** A derived series loads under the single-catalogue reuse policy: no 20-day refresh, mandatory while an obligation is open. */
async function loadDerived<P extends CataloguePayloads, K extends CatalogueProvider>(source: ComparisonCatalogueSource<P>, provider: K, id: number, mandatory: boolean): Promise<CatalogueLoad<P[K]>> {
  try { return await source.loadCatalogue(provider, id, { mandatory }); } catch (error) { return { outcome: "failed", error }; }
}

/** A derived series that loads clears an open obligation only by downloading; a failure to load it sets one. */
const loadedObligation = (providerRequest: ProviderRequest, outcome: "downloaded" | "reused"): RefreshObligationChange =>
  outcome === "downloaded" && providerRequest.refreshObligation ? "clear" : "unchanged";

/** The impact of a derived series that could not be loaded, as today's single-catalogue failure states it. */
function derivedFailureImpact(provider: CatalogueProvider, request: ComparisonCatalogueRequest, retained: boolean) {
  return `${PROVIDER_NAME[provider]} episode coverage could not be fully verified. ${retained ? "Last-good catalogue data was retained." : "No previous catalogue data is available."} ${request.previousComparison?.complete ? "Last-good comparison results remain available." : "No previous comparison results are available."}`;
}

/** A derived series that could not be resolved or loaded: its catalogue-refresh issue, and the saved catalogue kept (any age), if any. */
function derivedFailure<T>(provider: CatalogueProvider, request: ComparisonCatalogueRequest, identities: Record<CatalogueProvider, number | undefined>, failure: Failure, requested: { kind: string; id: number }, lookupSource: LookupSourceStep[], saved: SavedCatalogue<T> | undefined, use: CatalogueUseProposal): ProviderResolution<T> {
  const { refreshId, fallbackId, issue, warning } = catalogueIssues(provider, request, identities);
  const issues: CatalogueIssueAction[] = [
    { action: "set", issue: issue({ id: refreshId, failure, seriesId: identities[provider], requested, source: lookupSource, impact: derivedFailureImpact(provider, request, !!saved) }) },
    { action: "resolve", id: fallbackId },
  ];
  const message = warning(failure, provider === "tmdb" ? "TMDB lookup failed." : "Provider lookup failed.");
  const obligation: RefreshObligationChange = request[provider].refreshObligation ? "unchanged" : "set";
  const provenance = failure.lookupSource || lookupSource;
  if (saved) return { identity: saved.id, lookupSource: provenance, catalogue: comparedFrom(saved, "saved"), use, obligation, issues, warning: message };
  const identity = identities[provider];
  return { ...(identity !== undefined ? { identity } : {}), lookupSource: provenance, use, obligation, issues, unavailableCause: refreshId, warning: message };
}

/** A provider with several Plex candidates: preferred, its saved copy within 60 days, the lowest usable fallback, else unavailable. */
async function chooseAmongCandidates<P extends CataloguePayloads, K extends CatalogueProvider>(provider: K, preferredId: number, request: ComparisonCatalogueRequest, identities: Record<CatalogueProvider, number | undefined>, source: ComparisonCatalogueSource<P>): Promise<ProviderResolution<P[K]>> {
  const providerRequest = request[provider];
  const now = request.resolvedAt;
  const settings: CatalogueLoadSettings = { mandatory: providerRequest.refreshObligation, refreshAfter: MULTIPLE_ID_REFRESH_AGE };
  const choice: CatalogueChoice<ComparedCatalogue<P[K]>> = await chooseAvailableCatalogue<ComparedCatalogue<P[K]>>({
    preferredId, candidates: providerRequest.candidates, now,
    load: async id => {
      const load = await source.loadCatalogue(provider, id, settings);
      if (load.outcome === "failed") throw new FailedLoad(load);
      return { value: comparedFrom(load, load.outcome), downloadedAt: load.downloadedAt };
    },
    saved: id => {
      const saved = source.savedCatalogue(provider, id);
      return saved && { value: comparedFrom(saved, "saved"), downloadedAt: saved.downloadedAt };
    },
  });
  const use = multipleIdUse(choice, preferredId, source.savedCatalogue(provider, preferredId)?.downloadedAt, now);
  const catalogue = choice.loaded?.value;
  const identity = catalogue ? catalogue.id : preferredId;
  const kind = provider === "tmdb" ? "show" : "series";
  const { name, refreshId, fallbackId, issue, warning: warningOf } = catalogueIssues(provider, request, identities);
  const issues: CatalogueIssueAction[] = [];
  let warning: string | undefined, unavailableCause: string | undefined;
  if (choice.preferredError) {
    const failure = failureOf(choice.preferredError);
    issues.push({ action: "set", issue: issue({ id: refreshId, failure, seriesId: preferredId, requested: { kind, id: preferredId }, source: providerRequest.lookupSource, impact: unavailablePreferredImpact(provider, use), failedAt: now }) });
    if (!catalogue) {
      unavailableCause = refreshId;
      warning = warningOf(failure, `${name} lookup failed.`);
    }
  } else issues.push({ action: "resolve", id: refreshId });
  // A fallback compared from saved data after its own failed refresh is unverified too.
  if (choice.fallbackError && choice.usingId) {
    const failure = failureOf(choice.fallbackError);
    issues.push({ action: "set", issue: issue({ id: fallbackId, failure, seriesId: choice.usingId, requested: { kind, id: choice.usingId }, source: providerRequest.lookupSource, impact: catalogueUseExplanation(provider, use)! }) });
  } else issues.push({ action: "resolve", id: fallbackId });
  // Decided only now that candidate choice is final, so every load above used the obligation as it was.
  const obligation: RefreshObligationChange = choice.preferredError
    ? (providerRequest.refreshObligation ? "unchanged" : "set")
    : choice.state === "preferred" && catalogue?.origin === "downloaded" && providerRequest.refreshObligation ? "clear" : "unchanged";
  // A fallback keeps the preference's provenance, as today's scan does.
  return { identity, lookupSource: providerRequest.lookupSource, ...(catalogue ? { catalogue } : {}), use: { action: "set", use }, obligation, issues, ...(unavailableCause ? { unavailableCause } : {}), ...(warning ? { warning } : {}) };
}

/**
 * A provider in a cached recheck, from saved inputs only: nothing is loaded, no obligation changes and
 * no catalogue-refresh or catalogue-fallback-refresh issue is set or resolved. A provider with several
 * Plex candidates chooses among their saved copies; a derived series is derived again only when the
 * series it follows changed; anything else keeps the series last compared.
 */
function resolveCachedProvider<P extends CataloguePayloads, K extends CatalogueProvider>(provider: K, request: ComparisonCatalogueRequest, history: PriorSelection, resolved: Partial<Resolved<P>>, source: ComparisonCatalogueSource<P>): Promise<ProviderResolution<P[K]>> | ProviderResolution<P[K]> {
  const providerRequest = request[provider];
  const previous = request.previousComparison;
  if (!providerRequest.candidates.length) {
    const followed = provider === "tvdb" ? resolved.tmdb : resolved.tvdb;
    const followedId = provider === "tvdb" ? previous?.tmdbId : previous?.tvdbId;
    // Unchanged (or not yet chosen) selected IDs keep their saved derived identity without new evidence.
    if (!followed?.catalogue || followed.identity === followedId) return keepCompared(provider, request, source, keptDerivedSource(provider, request));
    return (provider === "tvdb" ? deriveTvdb(request, resolved.tmdb, source) : deriveTmdb(request, followed.identity, source)) as Promise<ProviderResolution<P[K]>>;
  }
  if (severalCandidates(providerRequest) && providerRequest.preferredId !== undefined) return chooseAmongSavedCandidates(provider, providerRequest.preferredId, request, history, source);
  return keepCompared(provider, request, source, providerRequest.lookupSource);
}

const unchangedResolution = { use: { action: "unchanged" }, obligation: "unchanged", issues: [] } as const;
const missingSavedCatalogue = (provider: CatalogueProvider, id: number) =>
  `Saved ${PROVIDER_NAME[provider]} catalogue ${id} is missing or incomplete. Run a Plex scan to download the ${PROVIDER_NAME[provider]} catalogue.`;

/** A cached read of a series' saved catalogue, as a reuse; absent when no usable copy is saved. */
function readSaved<P extends CataloguePayloads, K extends CatalogueProvider>(source: ComparisonCatalogueSource<P>, provider: K, id: number): CatalogueLoad<P[K]> | undefined {
  const saved = source.savedCatalogue(provider, id);
  return saved && { outcome: "reused", ...saved };
}

/** A series the cached recheck compares but cannot read: pending, with last-good results kept. */
function missingFromSaved(provider: CatalogueProvider, id: number, lookupSource: LookupSourceStep[]): ProviderResolution<never> {
  return { identity: id, lookupSource, ...unchangedResolution, issues: [], incomplete: true, warning: missingSavedCatalogue(provider, id) };
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
function keepCompared<P extends CataloguePayloads, K extends CatalogueProvider>(provider: K, request: ComparisonCatalogueRequest, source: ComparisonCatalogueSource<P>, lookupSource: LookupSourceStep[]): ProviderResolution<P[K]> {
  const id = provider === "tmdb" ? request.previousComparison?.tmdbId : request.previousComparison?.tvdbId;
  if (id === undefined) return { lookupSource: [], ...unchangedResolution, issues: [] };
  const saved = source.savedCatalogue(provider, id);
  if (!saved) return missingFromSaved(provider, id, lookupSource);
  return { identity: id, lookupSource, catalogue: comparedFrom(saved, "reused"), ...unchangedResolution, issues: [] };
}

/**
 * Several Plex candidates in a cached recheck: the preferred saved copy within 60 days, else, once a
 * scan has tried this preference, the lowest remaining candidate with one. An untried preference is
 * never replaced by a fallback: without a usable saved copy the comparison is pending.
 */
function chooseAmongSavedCandidates<P extends CataloguePayloads, K extends CatalogueProvider>(provider: K, preferredId: number, request: ComparisonCatalogueRequest, history: PriorSelection, source: ComparisonCatalogueSource<P>): ProviderResolution<P[K]> {
  const providerRequest = request[provider];
  const name = PROVIDER_NAME[provider];
  const recorded = history.recordedUse;
  const preference: "tried" | "not-tried-yet" = recorded?.preferredId === preferredId ? "tried" : "not-tried-yet";
  const savedAt = (id: number) => source.savedCatalogue(provider, id)?.downloadedAt;
  const usingId = chooseSavedCatalogue({ preferredId, candidates: providerRequest.candidates, now: request.resolvedAt, tried: preference === "tried", downloadedAt: savedAt });
  if (usingId === undefined) return {
    identity: preferredId, lookupSource: providerRequest.lookupSource, ...unchangedResolution, issues: [], incomplete: true,
    warning: preference === "tried"
      ? `No reported ${name} series has a saved catalogue from the last 60 days, so this show could not be rechecked from saved inputs. Last-good results were kept.`
      : `${name} series ${preferredId} has no saved catalogue from the last 60 days, so it could not be compared yet. Results from the previously compared catalogue were kept.`,
  };
  const saved = source.savedCatalogue(provider, usingId)!;
  // The recorded failure provenance, else an unresolved catalogue-refresh issue naming this same preferred series.
  const issue = history.refreshIssue;
  const preferredFailedAt = preference === "tried" ? recorded?.preferredFailedAt : issue?.seriesId === preferredId ? issue.failedAt : undefined;
  const use = savedCatalogueUse({
    preferredId, usingId, preferredDownloadedAt: savedAt(preferredId) ?? (preference === "tried" ? recorded?.preferredDownloadedAt : undefined),
    usingDownloadedAt: saved.downloadedAt, preferredFailedAt,
    ...(preference === "tried" && recorded?.usingId === usingId ? { usingFailedAt: recorded.usingFailedAt } : {}),
  });
  return { identity: usingId, lookupSource: providerRequest.lookupSource, catalogue: comparedFrom(saved, "reused"), use: { action: "set", use }, obligation: "unchanged", issues: [] };
}
