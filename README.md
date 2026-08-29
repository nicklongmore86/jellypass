# Jellyseerr → Jellyfin Access

Restrict requested media in Jellyfin to the Seerr/Jellyseerr users who requested it.

This small companion service receives Seerr's **Request Available** webhook, reads the requester and Jellyfin media IDs already present in the webhook, and applies Jellyfin's native tag-based access policy.

> [!CAUTION]
> This project is an early preview. Test it with non-critical users and media first. Jellyfin does not expose transactional policy updates, so a failed sync can temporarily leave an item visible until reconciliation succeeds.

## How it works

For each private title, the bridge:

1. Adds one stable tag such as `jfa:private:8f…` to the movie or series.
2. Adds that tag to `BlockedTags` for every non-administrator Jellyfin user except its requester(s).
3. Persists the grant and can reapply it with the reconciliation endpoint.

Existing untagged media stays public. Multiple people can request the same title: the item has one tag, and every requester becomes an owner. Administrator accounts remain unrestricted. For series, Jellyfin inherits the series tag when checking child visibility.

## Requirements

- Seerr/Jellyseerr with webhook variables `media_jellyfinMediaId` and `requestedBy_jellyfinUserId`
- Jellyfin 10.11 or newer
- Node.js 22+ or Docker
- A Jellyfin administrator API key

## Quick start

```sh
cp .env.example .env
# Fill in JELLYFIN_API_KEY and generate a long WEBHOOK_TOKEN.
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

All endpoints except health require `Authorization: Bearer $WEBHOOK_TOKEN`.

```sh
# Liveness
curl http://127.0.0.1:8787/health

# Inspect persisted grants
curl -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  http://127.0.0.1:8787/v1/grants

# Reapply item tags and user policies after adding a Jellyfin user
curl -X POST -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  http://127.0.0.1:8787/v1/reconcile
```

Reconcile after adding or importing a Jellyfin user so that existing private tags are added to that user's block list.

## Access semantics and limitations

- Enforcement is performed by Jellyfin itself through inherited item tags and each user's `BlockedTags` policy.
- Availability notifications occur after Jellyfin discovers the item. There is a small fail-open window before the webhook is processed.
- Deleting a Seerr request does not revoke its grant in this preview.
- Direct filesystem, DLNA, administrator, and other out-of-band access are outside this service's scope.
- The bridge merges only its own `jfa:private:*` tag and preserves unrelated item tags and blocked tags.
- A Jellyfin user policy is updated as a whole because that is how Jellyfin's API is shaped. Changes made concurrently in another admin UI can race; reconciliation restores the bridge-owned portion.

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

The runtime uses only Node's standard library. TypeScript and Node type definitions are development-only dependencies.

## Project status

The first milestone is intentionally narrow: secure, idempotent request-to-access grants with durable reconciliation. Planned follow-ups include explicit revocation, shared household groups, a dry-run audit, metrics, and integration tests against a real Jellyfin container.

## License

[MIT](LICENSE)
