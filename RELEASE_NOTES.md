# Shelfcheck 2.3.1

Shelfcheck 2.3.1 fixes a Plex report race in temporary and permanent whole-show
ignores.

## Plex ignore results

A delayed scan response could put an ignored show's old results back into the
page, allowing Restore or expiry to reveal them without a new scan. Plex now
keeps those results and cache entries removed until a scan starts after the
ignore ends. Older initial report requests and aborted polls cannot replace
fresh scan results.

Client regression tests cover delayed report delivery, Restore, expiry,
preference loading, and fresh scans after an ignore ends. Season ignores continue
to filter existing results, which can reappear when their ignore ends.

For the temporary-ignore features and Trakt OAuth request changes introduced in
2.3.0, see the [2.3.0 release](https://github.com/andcbii/shelfcheck/releases/tag/v2.3.0).

## Upgrading

Use Docker image `andcbii/shelfcheck:2.3.1` and keep your existing `/config` and
`/data` mounts when replacing the container. No configuration or database reset is
required; provider credentials and preferences stay in their existing volumes.

> [!IMPORTANT]
> **Reverse-proxy upgrade notice:** Installations using Trakt OAuth behind a
> reverse proxy must set `SHELFCHECK_PUBLIC_URL` to Shelfcheck's exact externally
> visible origin, such as `https://shelfcheck.example.com`. Without this setting,
> Trakt login may redirect to the container's internal or non-HTTPS address.

Direct-access installations do not need to set this variable.
