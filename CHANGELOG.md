# Changelog

All notable changes to JellyPass are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Stopping the container waited for SIGKILL.** On `SIGTERM` or `SIGINT`
  JellyPass waited for every connection to close, and a proxied household
  WebSocket (an idle browser tab, for example) never does, so `docker stop`
  hung for 10 seconds and ended with exit code 137. Shutdown now stops the
  reconcile, catalog sync and backfill timers, stops accepting connections,
  closes proxied WebSockets on both sides, gives in-flight HTTP requests one
  second to finish while closing idle keep-alive connections, waits for any
  pending state-file write, and exits `0`, normally well under a second. If
  anything still hangs after five seconds it logs `shutdown timed out` and
  exits `1`. A second signal during shutdown is ignored rather than killing
  the process mid-write.

## [2.1.0] - 2026-10-16

This is a minor release. Most deployments can upgrade without changes, but
check two things first; [Upgrading from 2.0.0](#upgrading-from-200) has the
steps:

- **Without Seerr lookup, the webhook payload must include
  `"event": "{{event}}"`.** When `SEERR_URL` and `SEERR_API_KEY` are not
  configured, a webhook that has both Jellyfin IDs but no recognized HD `event`
  is now rejected with `502` instead of granted. The README template already
  includes `event`. Deployments with Seerr lookup are not affected.
- **Behind a reverse proxy, set the new `TRUSTED_PROXIES`** (optional) and add
  JellyPass to Jellyfin's known proxies to get real client addresses and
  per-client login limits. Without it, the login limits stay keyed on the
  connecting address, as in 2.0.0.

The state file format is unchanged (schema v7), so 2.0.0 can read a state file
written by 2.1.0.

### Added

- **`TRUSTED_PROXIES`.** A comma-separated list of reverse-proxy addresses and
  CIDR ranges (IPv4 and IPv6). When a request arrives from a listed proxy,
  JellyPass takes the client address for the login rate limits from
  `X-Forwarded-For`, walking it right to left past trusted hops. Requests from
  anywhere else use the connecting address and ignore the header. The same
  resolved address goes in the `X-Real-IP` header the household gateway sends
  to Jellyfin, but only when the request has none: an existing `X-Real-IP` is
  passed through unchanged, even from an untrusted client. Jellyfin does not
  read `X-Real-IP`, so rely on `X-Forwarded-For` downstream. Addresses are
  compared in canonical form, so IPv4-mapped IPv6 spellings count as the IPv4
  address and IPv6 case and zero compression do not matter. Empty by default,
  which keeps the previous behaviour; an invalid entry stops startup. See "Running behind a
  reverse proxy" in the README, including chains of proxies and CDNs.

### Changed

- **Webhooks without Seerr lookup need `event`.** When `SEERR_URL` and
  `SEERR_API_KEY` are not configured, the webhook payload must include
  `"event": "{{event}}"`, as the README template already does. A webhook
  with both Jellyfin IDs but without a recognized HD `event` is now rejected
  with `502` instead of granted. One without both IDs still returns `400`, as
  before, and a repeated webhook for an already handled request skips the
  check: it reapplies the recorded grant, or returns `202` ignored if an
  administrator revoked the request. The request backfill already needed Seerr
  lookup.
- **Dashboard recent requests.** The Dashboard, and
  `GET /v1/requests/recent`, now return up to 12 recent Jellyseerr requests
  instead of 8, so the poster grid fills evenly at four, three and two columns.
- **Release notes come from this changelog.** GitHub release notes are now
  this file's section for the tag instead of an automatically generated list
  of pull requests. A tag without a section here fails the release before any
  image is published.

### Fixed

- **4K webhooks with a missing or unrecognized `event`.** Without Seerr lookup,
  a webhook whose `event` was missing, empty, unfilled (`{{event}}`) or
  unrecognized was granted on the payload's media ID. Seerr fills that ID with
  the HD item even for a 4K request, so such a 4K notification could privatize
  the HD item and leave the 4K item public. These webhooks are now rejected
  with `502` and counted as `jfa_webhooks_total{result="error"}`, like a 4K
  event without Seerr lookup (a webhook missing its Jellyfin IDs keeps its
  `400`). With Seerr lookup configured they still resolve through Seerr.
- **Replayed webhooks restored grants an administrator removed.** The request
  backfill skipped requests already handled, but the webhook did not: a
  redelivered `MEDIA_AVAILABLE` webhook recreated a grant whose request an
  administrator had revoked, and reattached household groups an administrator
  had cleared. A request is now handled once its grant has been stored. A
  webhook for a handled request that a grant still records only reconciles
  that grant as it stands; one for a handled request that an administrator
  revoked returns `202` with `{"status":"ignored"}` and counts as
  `jfa_webhooks_total{result="ignored"}`. A delivery that failed before its
  grant was stored is still retried as a first delivery.
- **Webhook state-write failures are counted.** A webhook whose grant could
  not be written to the state file was rejected without incrementing
  `jfa_webhooks_total`. Every failure after the body is validated (resolving,
  storing or applying the grant) now counts exactly once as
  `{result="error"}`; malformed bodies still count only as `{result="invalid"}`.
- **Concurrent state-file writes.** Turning passwordless sign-in on or off
  bypassed the queue that serializes other changes, and overlapping state-file
  writes shared one temporary file. Several passwordless changes at once, or
  one during a grant, failed with `ENOENT` and could lose changes. Passwordless
  changes now wait their turn like other changes, the state file is written by
  one write at a time, and each write uses its own temporary file.
- **Recent requests cache.** The 60-second recent-requests cache kept only as
  many requests as the last caller asked for and ignored the catalog it was
  filtered against. A larger request within a minute got the smaller list, and
  a catalog sync could keep serving requests filtered for the old catalog. The
  cache now always holds up to 20 requests per catalog and serves each caller
  the count it asks for.
- **Household gateway forwarding headers.** Proxied HTTP requests and
  WebSocket upgrades now append the gateway's peer address to
  `X-Forwarded-For` instead of passing the incoming header through unchanged,
  and set `X-Forwarded-Proto` and `X-Real-IP` when they are missing. With
  JellyPass, and any reverse proxy in front of it, in Jellyfin's known proxies,
  Jellyfin sees the real client address.
- **Login rate limits behind a reverse proxy.** The household and
  administrator login limits keyed every client behind a proxy on the proxy's
  address, so one household could lock out all of them. With
  `TRUSTED_PROXIES` set, they now apply per client. Each limit tracks at most
  10,000 clients, evicting the oldest, and drops expired entries as it goes
  instead of scanning every entry on each attempt. Lockouts are therefore
  best-effort: a flood from that many genuinely distinct addresses can evict
  one early, while a spoofed `X-Forwarded-For` from an untrusted peer cannot.

### Upgrading from 2.0.0

1. **Back up the state file**, as before any upgrade. 2.1.0 keeps the schema
   v7 format and does not migrate the file, so rolling back to 2.0.0 needs no
   edit: set `JELLYPASS_IMAGE=ghcr.io/nicklongmore86/jellypass:2.0.0` and
   recreate the container with `docker compose up -d`. The backup still
   protects against anything else going wrong.
2. **Without Seerr lookup, check the webhook payload.** If `SEERR_URL` and
   `SEERR_API_KEY` are not set, make sure the Seerr webhook payload includes
   `"event": "{{event}}"` (see the README template). A webhook that has both
   Jellyfin IDs but no recognized HD `event` now fails with `502` and counts
   as `jfa_webhooks_total{result="error"}`. One without both IDs still returns
   `400`, as before. A repeated webhook for a request JellyPass has already
   handled skips this check: it reapplies the recorded grant, or returns `202`
   ignored if an administrator revoked the request. With Seerr lookup
   configured, nothing changes.
3. **Optional, behind a reverse proxy: set `TRUSTED_PROXIES`** to the address
   or subnet of the proxy in front of JellyPass, and add JellyPass and that
   proxy to Jellyfin's known proxies (**Dashboard → Networking → Known
   proxies**). Make sure the proxy appends to `X-Forwarded-For`. With a CDN in
   front of the proxy, follow "Chains of proxies and CDNs" in the README. An
   invalid entry stops startup, so check the logs after restarting. Leaving
   `TRUSTED_PROXIES` empty keeps the 2.0.0 behaviour.
