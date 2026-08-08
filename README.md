# Shelfcheck

Shelfcheck compares a Trakt TV collection with the aired episode list and keeps
one personal missing-episode report. The Docker image is deliberately
single-user: it has no accounts or login screen.

## Storage

The container listens on port `3000` and uses two persistent locations:

- `/config/config.yml` contains the Trakt application credentials and automatically managed OAuth tokens.
- `/data/shelfcheck.db` is the SQLite database containing the report, scan
  checkpoint, and ignored-show list.

Both locations must be writable when credentials are managed through the UI.
The image runs as UID/GID `1001`.

## Run with Docker Compose

```bash
docker compose up --build -d
```

Open `http://localhost:3000`. Stop the app with `docker compose down`. The named
volumes survive that command; do not add `--volumes` unless you intend to erase
Shelfcheck's configuration and data.

Published releases are also available from Docker Hub:

```bash
docker pull andcbii/shelfcheck:1.3.0
```

An equivalent bind-mount example is:

```bash
docker run -d --name shelfcheck \
  -p 3000:3000 \
  -v /your/host/config:/config \
  -v /your/host/data:/data \
  --restart unless-stopped \
  shelfcheck:local
```

This personal mode has no application authentication. Keep it on a trusted
home network, behind a VPN, or behind an authenticated reverse proxy. Do not
publish port 3000 directly to the public internet.

## Local development

Requires Node.js 24 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Local development stores configuration and data below `.runtime/`, which is
ignored by Git. The production Docker build uses Next.js standalone output.

## Trakt configuration

Create a Trakt application at `https://app.trakt.tv/settings/apps`. Its redirect
URI must be the Shelfcheck origin followed by `/api/auth/trakt/callback`, for
example `http://localhost:3000/api/auth/trakt/callback`.

You can enter the Client ID and Client Secret through **Login To Trakt**, or
create `/config/config.yml` before starting Shelfcheck:

```yaml
trakt:
  client_id: "your-trakt-client-id"
  client_secret: "your-trakt-client-secret"
```

When **Login To Trakt** is clicked, Shelfcheck follows Trakt's Authorization
Code flow and stores the returned access token, refresh token, and expiration
time in the same file. Access tokens are refreshed automatically; rotating
refresh tokens are replaced atomically. Logging out deletes the user tokens but
retains the application credentials for the next login. Treat `config.yml` as a
secret and never commit it.

## License

Shelfcheck is available under the [MIT License](LICENSE).
