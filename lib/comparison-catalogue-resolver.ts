import { catalogueUseExplanation } from "@/lib/catalogue-description";
import { chooseAvailableCatalogue, multipleIdUse, type CatalogueChoice } from "@/lib/catalogue-fallback";
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

/** One load attempt's outcome. Download and reuse report the original download time; reuse never renews it. */
export type CatalogueLoad<T> =
  | { outcome: "downloaded" | "reused"; id: number; catalogue: T; downloadedAt: string }
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
export type SavedCatalogue<T> = { id: number; catalogue: T; downloadedAt: string };

/** Where the resolver gets catalogues: the live scan's downloading source or the cached recheck's saved one. */
export type ComparisonCatalogueSource<P extends CataloguePayloads> = {
  /** Load a series' catalogue, downloading or reusing it as the settings and the source's freshness policy decide. */
  loadCatalogue<K extends CatalogueProvider>(provider: K, id: number, settings: CatalogueLoadSettings): Promise<CatalogueLoad<P[K]>>;
  /** A series' saved catalogue, at any age, if a usable one is saved. */
  savedCatalogue<K extends CatalogueProvider>(provider: K, id: number): SavedCatalogue<P[K]> | undefined;
};

/** The live scan downloads; a cached recheck reads saved inputs only. */
export type ResolutionContext = { kind: "live-scan" } | { kind: "cached-recheck" };

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
  tmdb: ProviderRequest;
  tvdb: ProviderRequest;
};

/** What the comparison runs against; `saved` is a saved copy compared because its load failed. */
export type ComparedCatalogue<T> = { id: number; origin: "downloaded" | "reused" | "saved"; downloadedAt: string; catalogue: T };

/** A proposed change to the provider's recorded catalogue use. */
export type CatalogueUseProposal = { action: "set"; use: CatalogueUse } | { action: "clear" } | { action: "unchanged" };

/** A catalogue Coverage Issue (catalogue-refresh or catalogue-fallback-refresh) and what to do with it. */
export type CatalogueIssueAction = { action: "set"; issue: CoverageIssue } | { action: "resolve"; id: string } | { action: "preserve"; id: string };

export type ProviderResolution<T> = {
  /** The provider's series identity after resolution: the series compared, else the one that is unavailable. */
  identity?: number;
  /** Absent when no catalogue is usable. */
  catalogue?: ComparedCatalogue<T>;
  use: CatalogueUseProposal;
  issues: CatalogueIssueAction[];
  /** The Coverage Issue ID that explains a missing catalogue, for the comparison-inputs issue's causes. */
  unavailableCause?: string;
  /** A warning for the show's result when no catalogue is usable. */
  warning?: string;
};

export type ComparisonCatalogueResolution<P extends CataloguePayloads> = {
  /** `pending`: a provider with an identity has no usable catalogue, so last-good results stay. */
  outcome: "comparable" | "pending";
} & { [K in CatalogueProvider]: ProviderResolution<P[K]> };

export type ResolverDependencies<P extends CataloguePayloads> = {
  source: ComparisonCatalogueSource<P>;
};

/** The impact a Coverage Issue states when the preferred series could not be loaded. */
export function unavailablePreferredImpact(provider: CatalogueProvider, use: CatalogueUse) {
  return `${catalogueUseExplanation(provider, use)} ${PROVIDER_NAME[provider]} series ${use.preferredId} is retried every scan; the preference is kept.`;
}

/** Resolve both providers' comparison catalogues for one show. */
export async function resolveComparisonCatalogues<P extends CataloguePayloads>(request: ComparisonCatalogueRequest, dependencies: ResolverDependencies<P>): Promise<ComparisonCatalogueResolution<P>> {
  const identities: Record<CatalogueProvider, number | undefined> = { tmdb: request.tmdb.preferredId, tvdb: request.tvdb.preferredId };
  const resolved: Partial<{ [K in CatalogueProvider]: ProviderResolution<P[K]> }> = {};
  for (const provider of PROVIDERS) {
    const resolution = await resolveProvider(provider, request, identities, dependencies.source);
    identities[provider] = resolution.identity;
    (resolved as Record<CatalogueProvider, ProviderResolution<unknown>>)[provider] = resolution;
  }
  const { tmdb, tvdb } = resolved as { [K in CatalogueProvider]: ProviderResolution<P[K]> };
  const missing = (resolution: ProviderResolution<unknown>) => resolution.identity !== undefined && !resolution.catalogue;
  const pending = missing(tmdb) || missing(tvdb) || (tmdb.identity === undefined && tvdb.identity === undefined);
  return { outcome: pending ? "pending" : "comparable", tmdb, tvdb };
}

