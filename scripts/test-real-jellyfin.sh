#!/usr/bin/env bash
# Runs test/real-jellyfin.test.mjs against a real Jellyfin. With JELLYFIN_REAL_URL set, that server
# is used as-is (it must be fresh: the test runs Jellyfin's startup wizard). Otherwise a throwaway
# Jellyfin container is started with Docker and removed afterwards. Run after `pnpm build`.
set -euo pipefail

JELLYFIN_IMAGE="${JELLYFIN_IMAGE:-jellyfin/jellyfin:10.11.3}"
JELLYFIN_PORT="${JELLYFIN_PORT:-18096}"

if [[ -n "${JELLYFIN_REAL_URL:-}" ]]; then
  exec node --test test/real-jellyfin.test.mjs
fi

if ! command -v docker > /dev/null 2>&1; then
  echo 'test:real needs Docker, or JELLYFIN_REAL_URL pointing at a fresh Jellyfin' >&2
  exit 1
fi

container="jfa-jellyfin-$$"
cleanup() { docker rm -f "$container" > /dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$container" -p "127.0.0.1:${JELLYFIN_PORT}:8096" \
  --tmpfs /config --tmpfs /cache \
  -v "$PWD/test/fixtures:/media:ro" \
  "$JELLYFIN_IMAGE" > /dev/null

if ! JELLYFIN_REAL_URL="http://127.0.0.1:${JELLYFIN_PORT}" node --test test/real-jellyfin.test.mjs; then
  echo '--- Jellyfin logs ---' >&2
  docker logs "$container" >&2 || true
  exit 1
fi
