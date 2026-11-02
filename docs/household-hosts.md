# Household hostnames and the household app

How household hostnames behave, the household app API and
"Get this", and the household web app (PWA). It moved here from the README; the
website's [documentation](https://jellypass.app/docs/) is the shorter guide.
Settings, Seerr, operations and the administrator API are in the
[server reference](server-reference.md).

## Household addresses

Access groups can also act as households. With the household gateway on
(`HOUSEHOLD_GATEWAY_ENABLED=true` and `TRUSTED_PROXIES` set), assign each
household an HTTPS address and map it to the household in JellyPass: in the
admin site's **Groups** tab, **Addresses** on the household's card, or with the
admin API. The hostname can be any name you control; there is no naming rule:

```sh
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"origin": "https://media.example.com", "aliases": ["https://films.example.net:8443"]}' \
  http://127.0.0.1:8788/v1/groups/grove/addresses
```

`origin` is the household's canonical address (its links and its URL in the
admin site); `aliases` are more addresses for the same household. Each is
`https://host` or `https://host:port` (`http` is accepted for a private
network), with no path, query or credentials. The JellyPass mobile app only
connects over HTTPS: members cannot sign in to the app with an `http://`
address. The admin address editor warns while entering or editing an HTTP
address, and household cards mark saved HTTP addresses. These warnings do
not prevent saving addresses for private networks or proxy setups. Addresses
are compared exactly, case and default ports aside:
`https://media.example.com` is reached by `Host: media.example.com` (or `:443`), and nothing else, not a sub- or parent
domain. An address another household has is refused with `409`
(`address_conflict`) and takes effect at once otherwise; there is no restart.
`GET` the same path to read a household's addresses and `DELETE` it to remove
them. The map is kept in the state file and is removed with its group. Members
enter the address supplied by their administrator, for example
`https://media.example.com`, and sign in with their Jellyfin account.

