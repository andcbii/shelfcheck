export function shouldShowPlexMissingEpisode(
  airDate: string | undefined,
  hideUnairedEpisodes: boolean,
  airingOffsetDays: number,
  today: string,
) {
  if (!hideUnairedEpisodes) return true;
  if (!airDate) return false;

  const date = new Date(`${airDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  date.setDate(date.getDate() + airingOffsetDays);
  return date.toISOString().slice(0, 10) <= today;
}