4. **Expect some repeated webhooks to be ignored.** Seerr redeliveries for
   requests JellyPass has already handled, including requests handled by
   2.0.0, no longer recreate revoked grants or reattach removed groups. A
   redelivery for a revoked request counts as
   `jfa_webhooks_total{result="ignored"}`, so a small increase there is
   expected.

## [2.0.0] - 2026-10-15

This release has three breaking changes. Read
[Upgrading from 1.1.0](#upgrading-from-110) before you deploy it:

- JellyQuest for Tizen is no longer supported. The request bridge, the
  `/jellyquest-bridge/*` endpoints, the relayed `/jellyquest/access` paths and
  self-service claims are removed, and `JELLYQUEST_BRIDGE_ENABLED` is ignored.
- The state file is migrated to schema v7, which 1.1.0 cannot read. Rolling
  back requires a backup taken before the upgrade or a manual edit of the state
  file.
- A webhook for a 4K request is never granted on the HD item. A webhook whose
  `event` names a 4K request now fails with `502` when `SEERR_URL` and
  `SEERR_API_KEY` are not configured, and with `400` when Seerr does not know
  the 4K item yet. Before, both granted the HD item.

### Removed

- **JellyQuest request bridge.** `bridge.html`, `/jellyquest-bridge/health`,
  `/jellyquest-bridge/session` and `/jellyquest-bridge/proxy` are gone, along
  with the in-memory Jellyseerr bridge sessions, the Jellyseerr relay and its
  response scrubbing.
- **Eligibility checks.** `POST /jellyquest-bridge/eligibility` is gone.
- **Self-service access claims ("Add to My Library").** The
  `GET`/`POST /jellyquest/access` and `GET /jellyquest/access/claims` paths,
  relayed through `POST /jellyquest-bridge/proxy`, are gone with the bridge.
  They were never HTTP routes on JellyPass itself.
  JellyPass no longer stores claims or adds claimants to a grant when a claimed
  title becomes available.
- **Configuration.** `JELLYQUEST_BRIDGE_ENABLED` is no longer read. If it is
  still set, JellyPass logs a warning at startup and starts normally.

Household grants, the request backfill, household hostnames, passwordless
sign-in, the admin UI and API, and metrics are unchanged. The Seerr webhook
changes as described under Changed below.

### Changed

- **The webhook looks up Seerr unless both IDs are present and the event
  identifies an HD request.** JellyPass now trusts the webhook's
  `jellyfinMediaId` and `jellyfinUserId` when both are present and the
  payload's `event` is `Movie Request Now Available`, `Series Request Now
  Available`, `Movie Now Available` or `Series Now Available`. Before, any
  webhook without a TMDB ID triggered a Seerr request lookup. Seerr's
  `{{media_jellyfinMediaId}}` is the HD item even for 4K requests, so JellyPass
  still asks Seerr when `event` names a 4K request (`4K …`) or is missing or
  unrecognized. Add `"event": "{{event}}"` to your webhook payload (see the
  README) to skip the lookup for HD requests. A `tmdbId` in the payload is now
  ignored.
- **A 4K request is never granted on the HD item.** A 4K event without
  `SEERR_URL` and `SEERR_API_KEY` configured is rejected with `502`. A 4K
  request whose 4K item Seerr does not know yet is rejected by the webhook with
  `400` and granted by the request backfill once the 4K item exists (when the
  request backfill is enabled). Before, the webhook granted the HD item in both
  cases.
- **Failed webhook resolution counts as an error.** A failed Seerr lookup, a
  webhook missing Jellyfin IDs without Seerr configured, and a rejected 4K
  event now count as `jfa_webhooks_total{result="error"}`. Before, they were
  not counted.

### Upgrading from 1.1.0

1. **Breaking (rollback): back up the state file before upgrading.** On first
   start the state file is migrated to schema v7 and the stored claims are
   dropped. 1.1.0 refuses to start on a v7 file
   (`unsupported state schema version`). To roll back, either:
   - restore the backup taken before the upgrade. This loses grants, groups and
     other changes made after the upgrade; or
   - downgrade the state file by hand: stop JellyPass, edit the state file to
     set `"version": 6` and add `"claims": {}` at the top level, then start
     1.1.0. Grants, groups, passwordless users and handled request IDs are
     kept. Claims dropped by the upgrade are not restored.
2. **Grants are kept.** Users who were added to a grant through a claim are
   ordinary manual users on that grant and keep their access. Claims for titles
   that never became available are discarded.
3. **Removed endpoints are no longer handled.** On the JellyPass origin, calls
   to `/jellyquest-bridge/*` or `/jellyquest/access*` return `401` without admin
   credentials (`404` with them). On a household hostname the path is passed to
   Jellyfin like any other unknown path.
4. **Remove `JELLYQUEST_BRIDGE_ENABLED`** from your `.env` or compose file to
   silence the startup warning.
5. **Optional: add `"event": "{{event}}"` to the Seerr webhook payload** (see
   the README). With it, JellyPass trusts the payload's IDs for HD requests and
   skips the Seerr lookup, and recognizes 4K requests. Without it, every
   webhook is resolved through Seerr when Seerr is configured; without Seerr,
   JellyPass cannot tell a 4K request from an HD one.

## [1.1.0] - 2026-10-15

This release has three breaking changes. Read
[Upgrading from 1.0.0](#upgrading-from-100) before you deploy it:

- The JellyQuest bridge requires a Jellyfin access token for sessions and
  eligibility checks, so older JellyQuest for Tizen builds stop working.
- `/api/v1/media` is no longer relayed through the bridge and returns `403`.
- The state file is migrated to schema v6, which 1.0.0 cannot read. Rolling
  back requires a backup taken before the upgrade.

### Security

- **Bridge sessions require a Jellyfin access token** ([#1]). Before this
  change, `POST /jellyquest-bridge/session` signed into Jellyseerr using a
  username and Jellyfin user ID supplied by the client. Anyone who knew a
  passwordless member's name and ID could act as that member. The bridge now
  checks the token with Jellyfin's `GET /Users/Me` and takes the user ID and
  name only from Jellyfin's response. A client `id` that does not match returns
  `401`. A missing, malformed or invalid token, or a disabled user, also returns
  `401`, and no Jellyseerr login is attempted. If Jellyfin cannot be reached the
  bridge returns `502`. A session is checked against Jellyfin again at most every
  five minutes while it is in use, so a revoked token ends the session.
- **`POST /jellyquest-bridge/eligibility` requires the same token** ([#7]). It
  answers only for the token's own user, so it can no longer be used to find out
  whether another profile has a Jellyseerr account. A client `id` that differs
  from the verified user returns `401`. The bridge never falls back to the ID in
  the request body.
- **Bridge claim listings show only the caller's own claims** ([#6]).
  `GET /jellyquest/access/claims` no longer returns other claimants' Jellyfin
  user IDs, shared timestamps or private item IDs. Access-status responses
  include `jellyfinItemId` only when the caller can already open the item.
- **Relayed Jellyseerr data is scoped to the caller** ([#6], [#7]):
  - `GET /api/v1/request` is always sent with `requestedBy` set to the
    caller's Jellyseerr user ID.
  - Requests, watchlist entries, issues and comments by other users are
    removed. So are other users' records and IDs, `modifiedBy`/`updatedBy`,
    timestamps on records the caller does not own, and Jellyfin item IDs the
    caller cannot open. Paging totals are recomputed from the rows that remain.
  - Identity, owner, timestamp and item-ID keys are matched in any case and
    separator style. The TMDB credit exception applies only to a TV show's
    top-level `createdBy` list.
- **`/api/v1/media` is no longer relayed** through the bridge and returns
  `403` ([#6]). Its filters and sort orders revealed other households' request
  activity.
- **Jellyseerr error messages are no longer relayed** ([#6]). The bridge keeps
  the status code and returns a fixed message for it.

### Fixed

- The household gateway no longer crashes on `ECONNRESET` or other socket
  errors on proxied WebSocket and HTTP streams ([#4]).
- The gateway cleans up after a client disconnects ([#4], [#5]):
  - The pending upstream request is aborted when the client disconnects or
    half-closes (FIN) during a WebSocket handshake.
  - Upstream requests are released when the client leaves mid-response.
  - Upstream resets close the client response instead of leaving it open.
- Seerr test notifications, and any other event that is not
  `MEDIA_AVAILABLE`, return `202 {"status":"ignored"}` once the token is
  accepted. They no longer require request or media IDs ([#2]).
- Jellyfin 12 authorization: JellyPass sends its credentials in a `MediaBrowser`
  `Authorization` header (ade1925).
- Collections no longer appear in the library catalog (a5be372).
- Household login pages keep Jellyfin's password field, so members can enter a
  password after choosing a profile. This fixes iOS sign-in (55bdfc4).

### Added

- **Household-scoped request grants** ([#2]). A request grant also assigns every
  access group the requester belongs to, so the requester's household can see
  the title and other households cannot. Existing groups and manual users on
  the grant are kept.
- **Request backfill** ([#2]). The backfill imports available Seerr requests
  that the webhook missed:
  - It runs about 5 seconds after startup and before each reconcile.
  - It is configured with `REQUEST_BACKFILL_SINCE` and
    `REQUEST_BACKFILL_ENABLED`. It is off until `REQUEST_BACKFILL_SINCE` is set,
    and it imports only requests created at or after that time.
  - JellyPass refuses to start if the backfill is enabled without `SEERR_URL`
    and `SEERR_API_KEY`, if `REQUEST_BACKFILL_ENABLED=true` is set without
    `REQUEST_BACKFILL_SINCE`, or if `REQUEST_BACKFILL_SINCE` is not a valid
    date.
  - It is idempotent and never recreates a grant an administrator removed.
    (A replayed webhook could still recreate one in this release; see the
    2.1.0 fixes.)
- **Webhook and backfill metrics** in `/metrics` ([#2]):
  - `jfa_last_webhook_received_timestamp_seconds`
  - a new `result="invalid"` label on the existing `jfa_webhooks_total`
  - `jfa_request_backfill_total`
  - `jfa_request_backfill_last_run_timestamp_seconds`
- **Idle WebSocket timeouts** on the household gateway ([#8]):
  - `WS_IDLE_TIMEOUT_MS` (default `300000`) closes a connection with no traffic
    in either direction.
  - `WS_UPSTREAM_IDLE_TIMEOUT_MS` (default `180000`) closes a connection when
    Jellyfin sends nothing, even while the client keeps sending.
  - `0` disables either timeout. JellyPass refuses to start if either value is
    not an integer or is above `86400000`.
  - TCP keepalive is enabled on both sockets.
- **`LOG_LEVEL`** ([#5], [#8]): `debug`, `info`, `warn` or `error`,
  case-insensitive. The aliases `trace`, `verbose`, `information`, `warning`
  and `err` are accepted. An unrecognised value logs a warning and falls back
  to `info`. Only `debug` changes output today: it also logs routine client
  disconnects, idle closes, and backfill requests skipped because their
  Jellyfin item was deleted.
- **One-tap household sign-in** for passwordless members (fec84b1):
  - `PUT /v1/users/{userId}/sign-in` turns it on or off for a user.
  - The group dialog has a "One-tap sign-in" checklist.
  - The state file schema moves from v5 to v6.

### Changed

- Expected client disconnects (`ECONNRESET`, `EPIPE`, aborted streams) are
  logged only at `LOG_LEVEL=debug` ([#5], [#8]). Resets on the Jellyfin side
  and other unexpected proxy errors still log warnings.
- The webhook rejects an unfilled `{{notification_type}}` with `400` and
  counts it as invalid ([#2]).
- The bridge refuses to open a session (`502`) when it cannot find the
  caller's Jellyseerr user ID ([#6]).
- Revoking a request leaves the household groups it attached ([#2]), so the
  title stays visible to those households instead of becoming public. To make
  it public, clear the grant's groups (UI or `PUT /v1/grants/{itemId}/groups`);
  it becomes public once no other requests or manual users remain. A requester
  in no household still gets a user-only grant, which becomes public when its
  last request is revoked, as before.

### Not included

- [#3] (limit self-service claims to the claimant's household) was closed
  without merging. Self-service claims across households are still allowed on
  purpose. [#6] hides who else holds or requested a title instead.

### Upgrading from 1.0.0

1. **Breaking (rollback): back up the state file before upgrading.** 1.1.0
   migrates the state file to schema v6 on first start. 1.0.0 refuses to start
   on a v6 file (`unsupported state schema version`), so rolling back requires
   restoring the backup taken before the upgrade.
2. **Breaking: update JellyQuest for Tizen with this release.** The app must
   add `token=<Jellyfin AccessToken>` to the bridge URL fragment in both modes,
   using the access token it already uses with Jellyfin:

   ```text
   bridge.html#mode=session&nonce=…&id=<jellyfin-user-id>&token=<access-token>
   bridge.html#mode=eligibility&nonce=…&id=<jellyfin-user-id>&token=<access-token>
   ```

   Older app builds cannot open request sessions or run eligibility checks.
   `/eligibility` now returns `401` for a missing or rejected token. As before,
   the bridge page reports any failed eligibility check to the app as an `error`
   message rather than an `eligibility` message; only the `401` cause is new. The
   app should treat that `error` as "cannot check" rather than as a definite
   answer.
3. **Breaking: `/api/v1/media` is no longer relayed** through the bridge and
   returns `403`. JellyQuest does not use it.
4. **Turn on the request backfill.** Set `REQUEST_BACKFILL_SINCE` to when your
   Seerr webhook stopped delivering, or to your 1.0.0 install date if it never
   worked, for example `REQUEST_BACKFILL_SINCE=2026-09-10`. The backfill stays
   off until this is set, and JellyPass refuses to start if the backfill is
   enabled without `SEERR_URL` and `SEERR_API_KEY`. About 5 seconds after
   startup, available requests created at or after that time that the webhook
   missed get household-scoped grants. Requests created before it stay public
   by design. Assign those from the Library tab if they should be private.
5. **Optional new settings.** All have safe defaults:

   | Variable | Default |
   | --- | --- |
   | `LOG_LEVEL` | `info` |
   | `WS_IDLE_TIMEOUT_MS` | `300000` (`0` disables) |
   | `WS_UPSTREAM_IDLE_TIMEOUT_MS` | `180000` (`0` disables) |
   | `REQUEST_BACKFILL_ENABLED` | `true` when `REQUEST_BACKFILL_SINCE` is set |

   JellyPass refuses to start if a `WS_*` value is not an integer or is above
   `86400000`. Values at or below `60000` log a startup warning, because
   Jellyfin itself drops sockets after 60 seconds without a keepalive.
6. **Mark existing passwordless members.** The v5 to v6 migration does not mark
   anyone as passwordless; only users created without a password afterwards are
   marked automatically. Mark existing passwordless members in the group
   dialog's "One-tap sign-in" list. Administrators cannot be marked. Do not mark
   a user who has a password: the household URL then skips the password form,
   and they cannot sign in there.
7. **Check the Seerr webhook.** Enter the payload in Seerr's webhook settings
   (UI or API) and let Seerr save it. A payload edited by hand in Seerr's
   `settings.json` is not stored in Seerr's own encoding and arrives malformed or
   not at all. A test notification should now return `202 {"status":"ignored"}`.
   After that, check `jfa_last_webhook_received_timestamp_seconds` and
   `jfa_webhooks_total{result="invalid"}` in `/metrics`.
8. **Revoking a request keeps its household groups.** Revoking a request
   leaves the household groups it attached, so the title stays visible to those
   households instead of becoming public. To make it public, clear the grant's
   groups (UI or `PUT /v1/grants/{itemId}/groups`); it becomes public once no
   other requests or manual users remain. A requester in no household still
   gets a user-only grant, which becomes public when its last request is
   revoked, as before.

## [1.0.0] - 2026-09-10

First versioned release.

[Unreleased]: https://github.com/nicklongmore86/jellypass/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/nicklongmore86/jellypass/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/nicklongmore86/jellypass/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/nicklongmore86/jellypass/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/nicklongmore86/jellypass/releases/tag/v1.0.0
[#1]: https://github.com/nicklongmore86/jellypass/pull/1
[#2]: https://github.com/nicklongmore86/jellypass/pull/2
[#3]: https://github.com/nicklongmore86/jellypass/pull/3
[#4]: https://github.com/nicklongmore86/jellypass/pull/4
[#5]: https://github.com/nicklongmore86/jellypass/pull/5
[#6]: https://github.com/nicklongmore86/jellypass/pull/6
[#7]: https://github.com/nicklongmore86/jellypass/pull/7
[#8]: https://github.com/nicklongmore86/jellypass/pull/8
