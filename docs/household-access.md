# Household access and passwordless sign-in

## Status

A household address is served by a TLS-terminating reverse proxy that forwards the original `Host` header to JellyPass's member listener, which then proxies Jellyfin. Since 4.0.0 a household's addresses are whatever HTTPS origins the administrator maps to it (any hostname, an optional port); the admin site is on a separate, private admin listener and never on the member listener.

Read-only verification of a deployed household origin on 2026-09-01 confirmed:

- the household origin returns four public Jellyfin profiles, exactly matching the four user IDs in that household's access group;
- Quick Connect is globally disabled;
- Jellyfin branding includes a `JellyPass household profile picker` rule;
- the direct Manual Login action and secondary login controls are hidden,
  removing arbitrary username entry, Forgot Password, and Quick Connect while
  preserving the password prompt after an allowed profile is selected.

The recovered integration suite confirms that password authentication is still deliberately proxied through the household origin. The controls are hidden, but the corresponding API endpoints are not blocked. Household SSO is not implemented yet.

## Goal

Give every household its own JellyPass address, mapped to it in the admin API. The hostname can be any name the administrator controls, for example:

```text
https://media.example.com        → household-a
https://films.example.net:8443   → household-b
```

Jellyfin clients use the household address as their server address. JellyPass uses that address to present only the household's users instead of the server-wide public-user list. The final sign-in experience is passwordless and uses an identity provider assigned to that household.

The administrator retains a separate recovery path that is not exposed through household addresses.

## Required behavior

### Household-scoped discovery

- An access group's stable ID is also its household ID; its Jellyfin user IDs are the visible household members.
- A household's addresses come from the address map in the state file: a canonical origin and aliases per household (`PUT /v1/groups/{id}/addresses`). The `Host` header is matched exactly against them, case-insensitively and with default ports normalised; no naming rule applies. Installs from before 4.0.0 keep the legacy derived address `HOUSEHOLD_HOST_PREFIX + group ID + "." + HOUSEHOLD_DOMAIN` (prefix `jelly-` by default) as an extra address of every household; an address both would give is a configuration error.
- Requests with an unknown hostname fail closed with a fixed `421` on the member listener. They must not fall back to the complete Jellyfin user list, nor to the admin site.
- A request that does not name exactly one host (two `Host` headers, a `Host` that is not a plain `host[:port]`, an absolute-form target whose authority is not the `Host`) fails closed with a fixed `400 invalid_host` on both listeners, before a household is chosen, so a proxy and JellyPass can never read different hosts.
- `GET /Users/Public` is intercepted on a household address and filtered to that household's user IDs.
- The response preserves Jellyfin's schema and the upstream ordering of the remaining users.
- Household hosts refuse request paths containing `//`, including after one percent-decode, with the fixed JSON `404 {"error":"not_found"}` before interception or relay. WebSocket upgrades receive the same refusal and close cleanly. A single trailing slash remains allowed; query values are unaffected. Clients must not send `//` in paths. Tests show that real Jellyfin returns `404` for repeated-slash discovery paths and stock jellyfin-web's `config.json` has `servers: []`. This is precautionary hardening, not a confirmed data disclosure.
- All other supported Jellyfin traffic is proxied without buffering large media bodies and with range requests, streaming, and WebSocket upgrades preserved.
- JellyPass reads the household from the HTTP `Host` authority only, never from `X-Forwarded-Host`. It cannot tell whether a request came through the reverse proxy, so the member listener must be reachable only by that proxy, which must pass the browser's `Host` on unchanged. `TRUSTED_PROXIES` (required with the gateway on) governs which peers' `X-Forwarded-For` is believed for rate limits; it does not gate `Host`. TLS and DNS ownership remain outside the application.

Filtering public discovery is a usability and privacy boundary. It is not authorization: authenticated Jellyfin policy remains the authority for media access.

### Remove legacy login paths

