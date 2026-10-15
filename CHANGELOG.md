# Changelog

All notable changes to JellyPass are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Revoking a request no longer removes the household groups the request
  attached ([#2]). The title stays visible to those households instead of
  becoming public. To make it public, clear the grant's groups (UI or
  `PUT /v1/grants/{itemId}/groups`). The title becomes public only once no
  other requests or manual users remain on the grant.
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
  disconnects and idle closes.
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
8. **Revoking a request no longer makes a title public.** It no longer removes
   the household groups the request attached, so the title stays visible to
   those households. To make it public, clear the grant's groups in the UI or
   with `PUT /v1/grants/{itemId}/groups`. That works only once no other requests
   or manual users remain on the grant.

## [1.0.0] - 2026-09-10

First versioned release.

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