/**
 * A failed load, carried through the shared fallback policy as its error. A load that throws instead
 * is a failed load too, as it is today; persistence the caller does after resolution is not a load.
 */
class FailedLoad {
  constructor(readonly failure: Extract<CatalogueLoad<unknown>, { outcome: "failed" }>) {}
}
const failureOf = (error: unknown) => error instanceof FailedLoad ? error.failure : { outcome: "failed" as const, error };

async function resolveProvider<P extends CataloguePayloads, K extends CatalogueProvider>(provider: K, request: ComparisonCatalogueRequest, identities: Record<CatalogueProvider, number | undefined>, source: ComparisonCatalogueSource<P>): Promise<ProviderResolution<P[K]>> {
  const providerRequest = request[provider];
  const preferredId = providerRequest.preferredId;
  if (request.context.kind !== "live-scan") throw new Error("The comparison catalogue resolver does not yet resolve a cached recheck.");
  if (new Set(providerRequest.candidates).size < 2 || preferredId === undefined)
    throw new Error(`The comparison catalogue resolver does not yet resolve a ${PROVIDER_NAME[provider]} provider without several Plex candidates.`);
  return chooseAmongCandidates(provider, preferredId, request, identities, source);
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
      return { value: { id: load.id, origin: load.outcome, downloadedAt: load.downloadedAt, catalogue: load.catalogue }, downloadedAt: load.downloadedAt };
    },
    saved: id => {
      const saved = source.savedCatalogue(provider, id);
      return saved && { value: { id: saved.id, origin: "saved", downloadedAt: saved.downloadedAt, catalogue: saved.catalogue }, downloadedAt: saved.downloadedAt };
    },
  });
  const use = multipleIdUse(choice, preferredId, source.savedCatalogue(provider, preferredId)?.downloadedAt, now);
  const name = PROVIDER_NAME[provider];
  const catalogue = choice.loaded?.value;
  const identity = catalogue ? catalogue.id : preferredId;
  const other = provider === "tmdb" ? "tvdb" : "tmdb";
  const showIds = (id: number) => ({ ...request.show, [`${provider}Id`]: id, [`${other}Id`]: identities[other] }) as NonNullable<CoverageIssue["show"]>;
  const kind = provider === "tmdb" ? "show" : "series";
  const issueId = `catalogue-refresh:${name}:${request.show.ratingKey}`, fallbackIssueId = `catalogue-fallback-refresh:${name}:${request.show.ratingKey}`;
  const issue = (id: string, failure: ReturnType<typeof failureOf>, seriesId: number, impact: string, failedAt?: string): CoverageIssue => ({
    id, ...(failedAt ? { failedAt } : {}), ...(failure.causedBy?.length ? { causedBy: failure.causedBy } : {}),
    operation: "catalogue-refresh", provider: name, scope: "show", show: showIds(seriesId),
    ...providerLookupContext(failure.error, { source: failure.lookupSource || providerRequest.lookupSource, requested: { provider: name, kind, id: seriesId }, impact }),
  }) as CoverageIssue;
  const issues: CatalogueIssueAction[] = [];
  let warning: string | undefined, unavailableCause: string | undefined;
  if (choice.preferredError) {
    const failure = failureOf(choice.preferredError);
    issues.push({ action: "set", issue: issue(issueId, failure, preferredId, unavailablePreferredImpact(provider, use), now) });
    if (!catalogue) {
      unavailableCause = issueId;
      warning = failure.error instanceof Error ? failure.error.message : `${name} lookup failed.`;
    }
  } else issues.push({ action: "resolve", id: issueId });
  // A fallback compared from saved data after its own failed refresh is unverified too.
  if (choice.fallbackError && choice.usingId) {
    const failure = failureOf(choice.fallbackError);
    issues.push({ action: "set", issue: issue(fallbackIssueId, failure, choice.usingId, catalogueUseExplanation(provider, use)!) });
  } else issues.push({ action: "resolve", id: fallbackIssueId });
  return { identity, ...(catalogue ? { catalogue } : {}), use: { action: "set", use }, issues, ...(unavailableCause ? { unavailableCause } : {}), ...(warning ? { warning } : {}) };
}
