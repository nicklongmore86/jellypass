# Household access and passwordless sign-in

## Status

A household hostname is served by a TLS-terminating reverse proxy that forwards the original `Host` header to JellyPass, which then proxies Jellyfin.

Read-only verification of a deployed household origin on 2026-09-01 confirmed:

- the household origin returns four public Jellyfin profiles, exactly matching the four user IDs in that household's access group;
- Quick Connect is globally disabled;
- Jellyfin branding includes a `JellyPass household profile picker` rule;
- the direct Manual Login action and secondary login controls are hidden,
  removing arbitrary username entry, Forgot Password, and Quick Connect while
  preserving the password prompt after an allowed profile is selected.

The recovered integration suite confirms that password authentication is still deliberately proxied through the household origin. The controls are hidden, but the corresponding API endpoints are not blocked. Household SSO is not implemented yet.

## Goal

Give every household its own JellyPass hostname, following the pattern of the first household:

```text
jelly-household-a.example.com
jelly-household-b.example.com
```

Jellyfin clients use the household hostname as their server address. JellyPass uses that hostname to present only the household's users instead of the server-wide public-user list. The final sign-in experience is passwordless and uses an identity provider assigned to that household.

The administrator retains a separate recovery path that is not exposed through household hostnames.

## Required behavior

### Household-scoped discovery

- An access group's stable ID is also its household ID; its Jellyfin user IDs are the visible household members.
- The hostname is derived from `HOUSEHOLD_HOST_PREFIX + group ID + HOUSEHOLD_DOMAIN`.
- Requests with an unknown or ambiguous hostname fail closed. They must not fall back to the complete Jellyfin user list.
- `GET /Users/Public` is intercepted on a household hostname and filtered to that household's user IDs.
- The response preserves Jellyfin's schema and the upstream ordering of the remaining users.
- All other supported Jellyfin traffic is proxied without buffering large media bodies and with range requests, streaming, and WebSocket upgrades preserved.
- JellyPass trusts the HTTP `Host` authority only when traffic comes through the deployment's trusted reverse proxy. TLS and DNS ownership remain outside the application.

Filtering public discovery is a usability and privacy boundary. It is not authorization: authenticated Jellyfin policy remains the authority for media access.

### Remove legacy login paths

