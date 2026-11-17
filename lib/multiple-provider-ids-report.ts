import type { CatalogueProvider } from "@/lib/catalogue-selection";
import type { ProviderCatalogueSelection, ShowCatalogueSelection } from "@/lib/catalogue-selection-store";
import type { CoverageIssue } from "@/lib/coverage-issues";
import { multipleProviderIdsHref } from "@/lib/multiple-provider-ids-link";

const PROVIDER_NAME: Record<CatalogueProvider, string> = { tmdb: "TMDB", tvdb: "TVDB" };
type ProviderMatch = { id: number; name?: string; year?: number; slug?: string };
type ReportShow = { ratingKey: string; title: string; year?: number; providerMatches?: { tmdb?: ProviderMatch[]; tvdb?: ProviderMatch[] } };

export type CandidateView = { id: number; name?: string; year?: number; href: string; automatic: boolean; override: boolean; using: boolean; unavailable: boolean };
export type ProviderPanel = { provider: CatalogueProvider; multiple: boolean; candidates: CandidateView[]; selection: ProviderCatalogueSelection; summary: SelectionSummary };
export type MultipleProviderIdEntry = { identity: string; anchor: string; title: string; year?: number; panels: Record<CatalogueProvider, ProviderPanel>; issues: CoverageIssue[] };
export type SelectionSummary = { using: string; preference: string; explanation?: string };

/** The DOM id of a show's entry; matches the fragment of `multipleProviderIdsHref`. */
export function multipleProviderIdsAnchor(identity: string) {
  return multipleProviderIdsHref(identity).slice(multipleProviderIdsHref(identity).indexOf("#") + 1);
}

function providerHref(provider: CatalogueProvider, id: number, slug?: string) {
  if (provider === "tmdb") return `https://www.themoviedb.org/tv/${id}`;
  return slug ? `https://thetvdb.com/series/${encodeURIComponent(slug)}` : `https://thetvdb.com/dereferrer/series/${id}`;
}
const day = (value?: string) => value?.slice(0, 10) || "unknown";
const distinct = (selection: ProviderCatalogueSelection) => new Set(selection.candidates.map(candidate => candidate.id)).size;

/**
 * How a provider's persisted selection reads in the report. It only describes the saved
 * preference and the catalogue the last comparison used; it never chooses one itself.
 */
export function selectionSummary(provider: CatalogueProvider, selection: ProviderCatalogueSelection): SelectionSummary {
  const series = (id: number) => { const name = selection.candidates.find(candidate => candidate.id === id)?.name; return name ? `${name} (${id})` : `${PROVIDER_NAME[provider]} ${id}`; };
  const preference = selection.override !== undefined ? `Override: ${series(selection.override)}`
    : selection.automaticId !== undefined ? `Automatic: ${series(selection.automaticId)}${distinct(selection) > 1 ? ", the lowest ID" : ""}` : "None";
  const current = selection.current;
  if (!current) return { using: "Not compared yet", preference, explanation: "The next Plex scan compares the preferred catalogue." };
  const preferredId = selection.preferredId;
  const usingId = current.usingId;
  if (current.state === "unavailable" || usingId === undefined)
    return { using: "None", preference, explanation: `No reported ${PROVIDER_NAME[provider]} series could supply a usable catalogue; last-good results are kept.` };
  if (preferredId !== undefined && current.preferredId !== preferredId)
    return { using: series(usingId), preference, explanation: `${preferredId} has not been compared yet; results use ${usingId} until the next Plex scan downloads it.` };
  if (current.state === "fallback") return { using: `Fallback: ${series(usingId)}`, preference,
    explanation: `Preferred: ${current.preferredId} · Currently using: ${usingId} · ${current.preferredId} unavailable; ${current.preferredDownloadedAt ? `saved catalogue expired ${day(current.preferredUsableUntil)}` : "no saved catalogue"}.` };
  if (current.state === "saved-unavailable") return { using: `Saved catalogue: ${series(usingId)}`, preference,
    explanation: `${usingId} could not be loaded; its saved catalogue is in use. Last successful download ${day(current.preferredDownloadedAt)}${current.preferredUsableUntil ? ` · usable until ${day(current.preferredUsableUntil)}` : ""}.` };
  if (current.state === "derived") return { using: series(usingId), preference, explanation: `Derived from TMDB ${current.derivedFrom}.` };
  return { using: series(usingId), preference };
}

function panel(provider: CatalogueProvider, selection: ProviderCatalogueSelection, matches: ProviderMatch[]): ProviderPanel {
  const current = selection.current;
  const unavailableId = current?.preferredFailedAt ? current.preferredId : undefined;
  return {
    provider, selection, multiple: distinct(selection) > 1, summary: selectionSummary(provider, selection),
    candidates: selection.candidates.map(({ id, name }) => {
      const match = matches.find(candidate => candidate.id === id);
      return { id, name: name || match?.name, year: match?.year, href: providerHref(provider, id, match?.slug), automatic: id === selection.automaticId, override: id === selection.override, using: id === current?.usingId, unavailable: id === unavailableId };
    }),
  };
}

/**
 * Every scanned show whose Plex items report more than one distinct TMDB or TVDB series,
 * whether or not it has missing episodes, with its persisted selections and the Coverage
 * Issues affecting its catalogues or comparison. Sorted by title.
 */
export function multipleProviderIdEntries({ selections, shows, issues }: { selections: Record<string, ShowCatalogueSelection>; shows: ReportShow[]; issues: CoverageIssue[] }): MultipleProviderIdEntry[] {
  return shows.flatMap(show => {
    const selection = selections[show.ratingKey];
    if (!selection || (distinct(selection.tmdb) < 2 && distinct(selection.tvdb) < 2)) return [];
    return [{
      identity: show.ratingKey, anchor: multipleProviderIdsAnchor(show.ratingKey), title: show.title, ...(show.year ? { year: show.year } : {}),
      panels: { tmdb: panel("tmdb", selection.tmdb, show.providerMatches?.tmdb || []), tvdb: panel("tvdb", selection.tvdb, show.providerMatches?.tvdb || []) },
      issues: issues.filter(issue => issue.show?.ratingKey === show.ratingKey && issue.scope === "show" && (issue.operation === "catalogue-refresh" || issue.operation === "comparison")),
    }];
  }).sort((left, right) => left.title.localeCompare(right.title));
}
