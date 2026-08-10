# Shelfcheck

Shelfcheck finds aired TV episodes missing from either a Trakt collection or a
local Plex library. It keeps separate reports and preferences for both search
modes in a single-user web interface.

Shelfcheck has no accounts or login screen of its own. Run it only on a trusted
home network, behind a VPN, or behind an authenticated reverse proxy. Do not
publish port `3000` directly to the public internet.

## Features

- Compare a Trakt TV collection with Trakt's aired episode list.
- Compare every Plex TV library with TMDB and TVDB episode data.
- Reuse unchanged show results and resume interrupted scans from checkpoints.
- Skip ignored shows before show-specific provider calls are made.
- Display active rate-limit pauses and automatically resume when allowed.
- Hide unaired Plex episodes, including episodes without an air date, and apply
  an optional 0–30 day aired-date offset.
- Apply a configurable 0–30 day airing grace period to Trakt results.
- Recognize conservative compound-episode mappings where one owned,
  double-length TMDB episode represents multiple split TVDB episodes.
- Retain downloadable, credential-safe diagnostic logs for the latest 10 scans.
- Inspect auto-matched episodes, unmatched shows, and unusual TMDB/TVDB show
  relationships in dedicated Plex reports.

## Run with Docker Compose

```bash
docker compose up --build -d
```

Open `http://localhost:3000`. Stop Shelfcheck with `docker compose down`. The
named volumes survive that command; do not add `--volumes` unless you intend to
erase Shelfcheck's configuration and data.

Published releases are available from Docker Hub:

```bash
docker pull andcbii/shelfcheck:2.1.0
```

An equivalent bind-mount example is:

```bash
docker run -d --name shelfcheck \
  -p 3000:3000 \
  -v /your/host/config:/config \
  -v /your/host/data:/data \
  --restart unless-stopped \
  andcbii/shelfcheck:2.1.0
```

The image runs as UID/GID `1001`. Both mounted directories must be writable by
that user.

## Configuration

Provider credentials can be entered through the Shelfcheck interface. They are
stored in `/config/config.yml`; saved secrets remain masked and are never
returned to the browser.

You can instead create the file before starting Shelfcheck:

```yaml
trakt:
  client_id: "your-trakt-client-id"
  client_secret: "your-trakt-client-secret"

plex:
  url: "http://your-plex-server:32400"
  token: "your-plex-token"

tmdb:
  token: "your-tmdb-api-read-access-token"

tvdb:
  api_key: "your-tvdb-v4-api-key"
  # pin: "your-subscriber-pin"
```

The TVDB subscriber PIN is optional. A Plex search requires the Plex URL and
token, a TMDB API read-access token, and a TVDB v4 API key.

Treat `config.yml` as a secret and never commit it.

### Trakt authorization

Create a Trakt application at `https://app.trakt.tv/settings/apps`. Its redirect
URI must be the Shelfcheck origin followed by `/api/auth/trakt/callback`, for
example:

```text
http://localhost:3000/api/auth/trakt/callback
```

Select **Sign in to Trakt** and enter the application's Client ID and Client
Secret. Shelfcheck uses Trakt's Authorization Code flow and stores the returned
access token, refresh token, expiration time, and redirect URI in `config.yml`.
Access tokens are refreshed automatically and rotating refresh tokens are
replaced atomically. Logging out removes user tokens while retaining the Trakt
application credentials.

## Scanning

### Trakt

A Quick Scan reuses cached show results when the collection fingerprint, aired
episode count, and Trakt update timestamp are unchanged. A Deep Scan checks the
same change signals and refreshes shows that need new results. Clearing the scan
cache forces the next scan to rebuild all show results.

The airing grace period delays when an episode is considered missing. Ignored
shows are removed immediately after the collection is loaded, so Shelfcheck
does not make per-show API requests for them on future scans.

### Plex

A Plex search groups duplicate Plex show records, reads the locally owned
episode identities, and compares them with TMDB and TVDB. For TVDB episodes,
ownership is resolved in this order:

1. Direct TVDB identity.
2. Shared IMDb identity.
3. Trakt crosswalk.
4. TMDB crosswalk.
5. Compound-episode coverage, when **Auto Compound Episodes** is enabled.
6. Missing episode.

Compound matching is deliberately conservative. It requires the same show,
season, air date, and normalized title; consecutive split TVDB episodes; an
owned TMDB episode identity; and corroborating split-total or double-length
runtime evidence. The preference is enabled by default and is only used as the
last check before reporting a TVDB episode as missing.

Plex searches use three show workers while spacing provider requests (including
a 200 ms TVDB start gate) to improve throughput without sending bursts. Explicit
provider rate limits pause the affected work, save progress, appear in the UI,
and resume automatically. Interrupted searches can reuse their saved checkpoint.

Ignored Plex shows are filtered before TMDB, TVDB, and Trakt show checks. The
**Hide unaired episodes** preference hides episodes whose air date plus the
configured offset has not arrived and also hides episodes with no air date.

## Storage and diagnostics

The container uses two persistent locations:

- `/config/config.yml` contains provider credentials and managed Trakt OAuth
  tokens.
- `/data/shelfcheck.db` contains reports, preferences, ignored shows, caches,
  checkpoints, and scan status.
- `/data/logs/` contains optional Trakt and Plex diagnostic scan logs.

Diagnostic logs exclude credentials and authorization headers. Trakt and Plex
logging can be controlled independently in their settings screens, where logs
can also be downloaded or deleted. The latest 10 logs for each scan type are
retained.

## Local development

Requires Node.js 24 or newer and pnpm 11.

```bash
pnpm install
pnpm dev
```

Local development stores configuration and data below `.runtime/`, which is
ignored by Git. The production image uses Next.js standalone output.

Useful verification commands:

```bash
pnpm lint
pnpm test
pnpm build
pnpm audit --prod --audit-level high
```

## License

Shelfcheck is available under the [MIT License](LICENSE).
