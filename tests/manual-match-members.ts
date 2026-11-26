import assert from "node:assert/strict";
import type { CoverageIdentity, CoverageMember, CoverageProvider } from "../lib/manual-coverage-model";

/** A Manual Match member: provider episode `id`, with its saved Report Missing flag when `reportMissing`. */
export const episode = (provider: CoverageProvider, id: number, reportMissing = false): CoverageMember => ({
  provider, id, showId: provider === "TMDB" ? 10 : 20, show: "Show", title: `Episode ${id}`, season: 1, episode: id, url: "", ...(reportMissing ? { reportMissing } : {}),
});

/** A member's identity alone, without its saved flag. */
export const identity = ({ provider, id }: CoverageIdentity): CoverageIdentity => ({ provider, id });

/** A provider show, and optionally which of its episodes (default S1E1). */
export type ShowEpisode = { showId: number; show: string; showYear?: number; season?: number; episode?: number };
/** A saved Manual Match as the Manual Coverage API returns it. */
export type SavedMatch = { id: string; revision: number; createdAt: string; members: CoverageMember[] };

let nextEpisodeId = 1;
/** A Manual Match member: one episode of `show`, with a fresh provider episode ID. */
export const showMember = (provider: CoverageProvider, { season = 1, episode = 1, ...show }: ShowEpisode): CoverageMember =>
  ({ provider, id: nextEpisodeId++, title: "Episode", url: `https://example.test/${provider}/${nextEpisodeId}`, season, episode, ...show });

/** A saved Manual Match `id` holding one episode of each listed TMDB and TVDB show. */
export const savedMatch = (id: string, tmdb: ShowEpisode[], tvdb: ShowEpisode[], createdAt = "2026-01-01T00:00:00.000Z", revision = 1): SavedMatch =>
  ({ id, revision, createdAt, members: [...tmdb.map(show => showMember("TMDB", show)), ...tvdb.map(show => showMember("TVDB", show))] });

/** The Manual Match IDs of the listed cards, in order. */
export const cardIds = (container: ParentNode) =>
  [...container.querySelectorAll<HTMLInputElement>("article input[type=checkbox]")].map(input => input.getAttribute("aria-label")!.replace("Select Manual Match ", ""));

/** The Manual Matches report's heading, e.g. "Manual Matches (2 of 5)". */
export const reportHeading = (container: ParentNode) => [...container.querySelectorAll("h3")].map(item => item.textContent).find(text => text?.startsWith("Manual Matches"));

/** A show filter's combobox, found by its label as a screen reader would. */
export function showFilterCombobox(container: ParentNode, name: string) {
  const label = [...container.querySelectorAll("label")].find(item => item.textContent === name);
  assert.ok(label, `${name} label`);
  const input = container.querySelector<HTMLInputElement>(`#${label.htmlFor}`);
  assert.equal(input?.getAttribute("role"), "combobox");
  return input!;
}