On a household's address, JellyPass filters Jellyfin's public-user response to
the group's members and proxies supported Jellyfin HTTP, streaming,
byte-range, HLS, and WebSocket traffic. Links JellyPass makes for the
household (the app's Play links) stay on the address the request came in on.

> [!NOTE]
> **Legacy addresses.** Installs from before 4.0.0 named households by a rule:
> with `HOUSEHOLD_DOMAIN=example.com` and `HOUSEHOLD_HOST_PREFIX` (default
> `jelly-`), the group `grove` was `https://jelly-grove.example.com`. Those
> addresses keep working unchanged in 4.0.0 as each household's legacy
> address, alongside any you map. Mapping an address the rule already gives
> (to the same household or another) is refused, and a stored map that
> collides with the rule stops startup. The rule gives an address only to a
> group ID of lowercase letters, numbers and hyphens, at most 63 characters,
> and only without a port.

Deployment requirements:

- Point each household address's hostname at the reverse proxy, and route it to
  the member listener (`PORT`). No wildcard DNS record or certificate is
  needed: a certificate per hostname, or one listing several, works.
- Preserve the original `Host` header (the household is chosen from it), and
  send exactly one. JellyPass refuses
  a request that does not name exactly one host (two `Host` headers, a `Host`
  with userinfo, whitespace or other characters, or an absolute-form target
  whose authority is not the `Host`) with a fixed `400`
  (`{"error":"invalid_host"}`), WebSocket upgrades included, before a household
  is chosen. An HTTP/1.0 request with no `Host` and an ordinary path is
  answered as before, as no household's.
- Forward WebSocket upgrades and byte-range requests.
- Avoid proxy buffering for large media responses.
- Do not expose either JellyPass listener directly to untrusted clients, and
  never route a household hostname to the admin listener.
- Set `TRUSTED_PROXIES` to the proxy (required) and add JellyPass to Jellyfin's
  known proxies; see [Running behind a reverse proxy](server-reference.md#running-behind-a-reverse-proxy).
- Ready-made Caddy, Cloudflare Tunnel, Nginx Proxy Manager and Traefik
  setups: [Reverse proxy recipes](reverse-proxy.md).
- Keep a separate normal Jellyfin administrator/recovery origin.

Signing in on a household address (`POST /Users/AuthenticateByName`, from
Jellyfin web, the [household app](#household-app-pwa) or any Jellyfin client)
works only for that household's members, hidden ones included (they use
Jellyfin web's **Manual Login** and type their name). A malformed sign-in (no
`Authorization` client fields, or no string `Username` and `Pw`) is refused
with `400`, every other failure with a fixed `401` (`invalid_credentials`) or,
when Jellyfin's user list cannot be read, `502`, each no sooner than one
second after the attempt, so no answer tells a member's name from anyone
else's. The exception is the sign-in rate limit: `429`
(`too_many_login_attempts`) still answers at once. See [the household access design](household-access.md).

Quick Connect is never offered on a household hostname, whatever Jellyfin's
own setting: it signs in whoever authorizes the code, without the membership
check above. `GET /QuickConnect/Enabled` answers `false`, and every other
Quick Connect call (`/QuickConnect/Initiate`, `/QuickConnect/Connect`,
`/QuickConnect/Authorize`, `/Users/AuthenticateWithQuickConnect`, and any
other path under `/QuickConnect`) a fixed `403`
(`household_quick_connect_disabled`). The
[Streamyfin](https://github.com/streamyfin/jellyfin-plugin-streamyfin)
plugin's routes (`/Streamyfin` and below), which would hand its settings,
Seerr's API key among them, to any signed-in user, answer a fixed `404`
(`not_found`), and so do the
[Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin's
Seerr routes (`/JellyfinEnhanced/jellyseerr`, `/JellyfinEnhanced/arr` and
`/JellyfinEnhanced/proxy` and below, and its Seerr search and genre lists),
which would show members other households' requests and let them request in
Seerr past the household app's checks, and its reviews
(`/JellyfinEnhanced/reviews` and below) and lookup by provider ID
(`/JellyfinEnhanced/items/by-providers`), which would show members other
users' reviews and titles they may not see; the plugin's other features keep
working. All of these are answered by JellyPass alike for anyone, never reach
Jellyfin (WebSocket upgrades included), are never cached (`Cache-Control:
no-store`), and are matched as Jellyfin routes them: in any case,
percent-encoded or not, with trailing slashes, and under Jellyfin's legacy
`/emby` and `/mediabrowser` prefixes.

Every other decision a household hostname makes about a path is made the same
way, on the route Jellyfin takes it to rather than on its spelling: the sign-in
check above, the household's `/Users/Public` list and login styles, refused
password recovery, sign-out, the per-item check, and JellyPass's own
`/jellypass/...` paths. Sign-in by user ID (Jellyfin's obsolete
`POST /Users/{id}/Authenticate`, which no Jellyfin client uses) is offered to no
one: every such call, a member's included, counts against the sign-in limit and
gets the same delayed `401` (`invalid_credentials`) as a refused sign-in by name,
without asking Jellyfin.

The per-item check covers every route that names an item: anything under
`/Videos/{id}`, `/Audio/{id}` or `/Items/{id}` (streams, HLS playlists and
segments, subtitles, attachments, trickplay, playback info, downloads and any
route Jellyfin adds there later), the user-data, played, favourite and playing
routes, `/MediaSegments/{id}`, `/Shows/{id}/...`, and the `InstantMix` and
`Similar` routes of an item, together with any `itemId` query parameter on
them. Before any of them reaches Jellyfin, Jellyfin is asked, with the caller's
own credentials, whether the caller may see the item; if not, the answer is a
fixed `404` (`item_not_found`). Item images are the one exception: Jellyfin
serves them to anyone and clients load them without credentials. Jellyfin's
live TV routes for its own transcoder (`/LiveTv/LiveRecordings/...`,
`/LiveTv/LiveStreamFiles/...`) answer `404` on household hostnames.

No request on a household hostname may name a user other than the caller:
every user ID in the path (`/Users/{id}/...`, `/Sessions/{id}/User/{id}`) or
the query (`userId`, `controllableByUserId`, `controllingUserId`, in any case
and every copy) must be the caller's own, or the answer is the same fixed `404`
(`item_not_found`), administrators included. Jellyfin itself trusts some of
these for the caller. A household member's picture is the one exception, since
the profile picker loads it without credentials. The user in
`/Playlists/{id}/Users/{id}` is not checked: it is who a playlist is shared
with, and Jellyfin checks the caller's own rights there, so those sharing
routes are relayed unchanged. Jellyfin 10.11.3 itself fails a first share by
path (`500`) and keeps a share removed by path (`204`); sharing through the
playlist body works.

A path Jellyfin might read otherwise than JellyPass (an encoded slash or
backslash, a `.` or `..` segment, a backslash, invalid percent-encoding, a
control or non-ASCII character, one legacy prefix after another, or
percent-encoding that would change which check applies if decoded once more) is
answered a fixed `400` (`invalid_request`, `Cache-Control: no-store`) and never
reaches Jellyfin. A name that is itself percent-encoded, such as
`/Artists/100%2520%20Real`, is sent on as usual.

A `Host` that is no household's address fails closed with a fixed `421`
(`unknown_host`); a legacy address whose group does not exist answers `404`
(`household_not_found`).

### Household app API

The backend of the household app (a PWA first; see
[docs/app-design.md](app-design.md)). It is **off by default**: set
`HOUSEHOLD_APP_ENABLED=true` together with
`HOUSEHOLD_DOMAIN`, `SEERR_URL`, `SEERR_API_KEY` and `TMDB_API_KEY`.
These are JSON endpoints under `/jellypass/app/v1` on each household hostname,
and nowhere else (on the administrator host they do not exist). The
[app](#household-app-pwa) that uses them is served next to them.

| Method | Path | Answer |
| --- | --- | --- |
| `GET` | `/jellypass/app/v1/me` | `{"name", "household", "apiVersion"}`: the caller's Jellyfin display name and household name, and the revision of the `v1` API the server speaks (an integer, `4` today; it goes up by one with each release that adds a field or endpoint, and never down). `v1` only ever gains fields and endpoints: a breaking change would be `/jellypass/app/v2`. |
| `GET` | `/jellypass/app/v1/search?q=...&page=N` | A page of title cards. `q` is 1 to 100 characters; `page` 1 to 500, default 1. |
| `GET` | `/jellypass/app/v1/discover/{list}?page=N` | A page of title cards; `list` is `trending`, `trending-movies`, `trending-tv`, `popular-movies`, `popular-tv`, `new-movies` (films that opened in US theatres in the last 60 days), `upcoming` (upcoming movies), `upcoming-tv` (upcoming series), `top-movies` or `top-tv` (TMDB's top rated). |
| `GET` | `/jellypass/app/v1/discover/sources` | The streaming services (networks) and studios the app offers, with their TMDB logos; no TMDB call. |
| `GET` | `/jellypass/app/v1/discover/network/{id}?page=N` | A page of a service's popular series. Only the eight listed services (Netflix, Disney+, Apple TV, Prime Video, HBO Max, Hulu, Paramount+, Peacock); any other ID is `400`. |
| `GET` | `/jellypass/app/v1/discover/network/{id}/films?page=N` | A page of the films the service streams **in the US**, from TMDB's where-to-watch data (JustWatch). |
| `GET` | `/jellypass/app/v1/discover/network/{id}/all?page=N` | The service's series and films mixed (film, series, …): Home's "Popular on" rows. |
| `GET` | `/jellypass/app/v1/discover/studio/{id}?page=N` | A page of a listed studio's popular movies. |
| `GET` | `/jellypass/app/v1/movie/{tmdbId}` | One movie. |
| `GET` | `/jellypass/app/v1/tv/{tmdbId}` | One series, with its seasons. |
| `GET` | `/jellypass/app/v1/tv/{tmdbId}/season/{n}` | One season, with its episodes. |
| `POST` | `/jellypass/app/v1/movie/{tmdbId}/get` | ["Get this"](#get-this) for a movie (empty body or `{}`): always `202 {"status":"accepted"}`. |
| `POST` | `/jellypass/app/v1/tv/{tmdbId}/get` | "Get this" for seasons of a series, `{"seasons": [1, 2]}` (1 to 100 seasons from 1 to 999): always `202 {"status":"accepted"}`. |
| `GET` | `/jellypass/app/v1/requests` | The household's own titles from "Get this", with a coarse status: `{"results": [{"id", "mediaType", "tmdbId", "status", "seasons", "byYou", "cancellable", "requestedOn"}]}` (`requestedOn` is a day, `YYYY-MM-DD`). |
| `POST` | `/jellypass/app/v1/requests/{id}/cancel` | Cancels one of the caller's own requests (an `id` from `/requests`, empty body or `{}`): always `202 {"status":"accepted"}`, whatever becomes of it; see [Cancelling](app-design.md#cancelling-step-2c). |
| `POST` | `/jellypass/app/v1/hidden/movie/{tmdbId}` | "Not interested" (since 4.0.0, `apiVersion` 3): hides a movie from the caller's own Discover lists, See all, service and studio pages, in this household only (empty body or `{}`). `200 {"hidden":true}` whether or not it was hidden already; `409 {"error":"hidden_limit_reached"}` for a new title once the caller hides 2,000. See [Hidden titles](app-design.md#hidden-titles-not-interested-400). |
| `POST` | `/jellypass/app/v1/hidden/tv/{tmdbId}` | The same for a series (the whole series; seasons are not hidden one by one). |
| `DELETE` | `/jellypass/app/v1/hidden/movie/{tmdbId}` | Unhides a movie for the caller: `200 {"hidden":false}` whether or not it was hidden. |
| `DELETE` | `/jellypass/app/v1/hidden/tv/{tmdbId}` | Unhides a series for the caller, the same way. |
| `GET` | `/jellypass/app/v1/hidden?page=N` | The caller's own hidden titles in this household, newest first, 50 a page, for My requests' **Hidden** tab: `{"page", "nextPage", "results": [{"mediaType", "tmdbId", "hiddenAt"}]}`. IDs only (no TMDB call); a client names them as it names My requests' titles. |

The administrator can turn off app access for one household from its card on the private admin listener.
Authenticated members then receive `403 {"error":"app_access_disabled"}` on all app API endpoints; invalid tokens
and other households' members still receive 401. See [household switches and upgrade notes](household-access.md#household-app-and-tv-switches).

The machine-readable contract is [docs/app-api/v1.openapi.json](app-api/v1.openapi.json)
(OpenAPI 3.1). Native clients follow
[the native-client contract](app-design.md#native-clients-contract).

- **Sign-in is Jellyfin's.** Send the member's Jellyfin token as Jellyfin web
  does (`Authorization: MediaBrowser Token="..."`, `X-Emby-Token`, or
  `api_key`). JellyPass checks it with Jellyfin's `GET /Users/Me` and trusts
  the answer for at most 5 minutes, but a sign-out through any household host
  (`POST /Sessions/Logout`) forgets that token at once, whatever Jellyfin
  answers, and does not cache it again while the sign-out is at Jellyfin
  (until Jellyfin answers, fails or 15 seconds pass, even if the client
  leaves) or for a minute after, so its next call is refused once Jellyfin
  has revoked it. At most 8 sign-outs per client, 32 per household and 512 in
  all are sent to Jellyfin at once (past that one is answered 503); the minute
  after is kept for at most 10 sign-outs per client and 30 per household a
  minute, except for tokens JellyPass verified and sign-outs Jellyfin did not
  answer, which always have it. A sign-out never affects any token it does not
  carry. A token revoked outside JellyPass (a device deleted in Jellyfin's
  dashboard, or a sign-out sent straight to
  Jellyfin) can still be accepted for the rest of those 5 minutes. The caller must be an enabled member of
  the household whose hostname they called; household membership is checked on
  every call. A missing, invalid or disabled token and a member of another
  household all get the same `401 {"error":"unauthorized"}`.
- **Cards** are `{"mediaType", "tmdbId", "title", "year", "overview",
  "posterUrl", "backdropUrl", "rating", "state", "play"}`; a page is
  `{"page", "nextPage", "results"}`, where `nextPage` is `null` unless TMDB
  returned a full page. A movie adds `"genres"` and `"runtime"`, a series also
  `"seasons"` (`{"seasonNumber", "name", "episodeCount", "state"}`), and a
  season is `{"tmdbId", "seasonNumber", "name", "overview", "episodes",
  "state"}`. Missing values are `null` (or `""` for text). Images are TMDB URLs
  built from an allowlisted file name (posters at `w342`, backdrops at `w780`; the app also draws a backdrop at `w1280`,
  the same file, for sharper screens).
- **`state`** is the household's own view of the title, decided in this order:
  `in_library` (the caller's own Jellyfin view has it, whatever their Seerr
  permissions; only then is `play` set, to `{"itemId", "url"}` with
  `https://<household host>/web/#/details?id=<itemId>`), `unavailable` (an
  administrator blocklisted it in Seerr, or the caller may not request this
  media type in Seerr, which includes a caller Seerr has no user for and a
  caller Seerr gives a request quota: see [Get this](#get-this)),
  `requested` (someone in this household asked for it with "Get this" and it
  is still pending or approved), and otherwise `get_this`. Seasons are
  `in_library` when the caller's own Jellyfin view has their episodes,
  otherwise `unavailable`, `requested` or `get_this` the same way; a series is
  `requested` while any season is. Nothing depends on what another household
  holds, has requested or is waiting on: a title another household holds looks
  exactly like one nobody has. Seerr requests made outside the app are never
  `requested` anywhere: Seerr does not record which household a request was
  for, and who belongs to which household now cannot say, so only the
  household's own "Get this" records count, and they stay with the household
  whose hostname was used whatever membership does later.
- **Nothing else** is ever returned: no requester, request or media IDs, Seerr
  status, Jellyfin item IDs other than the caller's own playable one, totals or
  timestamps. Every answer has `Cache-Control: no-store`.
- **Fixed errors:** `400 {"error":"invalid_request"}`, `401
  {"error":"unauthorized"}`, `404 {"error":"not_found"}` (unknown path, or a
  title TMDB does not know), `429 {"error":"too_many_requests"}` and `502
  {"error":"unavailable"}` (Jellyfin, Seerr or TMDB failed; details are
  logged, never returned); on a household address no household has,
  `404 {"error":"household_not_found"}` before any token is checked.
- **Rate limited.** 300 calls per client address (after `TRUSTED_PROXIES`)
  and 200 per signed-in user in each 5-minute window, and 60 per household
  (its own members' calls only) in each 10 seconds; all answer the same
  `429`, as does a call when its household already has 20 TMDB calls
  waiting.
- `jfa_app_requests_total{endpoint, outcome}` counts answers, by endpoint
  (`me`, `search`, `discover`, `movie`, `tv`, `season`, `get`, `requests`,
  `cancel`, `hide`, `unhide`, `hidden`, `unknown`) and outcome (`ok`,
  `unauthorized`, `rate_limited`, `invalid`, `not_found`, `hidden_limit`,
  `unavailable`); no label names a title.

#### Get this

"Get this" asks for a title for the caller's household, the same way whatever
the title's situation, and answers `202 {"status":"accepted"}` at once, before
anything about the caller or the title is looked up. What happens next runs in
the background and is never part of any answer:

- **Already playable for the caller**, blocklisted, or already asked for by the
  household: nothing.
- **Jellyfin already has it** (JellyPass looks it up with its own key first,
  by TMDB ID, by the item Seerr links to the title and, when neither finds it,
  by the title's name and year, so an item without TMDB metadata counts too;
  a different title of the same name and year held that way makes the call a
  join or nothing rather than a request): the household joins the title's grant by the same rules as
  **Get this**: only a grant made from a request,
  never a manual-only one, and never if an administrator removed the household
  or the caller. **A title Jellyfin has is never requested in Seerr**, so a
  late request can no longer make a public title private or undo an
  administrator's removal. Only the household whose hostname was used joins,
  not the caller's other households.
- **Someone already requested it** (pending or approved in Seerr): the
  household's interest is recorded, and the household joins the grant when the
  title becomes available (webhook or request backfill), by the same rules.
- **Otherwise**: a real HD Seerr request is made **as the caller** (their own
  Seerr user, confirmed before the call; only the title and seasons are sent,
  never another user, server, profile, folder, tags or 4K). JellyPass first
  writes a request intent to its state file, then confirms the caller's Seerr
  user, then reads Jellyfin again as the last step before the request is
  sent; a title that arrived meanwhile is joined instead. Until the request is
  recorded and Jellyfin has been read once more after Seerr answered, no
  webhook or backfill grants any request for that title (a webhook is
  acknowledged and kept, and granted afterwards), also across a restart. A
  title that arrived while the request was being made, or whose check could
  not be read within 30 minutes, is granted as a join, never as a new private
  grant.

A series is decided season by season, so one call can join the seasons
Jellyfin has, follow the seasons someone requested and request the rest. New
seasons of a series Jellyfin already has are requested, but their grant
follows the join rules: a public series stays public, and the household joins
a series held through someone's request. A series is `ready` once every season
asked for has episodes in Jellyfin; until then each season shows its own
status.

**Quotas are not supported in this version.** "Get this" is not offered to a
caller Seerr gives a request quota (a movie or series limit above 0, their own
or Seerr's default, used or not): every title they cannot play shows as
`unavailable` ("Can't request"), the same for every title, and a "Get this"
from them gets the same `202` and does nothing. They can still request through
Seerr. Before any branch, in the background, JellyPass reads the caller's own
Seerr request permission and quota; a caller without permission for the media
type, with a quota, or whose Seerr user or quota could not be read gets the
same `202` and nothing runs. Calls are also limited to 10 per user, 30 per
client address and 30 per household in each 10 minutes (`429`), on top of the
limits above.

**`GET /requests`** lists the household's own "Get this" titles, newest first
(at most 200), from JellyPass's records only: `status` is `requested`
(Requested), `ready` (Ready to watch, and only for a caller whose own Jellyfin
view has the title or season: anyone else in the household, kept from it by a
library, a parental limit or a blocked tag, sees `requested`) or `failed` (We
couldn't get this: declined or failed), with each season's status for a series; `byYou` says
whether the caller asked (otherwise someone else in the household); `id` is
opaque; `requestedOn` is the day (`YYYY-MM-DD`, never a time) the household
last asked; `cancellable` says whether the caller may cancel it. No requester
names, Seerr IDs or counts. Statuses are brought up to date by each scheduled
reconciliation (`RECONCILE_INTERVAL_SECONDS`) and when a grant is created. A
request an administrator deletes in Seerr leaves every household's list (the
requester's and any following it alike), and the title can be asked for
again. There are no notifications.

**Cancelling** (`POST /jellypass/app/v1/requests/{id}/cancel`): only the member
who asked may cancel, and only before anything of the title is ready for
them. The answer is always the same `202`, and so is what the member sees
afterwards: the entry leaves the list and the title shows Get this again. In
the background, the request is deleted in Seerr as the member only while it is
still pending and no other household follows it (nothing downloads then);
otherwise it is kept, and when it arrives this household is not given it:
households still following it are, and with none it is **held for no
household** (private to everyone but Jellyfin administrators, never public)
until an administrator gives it to someone with the grant tools. The admin-only
`GET /v1/app/held` lists held titles. Access already given is never taken back.
Cancels share the "Get this" limits. See
[Cancelling](app-design.md#cancelling-step-2c).

`jfa_app_get_this_total{result="accepted"|"ineligible"|"error"}` and
`jfa_app_get_this_branches_total{branch}` count calls and what their
background work did; no label names a title. The gauges
`jfa_app_safety_markers{kind}`, `jfa_app_request_intents{status}` and
`jfa_app_deferred_webhooks` count what "Get this" still protects or has in
flight (`jfa_app_withdrawals{kind}` and `jfa_app_held_titles` what cancels
still decide), and the admin-only `GET /v1/app/outstanding` lists it (counts by kind,
oldest age, TMDB IDs and households, `clear` once all are 0); household hosts
never serve it. The app's "Get this" button is
described under [Household app (PWA)](#household-app-pwa). See
["Get this" as implemented](app-design.md#get-this-as-implemented-step-2a)
for every rule, the leak channels and what remains.

Which films a streaming service has is **US availability only**: the same
fixed region for every household, not a setting (TMDB's where-to-watch data,
from JustWatch, credited in the app). Outside the US a service's films may not
match what it offers there; its series are not region-specific.

Each call reads titles straight from TMDB with `TMDB_API_KEY` (in English;
each household reuses an answer for up to 10 minutes), never from Seerr, so
other households' Seerr records cannot change an answer, its size or its
timing. From Seerr it reads only the administrator blocklist with the admin key
(reused for up to a minute) and the caller's own permissions as the caller;
no one's requests are read. The caller's library comes from Jellyfin with the
caller's own token (reused for up to a minute), so Jellyfin's blocked tags,
library access and parental limits apply. Expect a handful of local Seerr
calls per answer. Each household has its own caches, never emptied for
another's; with the app enabled, JellyPass supports at most 100 households
(creating another is refused with `400`; with the app off there is no limit).
If you enable the app with more than 100 groups, they all still load (startup
logs a warning) and can be changed or deleted, but no new group can be created
until there are fewer than 100, and the app caches nothing for any household
while there are more than 100. Cache limits count entries, not
bytes (up to 500 TMDB answers per household, each read up to 4 MiB but
usually tens of kilobytes), so memory grows with the households actually
browsing; see
[One cache per household](app-design.md#one-cache-per-household).

All households share `TMDB_API_KEY`, and so TMDB's rate limit (about 40
requests a second). JellyPass starts at most 20 TMDB calls a second (10 at
once), never has more than 10 unanswered at once (abandoning any after 15
seconds), and lets households take turns, so one household's burst cannot use
up another's share; if TMDB still answers `429`, nothing is sent until its
`Retry-After` has passed and the call is retried once. Busy households can
still make each other wait briefly for their turn, and a TMDB outage, slowdown
or rate limit affects every household alike. Use a TMDB key for JellyPass alone. See
[Shared upstreams](app-design.md#shared-upstreams).

Do not give household members Seerr's `MANAGE_BLOCKLIST` permission (Seerr
does not by default): every blocklist entry makes the title `unavailable` in
every household.

This product uses TMDB and the TMDB APIs but is not endorsed, certified, or
otherwise approved by [TMDB](https://www.themoviedb.org/). Titles, overviews
and images come from TMDB. The app shows this notice with TMDB's logo on its
About screen, as TMDB's API terms require.

`/jellypass/app` paths never are: without the app they answer `404`.

### Household app (PWA)

With `HOUSEHOLD_APP_ENABLED=true`, each household hostname also serves the
app itself at its address, for example `https://media.example.com/jellypass/app/`: an
installable web app (a PWA) to browse what is in the household's Jellyfin
library and find more to watch. It shows each title's state (`Ready to watch`
with a **Play** button, `Available to get`, `Requested` or `Can't request`) and offers
**Get this** where a title can be asked for; the confirmation is the same
sentence whatever happens afterwards. A title the household asked for that
failed shows `We couldn't get this` with no button and the line "Ask your
JellyPass admin to try again.", because the API does not ask again while the
failed record stands. Nothing about it
exists on the administrator host, or on household hosts while the app is
switched off (those answer the same fixed `404`).

- **Needs:** the same settings as the API above. `TMDB_API_KEY` is a v3 API key
  or v4 read access token from your TMDB account's API settings (free for
  non-commercial use; read TMDB's [API terms](https://www.themoviedb.org/api-terms-of-use)).
  Nothing else to configure: the app's files are built into the image.
- **Signing in** is Jellyfin's, done inside the app. Signed out, the app shows
  the household's profile picker (the same list Jellyfin's own picker shows on
  this address, which the gateway already limits to the household's members):
  tap a profile, then enter its Jellyfin password, or just tap if the member is
  marked passwordless in JellyPass. **Sign in with a different name** (where the
  picker starts when it lists nobody) is how a hidden member, whom Jellyfin
  leaves off the picker, signs in by typing their name. It makes the calls Jellyfin web makes, through
  the household gateway, so household scoping and the sign-in rate limit apply
  exactly as they do on `/web/`; wrong password, too many attempts and
  "unavailable" each have one fixed message and never show Jellyfin's text.
  There is no redirect to Jellyfin web and nothing to paste afterwards. The
  sign-in is stored where Jellyfin web keeps its own (`jellyfin_credentials` in
  the browser's storage for this address), so **the app and Jellyfin web share
  one session**: **Play** opens Jellyfin web already signed in, and signing in on
  `/web/` signs the app in. The only other thing the app stores is a random
  device ID of its own. **Sign out** (in the Account tab's member card) revokes the session at
  Jellyfin and clears it from the browser, so it **also signs Jellyfin web out**
  on that address (they are one session). The app API forgets the token as
  the sign-out passes through, so it is refused at once there too. **Open Jellyfin to sign in** stays under the picker as a
  fallback.
- **iPhone and iPad:** an app added to the Home Screen has storage apart from
  Safari's, so signing in in Safari does not sign the installed app in. Sign in
  inside the installed app: its picker stores the session in the app's own
  storage, and Jellyfin web (also inside the installed app, whose scope is the
  whole household address) finds it there.
- **Screens:** Home (Trending, Popular movies, Popular series and Upcoming
  movies as scrolling rows), Search (as you type, with **Load more**), a movie
  page, a series page with its seasons (each with its own state) and a season
  page with its episodes (**Get this** on each title or season that can be
  asked for, with a season picker on a series page), **My requests** (the
  household's requests and their status, per season for a series), and About
  & credits (TMDB's logo and notice).
- **Install on iPhone or iPad:** open the app address in Safari, tap **Share**,
  then **Add to Home Screen**. **Android (Chrome):** menu, **Install app** (or
  **Add to Home screen**). Desktop Chrome and Edge: the install icon in the
  address bar. It opens full screen with JellyPass's icon. As we understand it
  (not yet tested on a device), an iPhone or iPad keeps the icon the app was
  added with; if a new icon doesn't appear after an update, remove the app
  from the Home Screen and add it again. **Tested on a real
  iPhone:** Back, swipe-back and the restored position, including each Home
  row's. **Not yet verified on a real phone:** the install, the in-app
  sign-in, and the 2.5.0 look (the glass blur, the safe areas under the status
  bar and above the tab bar, swiping Home's hero, the new icon) and 2.6.0's
  rows (lazy loading, the Studios strip, network and studio pages) have been
  tested only in a simulated browser and against a real Jellyfin, and 2.7.0's
  additions (the All | Movies | TV switch, the backdrop cards, the service
  films and tabs, the focus scrolling) only in a simulated browser, so expect
  to check them on a device before relying on them.
- **Offline and privacy:** a service worker keeps only the app's own static
  files (page, styles, scripts, icons, TMDB logo), as one complete set per
  release (replaced as a whole when the app is updated), so the app opens when
  the network is slow or down. It never touches `/jellypass/app/v1/*` or anything
  else: no titles, states or household data are ever cached, and without a
  network the app says so.
- **Page security:** the files are served with a strict
  `Content-Security-Policy` (own origin only, plus `https://image.tmdb.org` for
  posters and backdrops; no inline script or style, no framing, no forms),
  `nosniff`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` that turns off camera, microphone, location, payment, USB/serial/HID/Bluetooth, motion and other sensors, and the like and
  cross-origin isolation headers. The files are the same for everyone and carry
  no user data; the app fetches everything else from the API after loading.
  See **CDN caching** below for how long each file may be kept.
- **CDN caching (Cloudflare and others):** every file the page loads except the
  page itself and `sw.js` is served under a name carrying a hash of its content
  (`app.<hash>.css`, `js/main.<hash>.js`, the manifest, icons and logo too), and
  the page names exactly those files, so a CDN or browser can keep them for good
  (`Cache-Control: public, max-age=31536000, immutable`) and two releases can
  never be mixed. An old or unknown hash is not a file: it is answered like any
  other unknown app path, by the app API, so it gets `401
  {"error":"unauthorized"}` without a Jellyfin token (as when the browser
  itself loads a file, which sends none) and `404 {"error":"not_found"}` only
  with a valid one, both `no-store`. The page, the `/jellypass/app` redirect
  and `sw.js` keep their addresses, so they are sent with
  `Cache-Control: no-store` plus `CDN-Cache-Control: no-store` and
  `Cloudflare-CDN-Cache-Control: no-store`, and no `ETag` (the page's
  `Cache-Control` is `no-store, no-transform`, see
  [CDNs and HTML pages](server-reference.md#cdns-and-html-pages)). Per Cloudflare's documentation `no-store` is never cached at its
  edge, `Cloudflare-CDN-Cache-Control` / `CDN-Cache-Control` are the headers it
  reads for its own cache (the former is not forwarded to browsers), and its
  Browser Cache TTL setting only rewrites `Cache-Control` on responses it caches.
  An earlier release sent `no-cache` with an `ETag`, which Cloudflare rewrote to
  `max-age=14400` on the `.css`/`.js` files, so a browser could run old and new
  files together for up to four hours after an update. After upgrading, purge
  the CDN cache once for `/jellypass/app/*` if you have cached it before; no
  rule is needed afterwards. The page registers the worker with
  `updateViaCache: 'none'`, so browsers check `sw.js` on the network.

Filtering the login picker is a privacy and usability boundary, not
authentication. Users still authenticate with Jellyfin, and Jellyfin policies
remain authoritative. Quick Connect and legacy-login restrictions are described
in [the household access design](household-access.md).
