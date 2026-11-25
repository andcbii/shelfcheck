/**
 * The one usable Show year rule (GLOSSARY.md), shared by the scan, the year stores and the pages: a
 * four-digit calendar year, an integer from 1000 to 9999. Zero, a malformed value or none is no year.
 */
export function usableShowYear(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : undefined;
}
