# Jellyseerr → Jellyfin Access

Restrict requested media in Jellyfin to the Seerr/Jellyseerr users who requested it.

This small companion service receives Seerr's **Request Available** webhook, reads the requester and Jellyfin media IDs already present in the webhook, and applies Jellyfin's native tag-based access policy.

> [!CAUTION]
> Test with non-critical users and media first. Jellyfin does not expose transactional policy updates, so a failed sync can temporarily leave an item visible until reconciliation succeeds.

## How it works

For each private title, the bridge:

1. Adds one stable tag such as `jfa:private:8f…` to the movie or series.
2. Adds that tag to `BlockedTags` for every non-administrator Jellyfin user except its requester(s).
3. Persists the grant and can reapply it with the reconciliation endpoint.

Revocations are persisted as cleanup jobs before Jellyfin is changed. The record is removed only after the item tag and every user policy have been cleaned successfully. Failed synchronization state is retained with attempt count, error details, and the next retry time.

Existing untagged media stays public. Multiple people can request the same title: the item has one tag, and every requester becomes an owner. Administrator accounts remain unrestricted. For series, Jellyfin inherits the series tag when checking child visibility.

## Requirements

- Seerr/Jellyseerr with webhook variables `media_jellyfinMediaId` and `requestedBy_jellyfinUserId`
- Jellyfin 10.11 or newer
- Node.js 22+ or Docker
- A Jellyfin administrator API key

## Quick start

```sh
cp .env.example .env
# Fill in JELLYFIN_API_KEY and generate different long WEBHOOK_TOKEN and ADMIN_TOKEN values.
docker compose -f compose.example.yaml up --build -d
```

The example binds the service to localhost at port `8787`. If Seerr is in the same Compose network, remove `ports` and address it by service name instead.

### Configure the Seerr webhook

In **Settings → Notifications → Webhook**:

- Enable the agent and select only **Request Available**.
- Set the URL to `http://access-bridge:8787/webhooks/seerr` (adjust for your network).
- Set the authorization header to `Bearer YOUR_WEBHOOK_TOKEN`.
- Use this JSON payload:

```json
{
  "notificationType": "{{notification_type}}",
  "media": {
    "jellyfinMediaId": "{{media_jellyfinMediaId}}",
    "mediaType": "{{media_type}}"
  },
  "request": {
    "id": "{{request_id}}",
    "requestedBy": {
      "jellyfinUserId": "{{requestedBy_jellyfinUserId}}",
      "username": "{{requestedBy_username}}"
    }
  }
}
```

The requesting Seerr account must be linked to/imported from Jellyfin. A local-only Seerr account has no Jellyfin user ID and will be rejected.

## Operations

The webhook uses `WEBHOOK_TOKEN`. Administrative endpoints use `ADMIN_TOKEN`. Health is public.

```sh
# Liveness
curl http://127.0.0.1:8787/health

# Inspect persisted grants
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/v1/grants

# Preview every change without mutating Jellyfin
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  'http://127.0.0.1:8787/v1/reconcile?dryRun=true'

# Reapply item tags and user policies
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/v1/reconcile

# Revoke one request; add ?dryRun=true to preview it first
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/v1/grants/JELLYFIN_ITEM_ID/requests/SEERR_REQUEST_ID

# Prometheus metrics
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/metrics
```

The service also reconciles on `RECONCILE_INTERVAL_SECONDS` (default: 300). Set it to `0` to disable scheduled reconciliation. Run a manual reconciliation immediately after adding or importing a Jellyfin user.

### Household and shared-access groups

Groups grant access in addition to the original requester. Group IDs are stable URL-safe names chosen by the administrator.

```sh
# Create or replace a group. User IDs are Jellyfin IDs.
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Household","userIds":["USER_ID_1","USER_ID_2"]}' \
  http://127.0.0.1:8787/v1/groups/household

# Attach groups to an existing item grant. Use ?dryRun=true to preview.
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"groupIds":["household"]}' \
  http://127.0.0.1:8787/v1/grants/JELLYFIN_ITEM_ID/groups

# List or remove groups
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/v1/groups
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/v1/groups/household
```

Changing a group's membership immediately reconciles every item that references it. Removing the last request and last group cleans the private tag from the item and every user's block list.

## Access semantics and limitations

- Enforcement is performed by Jellyfin itself through inherited item tags and each user's `BlockedTags` policy.
- Availability notifications occur after Jellyfin discovers the item. There is a small fail-open window before the webhook is processed.
- Seerr does not currently emit a request-deleted webhook with all fields needed for automatic revocation, so revocation uses the administrative API.
- Direct filesystem, DLNA, administrator, and other out-of-band access are outside this service's scope.
- The bridge merges only its own `jfa:private:*` tag and preserves unrelated item tags and blocked tags.
- A Jellyfin user policy is updated as a whole because that is how Jellyfin's API is shaped. Changes made concurrently in another admin UI can race; reconciliation restores the bridge-owned portion.
- Metrics intentionally contain counts and result labels only; they do not expose usernames, item names, API keys, or tokens.

## Administrative API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/grants` | Grants and persisted synchronization health |
| `GET` | `/v1/grants/{itemId}/plan` | Dry-run plan for one grant |
| `DELETE` | `/v1/grants/{itemId}/requests/{requestId}` | Revoke a requester; supports `?dryRun=true` |
| `PUT` | `/v1/grants/{itemId}/groups` | Replace shared groups; supports `?dryRun=true` |
| `GET` | `/v1/groups` | List access groups |
| `PUT` | `/v1/groups/{groupId}` | Create or replace an access group |
| `DELETE` | `/v1/groups/{groupId}` | Delete a group and reconcile affected items |
| `POST` | `/v1/reconcile` | Reconcile all grants; supports `?dryRun=true` |
| `GET` | `/metrics` | Prometheus text metrics |

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

The runtime uses only Node's standard library. TypeScript and Node type definitions are development-only dependencies.

CI also starts `jellyfin/jellyfin:10.11.3`, completes its setup wizard, creates users, scans the committed `.strm` fixture, and verifies grant and revoke behavior against the real server. To run that test manually, start an equivalent fresh container with the fixture mounted at `/media`, then run:

```sh
JELLYFIN_REAL_URL=http://127.0.0.1:18096 pnpm test:real
```

## Project status

Implemented today: idempotent request grants, explicit revocation and cleanup, shared household groups, dry-run change plans, persistent sync failures, scheduled reconciliation, Prometheus metrics, state-v1 migration tests, full HTTP integration tests, and container-backed tests against Jellyfin 10.11.3.

Potential follow-ups include a browser-based administration UI, automatic revocation when Seerr exposes a suitable lifecycle webhook, grant expiration, signed webhooks, orphan discovery, and release images published to GHCR.

## License

[MIT](LICENSE)
