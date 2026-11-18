#!/usr/bin/env bash
# Starts a built Shelfcheck image with throwaway volumes and checks that it runs
# on the expected Node major and platform as the non-root user, serves a page
# and a static asset, and keeps SQLite data across a restart.
# Usage: scripts/container-smoke.sh IMAGE PLATFORM NODE_MAJOR
set -euo pipefail

image=$1
platform=$2
node_major=$3
name=shelfcheck-smoke
base=http://127.0.0.1:3000

case $platform in
  linux/amd64) arch=x64 ;;
  linux/arm64) arch=arm64 ;;
  *) echo "unsupported platform: $platform" >&2; exit 2 ;;
esac

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "$name" 2>&1 | tail -50 || true; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm -f "$name-config" "$name-data" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

wait_healthy() {
  for _ in $(seq 60); do
    if curl -fsS "$base/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "health check did not pass within 60s" >&2
  return 1
}

docker run --detach --name "$name" --platform "$platform" --publish 3000:3000 \
  --volume "$name-config:/config" --volume "$name-data:/data" "$image" >/dev/null
wait_healthy

runtime=$(docker exec "$name" node -p 'process.version + " " + process.platform + "/" + process.arch')
echo "runtime: $runtime, uid $(docker exec "$name" id -u)"
[[ $runtime == "v$node_major."*" linux/$arch" ]] || { echo "expected Node $node_major on linux/$arch" >&2; exit 1; }
[ "$(docker exec "$name" id -u)" = 1001 ] || { echo "expected uid 1001" >&2; exit 1; }

page=$(curl -fsSL "$base/")
asset=$(grep -o '/_next/static/[^"]*\.js' <<<"$page" | head -1)
[ -n "$asset" ] || { echo "no static asset referenced by /" >&2; exit 1; }
curl -fsS "$base$asset" >/dev/null
echo "page and static asset served: $asset"

curl -fsS -X PATCH -H 'Content-Type: application/json' --data '{"airingGraceDays":7}' "$base/api/state" >/dev/null
docker restart "$name" >/dev/null
wait_healthy
saved=$(curl -fsS "$base/api/state" | jq -r '.state.airingGraceDays')
[ "$saved" = 7 ] || { echo "SQLite setting not kept across restart: got $saved" >&2; exit 1; }
echo "SQLite setting kept across restart"
