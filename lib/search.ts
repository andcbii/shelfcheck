export function normalizeSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

export function matchesSearch(value: string, query: string) {
  return normalizeSearchText(value).includes(normalizeSearchText(query));
}
