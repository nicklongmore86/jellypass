#!/usr/bin/env bash
# Runs test/real-jellyfin.test.mjs against a real Jellyfin. With JELLYFIN_REAL_URL set, that server
# is used as-is (it must be fresh: the test runs Jellyfin's startup wizard). Otherwise a throwaway
# Jellyfin container is started with Docker for each supported release in scripts/jellyfin-versions.json
# (the images CI pins), one after the other, and removed afterwards; set JELLYFIN_IMAGE (and
# JELLYFIN_REAL_VERSION, the version it reports) to run one image only. Run after `pnpm build`.
set -euo pipefail

JELLYFIN_PORT="${JELLYFIN_PORT:-18096}"

if [[ -n "${JELLYFIN_REAL_URL:-}" ]]; then
  exec node --test test/real-jellyfin.test.mjs
fi

if ! command -v docker > /dev/null 2>&1; then
  echo 'test:real needs Docker, or JELLYFIN_REAL_URL pointing at a fresh Jellyfin' >&2
  exit 1
fi

if [[ -n "${JELLYFIN_IMAGE:-}" ]]; then
  runs=("$JELLYFIN_IMAGE ${JELLYFIN_REAL_VERSION:-}")
else
  mapfile -t runs < <(node -e 'for (const { image, version } of JSON.parse(require("fs").readFileSync("scripts/jellyfin-versions.json", "utf8"))) console.log(`${image} ${version}`)')
fi

container=''
cleanup() { [[ -z "$container" ]] || docker rm -f "$container" > /dev/null 2>&1 || true; }
trap cleanup EXIT

status=0
for run in "${runs[@]}"; do
  read -r image version <<< "$run"
  echo "--- real Jellyfin: $image ---" >&2
  container="jfa-jellyfin-$$"
  docker run -d --name "$container" -p "127.0.0.1:${JELLYFIN_PORT}:8096" \
    --tmpfs /config --tmpfs /cache \
    -v "$PWD/test/fixtures:/media:ro" \
    "$image" > /dev/null
  if ! JELLYFIN_REAL_URL="http://127.0.0.1:${JELLYFIN_PORT}" JELLYFIN_REAL_VERSION="$version" node --test test/real-jellyfin.test.mjs; then
    echo "--- Jellyfin logs ($image) ---" >&2
    docker logs "$container" >&2 || true
    status=1
  fi
  cleanup
  container=''
done
exit "$status"
