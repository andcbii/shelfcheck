import Link from "next/link";

export default function PlexPage() {
  return (
    <main className="plex-page">
      <header className="topbar">
        <div className="header-left">
          <Link className="brand" href="/"><span className="brandmark">S</span><span>Shelfcheck</span></Link>
          <nav className="mode-switch" aria-label="Search source">
            <Link href="/trakt">Trakt</Link>
            <Link className="active" href="/plex" aria-current="page">Plex</Link>
          </nav>
        </div>
      </header>
      <section className="plex-blank" aria-labelledby="plex-coming-soon">
        <div>
          <p className="eyebrow">PLEX LIBRARY AUDIT</p>
          <h1 id="plex-coming-soon">Coming Soon</h1>
        </div>
      </section>
    </main>
  );
}
