import Link from "next/link";

export default function LandingPage() {
  return (
    <main>
      <header className="topbar">
        <div className="header-left">
          <Link className="brand" href="/"><span className="brandmark">S</span><span>Shelfcheck</span></Link>
          <nav className="mode-switch" aria-label="Search source">
            <Link href="/trakt">Trakt</Link>
            <Link href="/plex">Plex</Link>
          </nav>
        </div>
        <span className="landing-label">Collection audit</span>
      </header>

      <section className="chooser">
        <p className="eyebrow">CHOOSE YOUR SEARCH</p>
        <h1>How do you want to<br />check your library?</h1>
        <p className="chooser-intro">Shelfcheck helps you find the gaps in your TV shows, so you never miss an episode.</p>

        <div className="choice-grid">
          <Link className="choice-card" href="/trakt">
            <span className="choice-dot active" aria-hidden="true" />
            <div className="choice-copy">
              <p className="choice-name">TRAKT</p>
              <h2>Check your Trakt collection</h2>
              <p>Compare your collected shows with every aired episode.</p>
              <span className="choice-button">Use Trakt <b>→</b></span>
            </div>
            <div className="choice-radar" aria-hidden="true"><i /><i /><i /></div>
          </Link>

          <Link className="choice-card" href="/plex">
            <span className="choice-dot" aria-hidden="true" />
            <div className="choice-copy">
              <p className="choice-name">PLEX</p>
              <h2>Check your Plex library</h2>
              <p>Search your local Plex library for missing episodes.</p>
              <span className="choice-button">Use Plex <b>→</b></span>
            </div>
            <div className="server-mark" aria-hidden="true"><i /><i /><i /></div>
          </Link>
        </div>
      </section>
    </main>
  );
}
