#!/usr/bin/env bash
# Runs test/real-seerr.test.mjs against a throwaway Seerr container, removed afterwards. The container
# starts from an empty config; this script reads the API key Seerr generated and seeds two users
# straight into its database (an owner, a member with no permissions and a catalogue user), so no
# media server is needed. Only the catalogue-preference test reaches TMDB, through Seerr, and it is
# skipped when Seerr cannot. Run after `pnpm build`.
set -euo pipefail

SEERR_IMAGE="${SEERR_IMAGE:-ghcr.io/seerr-team/seerr:v3.5.1}"
SEERR_PORT="${SEERR_PORT:-15055}"

if ! command -v docker > /dev/null 2>&1; then
  echo 'test:seerr needs Docker' >&2
  exit 1
fi

container="jfa-seerr-$$"
cleanup() { docker rm -f "$container" > /dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
  echo "$1" >&2
  echo '--- Seerr logs ---' >&2
  docker logs "$container" >&2 || true
  exit 1
}

# The image runs as node (uid 1000); the config, database included, lives only in memory.
docker run -d --name "$container" -p "127.0.0.1:${SEERR_PORT}:5055" \
  --tmpfs /app/config:uid=1000,gid=1000 \
  "$SEERR_IMAGE" > /dev/null

url="http://127.0.0.1:${SEERR_PORT}"
for _ in $(seq 1 120); do
  curl -fsS "$url/api/v1/status" > /dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$url/api/v1/status" > /dev/null 2>&1 || fail 'Seerr did not start within two minutes'

api_key="$(docker exec "$container" node -p 'require("/app/config/settings.json").main.apiKey')"
[[ -n "$api_key" ]] || fail 'Seerr settings have no API key'

# Seerr's API key acts as user 1, which must exist; user 2 is a Jellyfin-linked member with no
# permissions, so anything Seerr runs as the member is refused where the owner would succeed, and
# with its own discover preference (Japanese originals only); user 3 is the catalogue user, a local
# user with no permissions, no Jellyfin link and no preferences of its own.
docker exec "$container" node -e '
  const sqlite3 = require("sqlite3");
  const db = new sqlite3.Database("/app/config/db/db.sqlite3");
  const insert = "INSERT INTO user (id, email, username, permissions, avatar, userType, jellyfinUserId, jellyfinUsername) VALUES (?, ?, ?, ?, ?, 3, ?, ?)";
  db.serialize(() => {
    db.run(insert, [1, "owner@example.invalid", "owner", 2, "/avatar", "0000000000000000000000000000000a", "owner"]);
    db.run(insert, [2, "member@example.invalid", "member", 0, "/avatar", "0000000000000000000000000000000b", "member"]);
    db.run("INSERT INTO user (id, email, username, permissions, avatar, userType) VALUES (3, ?, ?, 0, ?, 2)",
      ["catalogue@example.invalid", "jellypass-catalogue", "/avatar"]);
    db.run("INSERT INTO user_settings (userId, locale, originalLanguage) VALUES (2, ?, ?)", ["", "ja"]);
  });
  db.close((error) => { if (error) { console.error(error); process.exit(1); } });
' || fail 'could not seed Seerr users'

if ! SEERR_REAL_URL="$url" SEERR_REAL_API_KEY="$api_key" node --test test/real-seerr.test.mjs; then
  fail 'real Seerr tests failed'
fi