- Quick Connect is disabled globally in Jellyfin (`QuickConnectAvailable=false`).
- Household origins independently return a non-cacheable `false` from `GET /QuickConnect/Enabled` so stale or accidental global configuration cannot advertise Quick Connect there.
- Household origins also refuse every other Quick Connect call themselves, so enabling Quick Connect in Jellyfin never opens a sign-in that skips the membership check below: `/QuickConnect/Initiate`, `/QuickConnect/Connect`, `/QuickConnect/Authorize`, `/Users/AuthenticateWithQuickConnect`, any other path under `/QuickConnect`, and `/QuickConnect/Enabled` by any method but `GET` get a fixed, non-cacheable `403 {"error":"household_quick_connect_disabled"}`, the same for every caller, and never reach Jellyfin. A WebSocket upgrade to any of them is answered `404` and never reaches Jellyfin either.
- The [Streamyfin](https://github.com/streamyfin/jellyfin-plugin-streamyfin) plugin's routes (`/Streamyfin` and below) get a fixed, non-cacheable `404 {"error":"not_found"}` on household origins and never reach Jellyfin, so the plugin, if installed, cannot hand its settings (Seerr's API key among them) to household users.
- Every path decision on a household origin (these, and the sign-in, public-users, branding, password-recovery, sign-out, protected-media and `/jellypass/...` ones below) is made on the route Jellyfin takes the path to: each segment percent-decoded once, in any case, with empty segments (trailing or repeated slashes) dropped, and with Jellyfin's legacy `/emby` or `/mediabrowser` prefix removed. This may match a path Jellyfin does not route (repeated slashes), never the other way round. A request that matches no check is sent to Jellyfin as the client spelled it.
- A path Jellyfin might read otherwise than the gateway is refused with a fixed, non-cacheable `400 {"error":"invalid_request"}` and never reaches Jellyfin (a WebSocket upgrade gets `400` too): a target that is not a path, a raw backslash, `#` or character outside printable ASCII, invalid percent-encoding, an encoded slash or backslash (Jellyfin keeps it inside its segment), a `.` or `..` segment, encoded or not (Jellyfin resolves it), a control character, anything still percent-encoded after one decoding, or a legacy prefix after another.
- Jellyfin's obsolete `POST /Users/{id}/Authenticate` signs anyone in by ID and password, so for an ID that is no member's a household origin answers the same `401 {"error":"invalid_credentials"}` as for a non-member's name, after the same delay, without asking Jellyfin. A member's is sent to Jellyfin.
- Household login pages do not expose Forgot Password, Quick Connect or server selection. Manual Login stays: Jellyfin leaves hidden users off its public list (and so off the household's picker), and a hidden member signs in by typing their name. This is implemented by augmenting Jellyfin's branding response for household hosts.
- `POST /Users/AuthenticateByName` on a household host signs in only that household's members. The name is looked up in Jellyfin's full user list (hidden users included, matched case-insensitively), Jellyfin is asked to sign in that member by their own name, and a session for anyone else is revoked at once. Only a sign-in that works is answered by Jellyfin; every other attempt gets one of three fixed answers, with the same headers, no sooner than one second after it arrived, none of them depending on whether the name is a member's:
  - `400 {"error":"invalid_request"}` for a request Jellyfin would refuse whoever it named: no `Authorization` (or `X-Emby-Authorization`) header with the `MediaBrowser` (or `Emby`) scheme and a non-empty `Client`, `Device`, `DeviceId` and `Version`, or a body that is not `{"Username": string, "Pw": string}`. This is decided before the name is looked up.
  - `502 {"error":"jellyfin_unavailable"}` when Jellyfin's user list cannot be read. It is read for a member and for any other name alike: a member's sign-in that Jellyfin fails or never answers (15 seconds) reads the list afresh, as a name not found in a reused list does.
  - `401 {"error":"invalid_credentials"}` (never Jellyfin's own text) for everything else: a name that is no member's, a wrong password, and any other answer Jellyfin gives a member but success.

  Every attempt counts toward the same per-client limit (20 in 5 minutes).
- Members marked passwordless in JellyPass sign in with one tap. Jellyfin reports `HasPassword: true` for every public user, including accounts with an empty password, so its web client always shows the password form. On household hosts, JellyPass rewrites `HasPassword` and `HasConfiguredPassword` to `false` for marked members, and the web client then authenticates them with an empty password as soon as the profile is selected. Users created without a password are marked automatically; existing users are marked in the group dialog's "One-tap sign-in" list or with `PUT /v1/users/{userId}/sign-in`. Administrators cannot be marked. This is an interim step until household SSO replaces local login.
- Hiding controls is not sufficient enforcement. When SSO replaces local login, household entry points must also reject unauthenticated password-login and password-recovery routes, including `POST /Users/AuthenticateByName`, `POST /Users/ForgotPassword`, and `POST /Users/ForgotPassword/Pin`.
- Existing authenticated Jellyfin API traffic must continue to work; changing a password from an authenticated account is a separate policy decision.
- An administrator-only recovery origin remains available for emergencies and must not share a household hostname.

### Household SSO

- Each household can be assigned an OIDC provider configuration or an isolated tenant/connection within a shared provider.
- Starting sign-in from a household hostname always selects that household's provider; users cannot choose another household in the browser.
- The callback is bound to the initiating household with signed, expiring state and an exact redirect URI allowlist.
- An identity is mapped to an explicitly allowed Jellyfin user. Matching only on an unverified display name or email is not sufficient.
- First-login user creation, if enabled later, is allowlisted per household, idempotent, and auditable. It never creates an administrator.
- Jellyfin accounts managed through SSO have unusable random local passwords and no user-facing reset path.
- Removing a user from a household revokes new household sign-ins. Session/token revocation policy will be specified before automatic provisioning ships.

## Boundary model

An access group currently serves both purposes:

- it grants its Jellyfin users access to private media records;
- when the household gateway is configured, its ID derives a hostname and its members become that hostname's visible profiles.

Current persisted shape:

```json
{
  "id": "household-a",
  "name": "Household A",
  "userIds": ["jellyfin-user-id"],
  "createdAt": "2026-08-31T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z"
}
```

The hostname is derived rather than persisted. A future household-to-identity-provider mapping may reference the group ID, but identity-provider secrets do not belong in the state JSON file; they must be resolved from secret-backed configuration.

## Delivery sequence

1. Review, test, and commit the deployed source so GitHub becomes the source of truth again.
2. Add a non-secret deployment runbook for the reverse proxy's wildcard or per-household host, preserved `Host` header, TLS, and JellyPass household environment settings.
3. Add an external smoke test for the existing origin: expected household membership, Quick Connect disabled, login controls hidden, media byte ranges, and WebSocket upgrade behavior.
4. Define the native-client SSO handoff and the separate administrator recovery origin.
5. Add household-bound OIDC and explicit identity-to-Jellyfin-user mappings.
6. Only when SSO works for the supported clients, reject password-login and password-recovery routes on household origins and rotate managed accounts to unusable random local passwords.
7. Add optional controlled identity provisioning and session/token revocation.

The SSO step needs an explicit native-client design. The maintained Community SSO plugin supports non-web clients through Quick Connect, which conflicts with the requirement to disable Quick Connect globally. JellyPass must therefore provide and test its own client handoff, adopt a different supported mechanism, or formally limit the first passwordless release to compatible clients.

## Acceptance criteria for the repeatable hostname milestone

- Two configured household hostnames return disjoint public-user lists from the same Jellyfin server.
- Unknown hosts never reveal users.
- A user belonging to multiple households appears only on those households' hostnames.
- Duplicate normalized hostnames are rejected at configuration time.
- Host matching is case-insensitive, ignores a valid port, and rejects malformed authorities.
- Filtering failures fail closed rather than returning the unfiltered upstream response.
- Authenticated media requests, byte ranges, and WebSocket upgrades survive the proxy unchanged.
- Logs and metrics identify households by stable ID and do not expose usernames, tokens, passwords, or identity claims.

## Relevant upstream behavior

- Jellyfin supplies its login picker from unauthenticated `GET /Users/Public`.
- Jellyfin Web renders Manual Login and Forgot Password independently of whether public users exist; Quick Connect visibility comes from `GET /QuickConnect/Enabled`.
- Jellyfin exposes the global `QuickConnectAvailable` server setting. A fresh Jellyfin 10.11 has it on.
- Jellyfin 10.11 routes `/emby/...` and `/mediabrowser/...` (in any case, percent-encoded or not) as the same path without that prefix. It percent-decodes every segment but keeps `%2F` inside its segment, resolves `.` and `..` segments (encoded or not), matches route literals case-insensitively in ASCII only, accepts one trailing slash but not repeated ones, and still routes `POST /Users/{id}/Authenticate?pw=`.
- Presentation changes in Jellyfin Web do not disable the corresponding server authentication endpoints.

Upstream references:

- [Jellyfin user controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/UserController.cs)
- [Jellyfin server configuration](https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Configuration/ServerConfiguration.cs)
- [Jellyfin Web login controller](https://github.com/jellyfin/jellyfin-web/blob/master/src/apps/legacy/controllers/session/login/index.js)
- [Community SSO for Jellyfin](https://github.com/Flowfin/jellyfin-plugin-sso)
