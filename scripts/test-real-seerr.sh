#!/usr/bin/env bash
# Runs test/real-seerr.test.mjs against a throwaway Seerr container, removed afterwards. The container
# starts from an empty config; this script reads the API key Seerr generated and seeds users and
# requests straight into its database, so no media server is needed. Nothing reaches TMDB: the
# household app reads titles from a fake TMDB in the test. Run after `pnpm build`.
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
# permissions, so anything Seerr runs as the member is refused where the owner would succeed. For the
# household app, user 4 is a member who may request and has a pending request for The Matrix (TMDB
# 603), user 5 a member of another household with a pending request for Fight Club (TMDB 550), and
# user 6 a member of both households with a pending request for Pulp Fiction (TMDB 680). Users 7 and 8 have
# Seerr request quotas, so "Get this" is not offered to them: user 7 a movie quota of 1 with no window (days unset) and
# an approved request for Forrest Gump (TMDB 13) made in 2001, user 8 a series quota of 5 a week, none of it used.
# Seerr fetches titles it is asked to request from TMDB itself, so the "Get this" test needs Seerr to reach TMDB.
docker exec "$container" node -e '
  const sqlite3 = require("sqlite3");
  const db = new sqlite3.Database("/app/config/db/db.sqlite3");
  const insert = "INSERT INTO user (id, email, username, permissions, avatar, userType, jellyfinUserId, jellyfinUsername) VALUES (?, ?, ?, ?, ?, 3, ?, ?)";
  db.serialize(() => {
    db.run(insert, [1, "owner@example.invalid", "owner", 2, "/avatar", "0000000000000000000000000000000a", "owner"]);
    db.run(insert, [2, "member@example.invalid", "member", 0, "/avatar", "0000000000000000000000000000000b", "member"]);
    db.run(insert, [4, "requester@example.invalid", "requester", 32, "/avatar", "0000000000000000000000000000000c", "requester"]);
    db.run(insert, [5, "neighbour@example.invalid", "neighbour", 32, "/avatar", "0000000000000000000000000000000d", "neighbour"]);
    db.run(insert, [6, "shared@example.invalid", "shared", 32, "/avatar", "0000000000000000000000000000000e", "shared"]);
    db.run(insert, [7, "lifetime@example.invalid", "lifetime", 32, "/avatar", "0000000000000000000000000000000f", "lifetime"]);
    db.run(insert, [8, "series@example.invalid", "series", 32, "/avatar", "00000000000000000000000000000010", "series"]);
    db.run("INSERT INTO media (id, mediaType, tmdbId, status) VALUES (1, ?, 603, 2), (2, ?, 550, 2), (3, ?, 680, 2)", ["movie", "movie", "movie"]);
    db.run("INSERT INTO media_request (id, status, type, mediaId, requestedById, is4k) VALUES (1, 1, ?, 1, 4, 0), (2, 1, ?, 2, 5, 0), (3, 1, ?, 3, 6, 0)", ["movie", "movie", "movie"]);
    db.run("INSERT INTO media (id, mediaType, tmdbId, status) VALUES (4, ?, 13, 3)", ["movie"]);
    db.run("INSERT INTO media_request (id, status, type, mediaId, requestedById, is4k, createdAt) VALUES (4, 2, ?, 4, 7, 0, ?)", ["movie", "2001-01-01 00:00:00"]);
    db.run("UPDATE user SET movieQuotaLimit = 1, movieQuotaDays = NULL WHERE id = 7");
    db.run("UPDATE user SET tvQuotaLimit = 5, tvQuotaDays = 7 WHERE id = 8");
  });
  db.close((error) => { if (error) { console.error(error); process.exit(1); } });
' || fail 'could not seed Seerr users'

if ! SEERR_REAL_URL="$url" SEERR_REAL_API_KEY="$api_key" node --test test/real-seerr.test.mjs; then
  fail 'real Seerr tests failed'
fi
