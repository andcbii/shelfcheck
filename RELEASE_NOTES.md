# Shelfcheck 2.3.0

Shelfcheck 2.3.0 adds temporary ignores for shows and seasons and improves Trakt
OAuth requests.

## Temporary ignores

- Ignore a whole show or selected seasons for **30 days**, **90 days**,
  **6 months**, or **Forever** in either Plex or Trakt mode.
- View expiry dates, change durations, and use **Restore** in **Ignored Shows**.
- Existing ignores remain permanent. Temporary ignores survive restarts and end
  automatically; expiry does not start a scan.
- After a whole-show ignore expires or is restored, run a new scan to rebuild its
  result. Season expiry reveals any previously hidden episodes already present
  in the report.

Whole-show ignores now remove saved results, caches, and checkpoints immediately,
including results from scans already in progress. Existing permanent ignores are
normalized on upgrade so Restore cannot expose old retained results.

## Trakt authorization

Login and token-refresh requests now send an identifying, versioned Shelfcheck
User-Agent, addressing Cloudflare blocks caused by an unidentified OAuth token
request. This does not resolve every possible Trakt authorization failure.

## Security updates

Updated Next.js and image-processing dependencies to patched releases.

## Upgrading

Use Docker image `andcbii/shelfcheck:2.3.0` and keep your existing `/config` and
`/data` mounts when replacing the container. No configuration or database reset is
required; provider credentials and preferences stay in their existing volumes.

> [!IMPORTANT]
> **Reverse-proxy upgrade notice:** Installations using Trakt OAuth behind a
> reverse proxy must set `SHELFCHECK_PUBLIC_URL` to Shelfcheck's exact externally
> visible origin, such as `https://shelfcheck.example.com`. Without this setting,
> Trakt login may redirect to the container's internal or non-HTTPS address.

Direct-access installations do not need to set this variable.
