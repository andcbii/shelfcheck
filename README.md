# Shelfcheck

Shelfcheck compares a Trakt TV collection with the aired episode list and keeps
one personal missing-episode report. The Docker image is deliberately
single-user: it has no accounts or login screen.

## Storage

The container listens on port `3000` and uses two persistent locations:

- `/config/config.yml` contains the Trakt client ID and access token. Create it
  from `config.example.yml`, or enter credentials in the UI.
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

Requires Node.js `>=22.13.0` and pnpm.

```bash
pnpm install
pnpm dev
```

Local development stores configuration and data below `.runtime/`, which is
ignored by Git. The production Docker build uses Next.js standalone output.

## Trakt configuration

Create a Trakt application at `https://trakt.tv/oauth/applications`. Shelfcheck
needs the application's client ID and an OAuth access token. It never needs the
client secret. The file format is:

```yaml
trakt:
  client_id: "your-trakt-client-id"
  access_token: "your-trakt-access-token"
```

Treat `config.yml` as a secret and never commit it.