- Quick Connect is disabled globally in Jellyfin (`QuickConnectAvailable=false`).
- Household origins independently return a non-cacheable `false` from `GET /QuickConnect/Enabled` so stale or accidental global configuration cannot advertise Quick Connect there.
- Household origins also refuse every other Quick Connect call themselves, so enabling Quick Connect in Jellyfin never opens a sign-in that skips the membership check below: `/QuickConnect/Initiate`, `/QuickConnect/Connect`, `/QuickConnect/Authorize`, `/Users/AuthenticateWithQuickConnect`, any other path under `/QuickConnect`, and `/QuickConnect/Enabled` by any method but `GET` get a fixed, non-cacheable `403 {"error":"household_quick_connect_disabled"}`, the same for every caller, and never reach Jellyfin. A WebSocket upgrade to any of them is answered `404` and never reaches Jellyfin either.
- The [Streamyfin](https://github.com/streamyfin/jellyfin-plugin-streamyfin) plugin's routes (`/Streamyfin` and below) get a fixed, non-cacheable `404 {"error":"not_found"}` on household origins and never reach Jellyfin, so the plugin, if installed, cannot hand its settings (Seerr's API key among them) to household users.
- The [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin's Seerr routes get the same fixed, non-cacheable `404 {"error":"not_found"}` on household origins and never reach Jellyfin: `/JellyfinEnhanced/jellyseerr` and below, `/JellyfinEnhanced/arr` and below, `/JellyfinEnhanced/proxy` and below, and `/JellyfinEnhanced/tmdb/search/person`, `/tmdb/search/keyword`, `/tmdb/genres/movie` and `/tmdb/genres/tv` (relayed to Seerr despite their name; its other `tmdb` routes go to TMDB with the plugin's own key). Those routes hand household users Seerr's answers with other households' requests in them, list other requesters and what Sonarr and Radarr fetched for them, and take requests in Seerr past the household app's own checks, whatever the plugin's own settings say. The plugin's other routes (its scripts, settings and its own TMDB lookups among them) are relayed as before, so its Seerr panels fail and the rest of it keeps working.
- The same plugin's reviews (`/JellyfinEnhanced/reviews` and below, read and write) and its lookup of library items by provider ID (`/JellyfinEnhanced/items/by-providers`) get the same fixed, non-cacheable `404 {"error":"not_found"}` on household origins and never reach Jellyfin. Its reviews list other users' reviews and names for an item without checking that the caller may see it, and its provider lookup searches the whole library without checking that the caller may see what it finds.
- Every path decision on a household origin (these, and the sign-in, public-users, branding, password-recovery, sign-out, protected-media and `/jellypass/...` ones below) is made on the route Jellyfin takes the path to: each segment percent-decoded once, in any case, with empty segments (trailing or repeated slashes) dropped, and with Jellyfin's legacy `/emby` or `/mediabrowser` prefix removed. A segment still percent-encoded once decoded is refused (`400`) only if decoding it again would change which check applies. This may match a path Jellyfin does not route (repeated slashes), never the other way round. A request that matches no check is sent to Jellyfin as the client spelled it.
- A path Jellyfin might read otherwise than the gateway is refused with a fixed, non-cacheable `400 {"error":"invalid_request"}` and never reaches Jellyfin (a WebSocket upgrade gets `400` too): a target that is not a path, a raw backslash, `#` or character outside printable ASCII, invalid percent-encoding, an encoded slash or backslash (Jellyfin keeps it inside its segment), a `.` or `..` segment, encoded or not (Jellyfin resolves it), a control character, anything still percent-encoded after one decoding, or a legacy prefix after another.
- Jellyfin's obsolete `POST /Users/{id}/Authenticate` signs anyone in by ID and password, and no Jellyfin client uses it, so a household origin offers it to no one: every call, a member's or not, counts against the same per-address sign-in limit as `AuthenticateByName` and gets the same `401 {"error":"invalid_credentials"}` a refused sign-in by name gets, after the same minimum delay, without asking Jellyfin.
- Every route that names an item (anything under `/Videos/{id}`, `/Audio/{id}` and `/Items/{id}`, HLS playlists and segments, subtitles and attachments included; the user-data, played, favourite and playing routes; `/MediaSegments/{id}`; `/Shows/{id}/...`; the `InstantMix` and `Similar` routes of an item) and every `itemId` query parameter on them is checked against the caller's own Jellyfin view of the item, with the caller's own credentials, before it is proxied. Jellyfin 10.11 does not check most of these itself. An item the caller may not see gets a fixed `404 {"error":"item_not_found"}`. Item images (`GET`/`HEAD /Items/{id}/Images/...`) are the exception: Jellyfin serves them to anyone, and clients load them without credentials. Jellyfin's anonymous live TV routes for its own transcoder (`/LiveTv/LiveRecordings/...`, `/LiveTv/LiveStreamFiles/...`) get `404`. The full route table is in PR #66.
- Every user ID a request names must be the caller's own, as Jellyfin reports it for the request's own credentials: the second segment of every route under `/Users` but Jellyfin's fixed ones (`/Users/Me`, `/Users/Public`, `/Users/AuthenticateByName` and the like), the user in `/Sessions/{id}/User/{userId}`, and every non-empty `userId`, `controllableByUserId` and `controllingUserId` query parameter (any case, every copy of a repeated one). Jellyfin 10.11 trusts some of these for the caller (`GET /Playlists/{id}/Items?userId=` lists another user's private playlist). IDs are compared as Jellyfin reads them (dashes, braces, case); anything else gets the same fixed `404 {"error":"item_not_found"}` before Jellyfin is asked. Jellyfin administrators are not exempt. A user's picture (`GET`/`HEAD /Users/{id}/Images/...`, `/UserImage?userId=`) is the exception: the profile picker loads it without credentials, so it is served for the household's own members and refused for anyone else. The user in `/Playlists/{id}/Users/{userId}` (`GET`, `POST`, `DELETE`) is not checked: it is who the playlist is shared with, not who acts, and Jellyfin checks the caller's own rights there (the caller must see the playlist; reading another user's share takes the caller's `CanEdit`, changing a share ownership), so these routes are relayed unchanged (Jellyfin 10.11.3 itself fails a first share by path with `500` and answers `204` to a removal by path while keeping the share; sharing by `Users[].UserId` in the playlist body works); a `userId` query parameter there must still be the caller's own. The audit of every Jellyfin route that takes a user ID is in PR #66.
- A household origin does not list another household's members (the one exception, SyncPlay's WebSocket messages, is below). Jellyfin 10.11 lists every user (name, ID and policy) to any signed-in user at `GET /Users`, every SyncPlay group with its participants' names to anyone at `GET /SyncPlay/List` and `GET /SyncPlay/{id}`, and every remote-controllable session with its users' names, at `GET /Sessions`, to a user allowed to control other users' sessions. On a household origin these are narrowed to the household's members, in Jellyfin's own order and schema: `GET /Users` keeps only members (Jellyfin's `isHidden` and `isDisabled` filters still apply), `GET /Sessions` only sessions all of whose users (`UserId` and every `AdditionalUsers` entry) are members, and `GET /SyncPlay/List` only groups with at least one participant, all of them members (SyncPlay names participants only by name, which is matched to the members' Jellyfin names). `GET /SyncPlay/{id}` for any other group, and for one Jellyfin does not have, gets the fixed `404 {"error":"item_not_found"}`. These listings, and the sign-in screen's `GET /Users/Public`, fail closed: only Jellyfin's `200` is relayed, narrowed, and never any other answer's body. A `200` that is not the expected JSON, and any other `2xx` or `3xx`, gets `502` with a fixed error; a `401` gets the fixed `401 {"error":"unauthorized"}`, a `404` the fixed `404 {"error":"item_not_found"}`, any other `4xx` its own status with `{"error":"jellyfin_refused"}`, and a `5xx` `502 {"error":"jellyfin_unavailable"}`. Jellyfin 10.11 also lets anyone join any SyncPlay group by its ID (`POST /SyncPlay/Join`, `{"GroupId": ...}`; SyncPlayManager.JoinGroup checks only the caller's SyncPlay access and that the group exists), and then sends the joiner the group's participants' names over the WebSocket (`GroupJoined`, `UserJoined`). On a household origin a join is relayed only for a group that, as Jellyfin's `GET /SyncPlay/{id}` describes it to the caller, has at least one participant, all of them members; any other group, and one Jellyfin does not have, gets the same fixed `404 {"error":"item_not_found"}` without the join reaching Jellyfin. A body that is not a JSON object with one `GroupId` (any case) that is a GUID gets `400 {"error":"invalid_request"}`, and Jellyfin is sent the checked group ID alone. Every other SyncPlay route acts on the group the caller's session is already in. WebSocket messages are relayed unfiltered, so a member who joined a household group still learns the names of anyone who joins it later through the main Jellyfin site, or in the moment between the check and the join; another household's members cannot join it through their own household origins. A `userId` or `controllableByUserId` in their query must still be the caller's own. Jellyfin's other routes that reveal users (`/Devices`, `/System/ActivityLog/Entries`, `/Auth/Keys`, `/Startup/User`) answer only administrators and are relayed; `GET /Users/{id}` and every route under it is checked as above. The audit of every such route is in the pull request that added this.
- On a household origin a Jellyfin token works only if it is a household member's. Every request relayed to Jellyfin that carries a token, in any form Jellyfin reads (`Token` in an `Authorization` or `X-Emby-Authorization` header, `X-Emby-Token`, `X-MediaBrowser-Token`, or an `api_key`, `ApiKey` or `access_token` query parameter, in any case, also as a single encoded query key), is checked with Jellyfin's `GET /Users/Me` for those same credentials before it is relayed. A token that is not a member's, valid at Jellyfin or not, gets the same fixed, non-cacheable `401 {"error":"unauthorized"}`, and a WebSocket upgrade with one gets `401`; neither reaches Jellyfin, so the answer tells nothing about the token. Routes that name an item or a user (above) give the same token their fixed `404 {"error":"item_not_found"}`. A token issued on another household's origin, or on the main Jellyfin site, is therefore refused; clients that use the main Jellyfin site directly are unaffected. Whom a token belongs to (or that Jellyfin rejects it) is remembered for a minute, and forgotten at once by a sign-out through the household origin; membership itself is checked on every request. A request that carries no token is relayed as before (Jellyfin's own files, public server information, item images), and the sign-in screen's own calls (`GET /Users/Public`, `GET /Branding/Configuration`, `POST /Users/AuthenticateByName`) are answered whatever token they carry, as Jellyfin answers them. The household app and "Add to my library" keep their own checks; "Add to my library" (`POST /jellypass/add`) still answers a token that is not a member's by the caller's own grants, so it can tell a valid token from an unknown one, and whether to refuse it there too is an open decision. `POST /Sessions/Logout` is relayed only with a member's token: Jellyfin ends the session of the token it reads first, the one `GET /Users/Me` answers for, so a sign-out with any other token, valid at Jellyfin or not, or with none, gets the same `401 {"error":"unauthorized"}`, is never sent to Jellyfin and revokes nothing. A member's sign-out forgets its tokens and revokes the session as before; if Jellyfin cannot say whose the token is, the tokens are forgotten all the same and the sign-out gets `502 {"error":"jellyfin_unavailable"}` without reaching Jellyfin.
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

### No scripts added on the way

A household hostname is often reached through a CDN. Every HTML page JellyPass serves or relays on it (the household app, Jellyfin web's page with or without the TV add-on, `/jellypass/add` and any other HTML from Jellyfin) carries `Cache-Control: no-transform`, added to Jellyfin's or JellyPass's own directives, so a CDN that honours it (Cloudflare Web Analytics' automatic setup is one) adds no script to it. JellyPass compresses those pages itself (br or gzip, as the client accepts, unless Jellyfin already encoded them), because such a CDN no longer does; every other answer is left to the CDN. See README "CDNs and HTML pages".

## Boundary model

An access group currently serves both purposes:

- it grants its Jellyfin users access to private media records;
- when the household gateway is configured, the addresses mapped to its ID (and its legacy derived one) show its members as that address's visible profiles.

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

Its addresses are persisted separately, in the state file's `householdAddresses` map keyed by group ID, and removed with the group; the legacy derived address is not persisted. A future household-to-identity-provider mapping may reference the group ID, but identity-provider secrets do not belong in the state JSON file; they must be resolved from secret-backed configuration.

## Delivery sequence

1. Review, test, and commit the deployed source so GitHub becomes the source of truth again.
2. Add a non-secret deployment runbook for the reverse proxy's per-household hosts, preserved `Host` header, TLS, and JellyPass household environment settings.
3. Add an external smoke test for the existing origin: expected household membership, Quick Connect disabled, login controls hidden, media byte ranges, and WebSocket upgrade behavior.
4. Define the native-client SSO handoff and the separate administrator recovery origin.
5. Add household-bound OIDC and explicit identity-to-Jellyfin-user mappings.
6. Only when SSO works for the supported clients, reject password-login and password-recovery routes on household origins and rotate managed accounts to unusable random local passwords.
7. Add optional controlled identity provisioning and session/token revocation.

The SSO step needs an explicit native-client design. The maintained Community SSO plugin supports non-web clients through Quick Connect, which conflicts with the requirement to disable Quick Connect globally. JellyPass must therefore provide and test its own client handoff, adopt a different supported mechanism, or formally limit the first passwordless release to compatible clients.

## Acceptance criteria for the repeatable address milestone

- Two configured household addresses return disjoint public-user lists from the same Jellyfin server.
- Unknown hosts never reveal users.
- A user belonging to multiple households appears only on those households' addresses.
- Duplicate normalized addresses are rejected at configuration time.
- Host matching is case-insensitive, treats `:443` and `:80` as no port, matches any other port exactly, and rejects malformed authorities.
- Filtering failures fail closed rather than returning the unfiltered upstream response.
- Authenticated media requests, byte ranges, and WebSocket upgrades survive the proxy unchanged.
- Logs and metrics identify households by stable ID and do not expose usernames, tokens, passwords, or identity claims.

## Relevant upstream behavior

- Jellyfin supplies its login picker from unauthenticated `GET /Users/Public`.
- Jellyfin Web renders Manual Login and Forgot Password independently of whether public users exist; Quick Connect visibility comes from `GET /QuickConnect/Enabled`.
- Jellyfin exposes the global `QuickConnectAvailable` server setting. A fresh Jellyfin 10.11 or 12 has it on.
- Jellyfin 10.11 routes `/emby/...` and `/mediabrowser/...` (in any case, percent-encoded or not) as the same path without that prefix. It percent-decodes every segment but keeps `%2F` inside its segment, resolves `.` and `..` segments (encoded or not), matches route literals case-insensitively in ASCII only, accepts one trailing slash but not repeated ones, and still routes `POST /Users/{id}/Authenticate?pw=`.
- Jellyfin 12 routes paths as 10.11 does, except that it no longer routes the `/emby` and `/mediabrowser` prefixes (they answer 404). The household host still reads a path without them, so it refuses or narrows what a prefixed path names on both. Jellyfin 12 also reads a token only from `Authorization: MediaBrowser Token="..."` and the `ApiKey` query parameter (in any case), no longer from `X-Emby-Token`, `X-Emby-Authorization`, `X-MediaBrowser-Token`, an `Emby` scheme or `api_key`. The household host still checks every one of those, so a credential only 10.11 reads is checked as well. To check a client's token it relays that client's own credentials to `GET /Users/Me` exactly as given, legacy forms included, and never rewrites them into `Authorization` (that would turn back on the legacy authorization Jellyfin 12 disabled). So on Jellyfin 12 a client that gives its token only in a legacy form gets the household host's fixed `401 {"error":"unauthorized"}`, as Jellyfin itself would refuse it, and on 10.11 it works as before. JellyPass's own calls (its API key) use only `Authorization: MediaBrowser ...`.
- Jellyfin 12.4 adds one route to 10.11's API, `GET /Items/{itemId}/Collections` (item-scoped, with a `userId` query parameter). The household host checks both, as it does under every `/Items/{itemId}` route. It no longer lists the HLS routes (`/Videos/{itemId}/master.m3u8` and the rest) in its OpenAPI document but still serves them; the household host checks them as before. Jellyfin 12 refuses another user's playlist by `GET /Playlists/{id}/Items?userId=` itself (403), which 10.11 lists. The household host refuses it on both.
- Presentation changes in Jellyfin Web do not disable the corresponding server authentication endpoints.

Upstream references:

- [Jellyfin user controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/UserController.cs)
- [Jellyfin server configuration](https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Configuration/ServerConfiguration.cs)
- [Jellyfin Web login controller](https://github.com/jellyfin/jellyfin-web/blob/master/src/apps/legacy/controllers/session/login/index.js)
- [Community SSO for Jellyfin](https://github.com/Flowfin/jellyfin-plugin-sso)
