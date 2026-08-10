import Link from "next/link";

export function ReportTopbar() {
  return <header className="topbar">
    <div className="header-left">
      <Link className="brand" href="/"><span className="brandmark">S</span><span>Shelfcheck</span></Link>
      <nav className="mode-switch" aria-label="Search source"><Link href="/trakt">Trakt</Link><Link href="/plex">Plex</Link></nav>
    </div>
  </header>;
}
