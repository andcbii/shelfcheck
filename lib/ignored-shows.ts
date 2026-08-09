export function ignoredTraktIds(value: unknown): Set<number> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((show) => {
    if (!show || typeof show !== "object") return [];
    const id = (show as { ids?: { trakt?: unknown } }).ids?.trakt;
    return typeof id === "number" && Number.isFinite(id) ? [id] : [];
  }));
}

export function ignoredPlexKeys(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((show) => {
    if (!show || typeof show !== "object") return [];
    const key = (show as { ratingKey?: unknown }).ratingKey;
    return typeof key === "string" && key ? [key] : [];
  }));
}
