# Household access and passwordless sign-in

## Status

The first household entry point is operational at `jelly-farmhouse.starrgroup.io`. Nginx Proxy Manager proxy host 34 in Proxmox LXC 700 terminates TLS and forwards the original host to JellyPass on port 8787 in the Jellyseerr LXC 509. JellyPass then proxies Jellyfin 10.11.11.

The deployed household implementation was recovered from `/opt/jellyseerr-jellyfin-access` in LXC 509 into this workspace. It had been running from an uncommitted source tree ahead of GitHub `main`; live secrets, state, build output, and safety backups were not copied.

Read-only verification on 2026-09-01 confirmed:

- the household origin returns four public Jellyfin profiles, exactly matching the four user IDs in the `farmhouse` access group;
- Quick Connect is globally disabled;
- Jellyfin branding includes a `JellyPass household profile picker` rule;
- the manual-login form and the secondary login action area are hidden, removing Manual Login, Forgot Password, and Quick Connect from the page.

The recovered integration suite confirms that password authentication is still deliberately proxied through the household origin. The controls are hidden, but the corresponding API endpoints are not blocked. Household SSO is not implemented yet.

## Goal

Give every household its own JellyPass hostname, following the operational Farmhouse pattern:

```text
jelly-farmhouse.starrgroup.io
jelly-example.starrgroup.io
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
- Household login pages do not expose Manual Login, Forgot Password, or Quick Connect actions. This is implemented by augmenting Jellyfin's branding response for household hosts.
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
  "id": "farmhouse",
  "name": "Farmhouse",
  "userIds": ["jellyfin-user-id"],
  "createdAt": "2026-08-31T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z"
}
```

The hostname is derived rather than persisted. A future household-to-identity-provider mapping may reference the group ID, but identity-provider secrets do not belong in the state JSON file; they must be resolved from secret-backed configuration.

## Delivery sequence

1. Review, test, and commit the recovered deployed source so GitHub becomes the source of truth again.
2. Add a non-secret deployment runbook for the NPM wildcard/individual host, preserved `Host` header, TLS, and JellyPass household environment settings.
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
- Jellyfin exposes the global `QuickConnectAvailable` server setting.
- Presentation changes in Jellyfin Web do not disable the corresponding server authentication endpoints.

Upstream references:

- [Jellyfin user controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/UserController.cs)
- [Jellyfin server configuration](https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Configuration/ServerConfiguration.cs)
- [Jellyfin Web login controller](https://github.com/jellyfin/jellyfin-web/blob/master/src/apps/legacy/controllers/session/login/index.js)
- [Community SSO for Jellyfin](https://github.com/Flowfin/jellyfin-plugin-sso)
