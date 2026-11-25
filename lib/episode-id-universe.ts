import type { CoverageProvider } from "@/lib/manual-coverage-model";
import { isRecord } from "@/lib/value-guards";

/**
 * Run-bound evidence of every episode ID one provider returned for one of its own shows, from a
 * catalogue downloaded fresh and complete in this scan run. It covers every season and page as the
 * provider answered them, before any normalization: specials, unaired episodes, ID-bearing records
 * without numbering and records the comparison leaves out all count. It lives only in memory with
 * the scan run's comparison catalogue; saved, reused, failed, incomplete and fallback catalogues
 * never carry it, so its absence means "no evidence", never "no episodes".
 */
export type EpisodeIdUniverse = {
  provider: CoverageProvider;
  /** The provider's own show ID whose episodes were enumerated. */
  showId: number;
  ids: ReadonlySet<number>;
};

const episodeId = (record: unknown) => isRecord(record) && typeof record.id === "number" && Number.isSafeInteger(record.id) && record.id > 0 ? record.id : undefined;

/**
 * Collects a download's raw episode records as each season or page arrives. Any response that is
 * not a list, or any record whose ID cannot be read, means the enumeration cannot say which episodes
 * exist, so it yields no evidence; so does an enumeration with no records at all. A caller whose
 * download fails or stops early never asks for the evidence.
 */
export function episodeIdEnumeration(provider: CoverageProvider, showId: number) {
  const ids = new Set<number>();
  let readable = true;
  return {
    add(records: unknown) {
      if (!Array.isArray(records)) { readable = false; return; }
      for (const record of records) {
        const id = episodeId(record);
        if (id === undefined) readable = false;
        else ids.add(id);
      }
    },
    /** The evidence once every season or page has been added; undefined when the enumeration is not complete. */
    complete(): EpisodeIdUniverse | undefined {
      if (!readable || !ids.size) return undefined;
      return { provider, showId, ids: new Set(ids) };
    },
  };
}
