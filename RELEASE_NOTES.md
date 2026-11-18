# Shelfcheck 2.6.1

Shelfcheck 2.6.1 moves the app to Node.js 26, the current long-term support
release of Node.js. Shelfcheck itself works the same as in 2.6.0.

## Changes

- The Docker image now runs on Node.js 26. Node.js 24 stops receiving
  regular updates and reaches end of life in April 2028.
- Local development now needs Node.js 26 or newer.
- Every change is now checked by starting the image on both amd64 and arm64.

## Upgrading

Use `andcbii/shelfcheck:2.6.1` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.
No configuration or database reset is required.
