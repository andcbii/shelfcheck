import Link from "next/link";
import type { ShowCatalogueSelection } from "@/lib/catalogue-selection-store";
import { catalogueNotices } from "@/lib/catalogue-notice";
import { multipleProviderIdsHref } from "@/lib/multiple-provider-ids-link";

/** Inline results note for a show with several Plex-reported series IDs; selection itself stays in the report. */
export function CatalogueNotice({ identity, selection }: { identity: string; selection?: ShowCatalogueSelection }) {
  const notices = catalogueNotices(selection);
  if (!notices.length) return null;
  return <div className="catalogue-notice" role="note">
    <span className="catalogue-notice-indicator" aria-hidden="true">!</span>
    <span className="catalogue-notice-text">{notices.map((notice) => <span key={notice.provider}>{notice.text}</span>)}</span>
    <Link href={multipleProviderIdsHref(identity)}>Review IDs</Link>
  </div>;
}
