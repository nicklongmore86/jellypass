# JellyPass

**Control who can watch what.** JellyPass provides personalized library access for Jellyfin.

JellyPass receives Seerr's **Request Available** webhook and applies Jellyfin's native tag-based access policy. It can read the requester and media IDs directly from newer webhook payloads or look them up from the request ID on older Jellyseerr releases.

JellyPass is an independent third-party project compatible with Jellyfin. It is not affiliated with or endorsed by the Jellyfin project.

The companion [JellyQuest for Tizen](https://github.com/nicklongmore86/jellyquest-tizen) client provides a household-scoped Samsung TV build with a locked JellyPass hostname and an app-owned login experience.

> [!CAUTION]
> Test with non-critical users and media first. Jellyfin does not expose transactional policy updates, so a failed sync can temporarily leave an item visible until reconciliation succeeds.

## How JellyPass works

For each private title, JellyPass:

1. Adds one stable tag such as `jfa:private:8f…` to the movie or series and each local trailer Jellyfin associates with it.
2. Adds that tag to `BlockedTags` for every non-administrator Jellyfin user except its requester(s).
3. Persists the grant and can reapply it with the reconciliation endpoint, including trailers downloaded after the original grant.

Revocations are persisted as cleanup jobs before Jellyfin is changed. The record is removed only after the item tag and every user policy have been cleaned successfully. Failed synchronization state is retained with attempt count, error details, and the next retry time.

Existing untagged media stays public. Multiple people can request the same title: the item has one tag, and every requester becomes an owner. Administrator accounts remain unrestricted. For series, Jellyfin inherits the series tag when checking child visibility. Local trailers are tagged directly because Jellyfin can authorize their opaque item IDs independently of the parent title.

## Requirements

- Seerr/Jellyseerr with webhook support and linked Jellyfin users
- Jellyfin 10.11 or newer
- Node.js 22+ or Docker
- A Jellyfin administrator API key

## Quick start

```sh
cp .env.example .env
# Fill in the API keys and generate different long WEBHOOK_TOKEN and ADMIN_TOKEN values.
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

Jellyseerr 2.7.x does not expose the Jellyfin IDs as webhook template variables. Set `SEERR_URL` and `SEERR_API_KEY`, then use its request ID payload instead:

```json
{
  "notificationType": "{{notification_type}}",
  "request": { "id": "{{request_id}}" }
}
```

If that Jellyseerr release cannot add an authorization header, append `?token=YOUR_WEBHOOK_TOKEN` to the webhook URL. Keep the bridge on a private Docker network because URLs can appear in proxy logs. Prefer the bearer header whenever the notification UI supports it.

## Operations

The webhook uses `WEBHOOK_TOKEN`. Administrative endpoints use `ADMIN_TOKEN`. Health is public.

Open `/admin/` in a browser and sign in with an enabled Jellyfin administrator account. JellyPass validates the credentials with Jellyfin, immediately closes the temporary Jellyfin session, and retains only its own 12-hour, HttpOnly, SameSite session cookie. Non-administrator Jellyfin accounts cannot sign in. Bearer-token API access remains available for automation. The UI supports grant inspection, dry-run plans, request revocation, shared-access groups, retroactive Jellyfin library search and imports, and global reconciliation.

The default **Dashboard** tab keeps access metrics together without crowding the working views and presents the eight newest Jellyseerr requests that have media IDs in the synchronized Jellyfin catalog. JellyPass scans past newer processing-only requests so every displayed card links to a real library item. Poster cards include requester, age, media type, and availability status; images are proxied through authenticated JellyPass routes, so the Jellyseerr API key and internal service URL never reach the browser. The header shows live sync health: green when the catalog and policies are current, orange when synchronization or policy attention is required, and red when disconnected. The **Library** tab maintains a synchronized catalog of Jellyfin movies and series. Search by title or year, filter by Jellyfin library, sort by title, date added, release year, request/access activity, or protection state, and paginate at 25, 50, or 100 results. Select up to 500 titles across pages, assign one audience of individual users and/or access groups, preview the complete change plan, then apply it in bulk. JellyPass updates each selected item once and consolidates the final blocked-tag set into at most one policy write per affected user. Manual users are stored separately from Jellyseerr request owners, so request lifecycle changes do not remove retroactively assigned access. The **Grants** tab tracks automated and manual grants and provides a preview-first policy reconciliation tool, while **Groups** manages shared audiences.

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

The service also reconciles on `RECONCILE_INTERVAL_SECONDS` (default: 300). Set it to `0` to disable scheduled reconciliation. This periodic pass protects local trailers that Jellyfin discovers after the title was granted. Run a manual reconciliation immediately after adding or importing a Jellyfin user.

The Jellyfin catalog synchronizes on startup when empty and every `CATALOG_SYNC_INTERVAL_SECONDS` (default: 3600). Set it to `0` to disable scheduled catalog sync; manual synchronization remains available from the Library tab and API.

### Household Jellyfin URLs and shared-access groups

Groups grant access in addition to the original requester. They can also act as households: each DNS-safe group ID receives a dedicated Jellyfin server URL whose login screen shows only that group's users. Jellyfin still performs authentication and authorization; the household URL changes profile discovery only and does not let one household member sign in as another.

Enable the household gateway with a base domain and host prefix:

```dotenv
HOUSEHOLD_DOMAIN=example.com
HOUSEHOLD_HOST_PREFIX=jelly-
```

With those settings, group `household` is available at `https://jelly-household.example.com`. The URL is shown on the group's card in the JellyPass UI. Point each household hostname (or suitable wildcard DNS record) at your reverse proxy, then proxy HTTP and WebSocket traffic to JellyPass on port `8787`. The reverse proxy must preserve the original `Host` header. Its TLS certificate must cover the generated hostname; a wildcard for `*.example.com` covers this single-label format.

Keep the normal Jellyfin URL available for administrators and devices that should see the complete public-user list. Unknown household hostnames fail closed with `404` instead of exposing that list. The household gateway also authorizes raw stream, playlist, and download paths against Jellyfin item visibility before proxying them, closing Jellyfin's direct-ID stream bypass for blocked items. A household URL is a convenience and privacy boundary for the login screen, not a replacement for Jellyfin user passwords, Jellyfin policy enforcement, or JellyPass library grants.

Group IDs are stable names chosen by the administrator. Use lowercase letters, numbers, and hyphens (maximum 63 characters) for groups that need a household hostname.

The operational Farmhouse origin and the path toward household-bound passwordless SSO are documented in [Household access and passwordless sign-in](docs/household-access.md).

### Optional JellyQuest request bridge

JellyPass can provide JellyQuest's passwordless Jellyseerr request session from the same household hostname. Enable it alongside the existing Jellyseerr configuration:

```dotenv
SEERR_URL=http://jellyseerr:5055
SEERR_API_KEY=replace-with-a-seerr-api-key
JELLYQUEST_BRIDGE_ENABLED=true
```

The Tizen package then uses `https://jelly-household.example.com/jellyquest-bridge/bridge.html`. No Jellyseerr files or reverse-proxy locations are required: JellyPass handles this prefix before forwarding other household traffic to Jellyfin.

The module signs the selected passwordless Jellyfin profile into Jellyseerr, verifies that Jellyseerr returns the same Jellyfin user ID, and stores Jellyseerr's session cookie only in JellyPass memory for 12 hours. The random browser token grants access only to the discovery, search, media-status, title-detail, and request-creation endpoints used by JellyQuest. Jellyseerr continues to own request data, permissions, approvals, and processing. Restarting JellyPass clears all bridge sessions.

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

Changing a group's membership immediately reconciles every item that references it and updates the household login screen on the next request. Removing the last request and last group cleans the private tag from the item and every user's block list.

Administrators can also create a real non-administrator Jellyfin account from the Groups tab and assign it to a household in the same workflow. Passwords are optional: leaving both fields blank creates a passwordless Jellyfin account, while a supplied password must contain 8–256 characters. JellyPass sends a supplied password directly to Jellyfin and never persists or returns it. Until household SSO is implemented, a passwordless account can be used by anyone who can reach Jellyfin and knows its username. When `SEERR_URL` and `SEERR_API_KEY` are configured, the form offers an opt-in option to import the new Jellyfin identity into Jellyseerr so it can own requests. The option is unchecked by default. Jellyseerr assigns its configured default permissions to imported accounts.

Provisioning is intentionally phased: Jellyfin account creation, household assignment, then optional Jellyseerr import. A later failure never rolls back an earlier successful phase. JellyPass reports whether Jellyseerr imported the user, already had it, or failed after the Jellyfin account and household membership were created, leaving the valid account intact for review.

## Access semantics and limitations

- Enforcement is performed by Jellyfin itself through item tags and each user's `BlockedTags` policy. JellyPass tags local trailer items explicitly because direct trailer playback is authorized separately from the parent title.
- Availability notifications occur after Jellyfin discovers the item. There is a small fail-open window before the webhook is processed.
- Seerr does not currently emit a request-deleted webhook with all fields needed for automatic revocation, so revocation uses the administrative API.
- Direct filesystem, DLNA, administrator, and other out-of-band access are outside this service's scope.
- The bridge merges only its own `jfa:private:*` tag and preserves unrelated item tags and blocked tags.
- A Jellyfin user policy is updated as a whole because that is how Jellyfin's API is shaped. Changes made concurrently in another admin UI can race; reconciliation restores the JellyPass-owned portion.
- Metrics intentionally contain counts and result labels only; they do not expose usernames, item names, API keys, or tokens.

## Administrative API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/grants` | Grants and persisted synchronization health |
| `GET` | `/v1/grants/{itemId}/plan` | Dry-run plan for one grant |
| `DELETE` | `/v1/grants/{itemId}/requests/{requestId}` | Revoke a requester; supports `?dryRun=true` |
| `PUT` | `/v1/grants/{itemId}/groups` | Replace shared groups; supports `?dryRun=true` |
| `PUT` | `/v1/grants/{itemId}/manual` | Create or update retroactive user/group access; supports `?dryRun=true` |
| `GET` | `/v1/groups` | List access groups |
| `GET` | `/v1/users` | List Jellyfin users for group management |
| `POST` | `/v1/users` | Create a non-administrator Jellyfin user and assign it to a group |
| `GET` | `/v1/library/search?q={title}` | Search Jellyfin movies and series for retroactive import |
| `GET` | `/v1/library/poster?itemId={itemId}` | Proxy poster artwork for a synchronized catalog item |
| `GET` | `/v1/library` | Read the synchronized movie and series catalog |
| `POST` | `/v1/library/sync` | Synchronize the catalog from Jellyfin |
| `PUT` | `/v1/library/access` | Assign one audience to up to 500 catalog items; supports `?dryRun=true` |
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

Implemented today: the JellyPass browser administration UI with Jellyfin administrator authentication, a synchronized and filterable Jellyfin catalog, optimized bulk audience assignment, single-title imports, idempotent request grants, legacy Jellyseerr request lookups, explicit revocation and cleanup, shared household groups, household-specific Jellyfin URLs, dry-run change plans, persistent sync failures, scheduled reconciliation, Prometheus metrics, state migrations, full HTTP integration tests, and container-backed tests against Jellyfin 10.11.3.

The next planned milestone is household-bound passwordless SSO; see [Household access and passwordless sign-in](docs/household-access.md). Other potential follow-ups include automatic revocation when Seerr exposes a suitable lifecycle webhook, grant expiration, signed webhooks, orphan discovery, and release images published to GHCR.

## License

[MIT](LICENSE)
