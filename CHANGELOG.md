# Changelog

All notable changes to JellyPass are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

JellyPass's public interface is its settings, its state file, its administrator
API, its webhook and app endpoints, and successful responses on the endpoints it
relays to Jellyfin. Failure responses on relayed Jellyfin endpoints (status,
body and headers when a request is refused or fails) are not part of that
interface: they may change in a minor or patch release to close a security or
privacy leak. Such changes are always listed at the top of the release notes.

## [Unreleased]

### Added

- Household app: each **Popular on** row (Netflix, Disney+, Apple TV, Prime Video, HBO Max, Hulu, Paramount+,
  Peacock) now mixes the service's popular series with the films it streams, film then series in turn, each card
  saying "Movie" or "Series". Films come from TMDB's where-to-watch data (JustWatch's) for **the US only**, the same
  for every household, credited to JustWatch on About, on Home and on the service's page. A service's page has an
  **All | Series | Films** control, kept in the address (`#/network/:id?kind=films`), so Back comes back to the same
  tab with its pages and scroll. Opening Home still makes the same four TMDB calls; a mixed row costs two once it
  scrolls near the screen.
- Household app API: `GET /jellypass/app/v1/discover/network/:id/films?page=` (the service's films in the US, TMDB
  discover by its watch providers with `watch_region=US` and `flatrate`) and `GET
  /jellypass/app/v1/discover/network/:id/all?page=` (series and films mixed). `GET /discover/sources` gives each
  network `hasFilms: true`. Only the listed services: any other ID, or any list after a network's ID but `films` or
  `all`, is `400 invalid_request` before TMDB is asked. Films are cached apart from series, per household.

### Changed

- Household app: a service's page (`#/network/:id`) now opens on **All** (its series and films mixed, like its Home
  row); its series alone are the **Series** tab, `#/network/:id?kind=series`.
- Household app API: a path with anything after a network's ID other than `films` or `all` (for example
  `/discover/network/213/2`) is now `400 invalid_request` instead of `404 not_found`, still before TMDB is asked.

## [2.6.0] - 2026-10-25

This is a minor release for the household app (`HOUSEHOLD_APP_ENABLED=true`)
only: with the app off (the default), nothing changes. It adds rows, pages and
app endpoints; existing screens and endpoints work as before. There is nothing
to configure: no setting is added, removed or renamed, webhook payloads, the
administrator API and the existing app endpoints are unchanged, and the state
file is unchanged (schema v7, with the same fields as 2.5.0), so 2.5.0 reads a
state file written by 2.6.0. Read these before upgrading:

- **More TMDB calls, but only as members scroll.** Opening Home still makes
  the same four TMDB calls before anything is drawn; the list of networks and
  studios comes from JellyPass itself and costs none. Each new row below
  those four (Upcoming series and the eight **Popular on** rows) is fetched
  once, when it comes within 400 px of the screen (at once on a screen tall
  enough to reach it), so scrolling to the bottom
  of Home adds at most nine calls, and each network or studio page adds one
  per page of titles. These calls are cached per household and share TMDB's
  rate limit like every other, as before.
- **New images from TMDB.** Network and studio logos are TMDB's own files at
  `https://image.tmdb.org/t/p/w300`, loaded by the browser straight from
  TMDB, not through JellyPass, like posters and backdrops. The app's Content
  Security Policy is unchanged.
- **No CDN purge is needed:** the app's files are still named by content hash
  and every other `/jellypass/app` answer, the new endpoints included, is sent
  `no-store`, so the new files have new addresses.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:2.5.0` and recreate the container. A
  `#/network/:id` or `#/studio/:id` link opened on 2.5.0 shows Home.
- **Tested in a simulated browser:** the new rows, the lazy loading and the
  network and studio pages are covered by the app's tests in a simulated
  browser (the network and studio IDs and HBO Max's `3186|49` were checked
  against TMDB's live API), not yet on a physical phone; see
  [Household app (PWA)](README.md#household-app-pwa).

### Added

- Household app: Seerr-style rows on Home. After the four existing rows come **Upcoming series**, a **Studios** strip
  (Seerr's eleven studios as logo links) and **Popular on** rows for eight US streamers (Netflix, Disney+, Apple TV,
  Prime Video, HBO Max, Hulu, Paramount+ and Peacock), each heading showing the network's TMDB logo. The HBO Max row
  also lists HBO's own series (TMDB files them under HBO, so The Last of Us and House of the Dragon would otherwise be
  missing): one row, under HBO Max's name, logo and ID, with no separate HBO row. Each network and
  studio has its own page (`#/network/:id`, `#/studio/:id`) with **Load more**, and Back puts its pages and scroll back.
  Rows below the first four are fetched only as they come within 400 px of the screen, so opening Home still makes the
  same four TMDB calls as before (a screen tall enough to reach the next row fetches that row at once).
- Household app API: `GET /jellypass/app/v1/discover/upcoming-tv`, `GET /jellypass/app/v1/discover/sources` (the
  networks and studios offered, with their TMDB logos, answered without calling TMDB), and
  `GET /jellypass/app/v1/discover/{network,studio}/:id?page=` for those networks and studios only: any other ID is a
  `400 invalid_request`, before TMDB is asked. Titles still come from TMDB, with the same caching per household and the
  same share of TMDB's rate limit.

### Fixed

- Documentation: an old or unknown fingerprinted app file is answered by the app API, so it gets `401
  {"error":"unauthorized"}` without a Jellyfin token (as when the browser itself loads a file) and `404
  {"error":"not_found"}` only with a valid one. The README said it always answered `404`; the behaviour itself is
  unchanged in this release.

## [2.5.0] - 2026-10-25

This is a minor release for the household app (`HOUSEHOLD_APP_ENABLED=true`)
only: with the app off (the default), nothing changes. No setting is added,
removed or renamed, webhook payloads, the administrator API and the app's
endpoints are unchanged, and the state file is unchanged (schema v7, with the
same fields as 2.4.1), so 2.4.1 reads a state file written by 2.5.0. The
sign-out changes below alter only failure responses on a relayed Jellyfin
endpoint. JellyPass's versioning policy (at the top of `CHANGELOG.md`) keeps
those outside the public interface: they may change in a minor or patch
release to close a security or privacy leak, and are always listed first in
the release notes. Here they are the bounds of the fix that closes one: a
signed-out session stayed usable in the app for up to five minutes. Read
these before upgrading:

- **The app looks and navigates differently.** Members will find three tabs
  (**Home**, **Search**, **My requests**) in a floating bar; **About &
  credits** is no longer a tab but opens from the (i) button on Home, and
  **Sign out** has moved from the header into About's **Account** card. Cards
  no longer have a **Play** button: Play is on a title's page.
- **New app icons.** As we understand it (not yet tested on a device), an app
  already added to an iPhone or iPad Home Screen keeps the icon it was added
  with, because iOS takes the icon when the app is added and does not update
  it; if the old icon stays, remove the app from the Home Screen and add it
  again from Safari to see the new one (this keeps nothing the app needs:
  sign in again inside the installed app). Android and desktop Chrome and
  Edge update an installed app's icon from its manifest on their own, after
  a while, and may ask the user to confirm.
- **Sharper backdrops use more data.** Home now opens on a hero of backdrop
  images, and backdrops offer TMDB's `w1280` beside `w780`; the browser picks
  by screen width and pixel density, so large screens and 3x phones (most
  recent iPhones) download `w1280`. Images come from TMDB, not through
  JellyPass.
- **Sign-out on household hostnames answers differently in some failures,
  for every Jellyfin client.** With the app enabled, `POST /Sessions/Logout`
  on a household address (the app, Jellyfin web and any other Jellyfin client)
  is now read whole and sent to Jellyfin by JellyPass, which waits for
  Jellyfin's answer even if the client leaves. Jellyfin's answer, success or
  not, is relayed as before, except that it now:
  - answers `413` (`request_too_large`) to a sign-out whose body is over
    8 KiB, without sending it to Jellyfin (Jellyfin's clients send none);
  - answers `503` (`too_many_sign_outs`) with `Retry-After: 1`, without
    sending it to Jellyfin, when 8 sign-outs from the same client address,
    32 for the same household or 512 in all are already at Jellyfin. The
    app's sessions made with its tokens are forgotten all the same; the client
    should try again to have Jellyfin revoke the token;
  - answers `502` (`jellyfin_unavailable`) when Jellyfin has not answered
    within 15 seconds, as it already did when Jellyfin could not be reached.
- **No CDN purge is needed:** 2.4.0 and later name the app's files (icons and
  manifest included) by content hash and send every other `/jellypass/app`
  answer `no-store`, so the new files have new addresses.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:2.4.1` and recreate the container.
- **Tested on a device:** Back, swipe-back and the restored position (from
  2.4.1) work on a physical iPhone. The new look (the glass blur, the safe
  areas under the status bar and above the tab bar, swiping the hero) and the
  new icon have been tested in a simulated browser only, not yet on a
  physical phone; see [Household app (PWA)](README.md#household-app-pwa).

### Fixed

- Household app: signing out (the app's **Sign out**, or Jellyfin web's, on a household address) now forgets the session
  at once, so the app stops working with that sign-in straight away instead of for up to five minutes. A sign-in
  revoked in Jellyfin's dashboard, or signed out straight at Jellyfin rather than through the household address, can
  still work in the app for up to five minutes, as before.

### Changed

- Household app: a new look. Dark indigo with a soft glow, a floating glass tab bar (**Home**, **Search**, **My
  requests**), a glass header with a round Back button, rounded poster cards with the status pill on the poster, a
  three-column Search grid under a capsule field, request cards with a poster thumbnail, and new app icons. **About &
  credits** now opens from the (i) button on Home, and **Sign out** moved into About's new Account card (with your name
  and household, which left the header). Cards no longer have a Play button; Play stays on a title's page. Status words,
  **Get this** and what the household can see are unchanged.
- Household app: the glass tab bar and header are denser so their labels and icons stay readable (4.5:1 text, 3:1 icons) over
  any poster, and keyboard focus now scrolls a card clear of the bar and header.
- Household app: Home opens on a hero of the five top trending titles, edge to edge under the status bar, with the
  backdrop, title, year, TMDB rating, a status pill and a two-line overview. Swipe it, or use the Previous and Next
  buttons or the labelled dots; it never moves by itself and respects reduced motion. It uses the trending row Home
  already loads, so it costs no extra calls, and Back puts it where you left it. Movie, series and season pages are now
  full-bleed: a tall backdrop under the status bar fading into the page, a bold title with year, runtime (or seasons)
  and rating chips, genres, the status pill, and one full-width primary button, **Play** or **Get this** (a series
  partly in the library shows **Get this** too, as a second, glass button). Seasons are cards with round checkboxes and
  a **Select all** that only ticks the boxes. Backdrops are sharper (TMDB `w1280`, chosen by the browser through
  `srcset`). Status words, **Get this** outcomes and what the household can see are unchanged.

## [2.4.1] - 2026-10-25

This is a patch release for the household app (`HOUSEHOLD_APP_ENABLED=true`)
only. There is nothing to do when upgrading from 2.4.0: settings, webhook
payloads, the administrator API and the app's endpoints are unchanged, and the
state file is unchanged (schema v7, with the same fields as 2.4.0), so 2.4.0
reads a state file written by 2.4.1. No CDN purge is needed: 2.4.0 already
names the app's files by content hash and sends every other `/jellypass/app`
answer `no-store`. To roll back, set `JELLYPASS_IMAGE` back to
`ghcr.io/nicklongmore86/jellypass:2.4.0` and recreate the container. The Back
button and the restored position have been tested in a simulated browser
only, not yet on a physical iPhone; see
[Household app (PWA)](README.md#household-app-pwa).

### Fixed

- **Household app: going back now returns to where you were.** The page
  scroll, each Home row's horizontal scroll, Search's query, loaded pages and
  scroll, and My requests' entries shown and scroll are put back. Positions
  are kept in memory only while the app is open, and nothing from the API is
  stored on the device for this: the data is fetched again. Scrolling with a
  wheel, touch or keys, tapping, typing or changing the search ends a
  restoration still owed, so a slow response never moves the page.

### Changed

- **Household app: every screen except Home has a Back button in the
  header,** so the installed app, which has no browser back button, can go
  back. Opened directly on a screen, Back goes to its parent (a season's
  series, otherwise Home) and stays in the app.

## [2.4.0] - 2026-10-25

This is a minor release. The household sign-in changes below alter only failure
responses on a relayed Jellyfin endpoint. JellyPass's versioning policy (at the
top of `CHANGELOG.md`) keeps those outside the public interface: they may change
in a minor or patch release to close a security or privacy leak, and are always
listed first in the release notes. With `HOUSEHOLD_APP_ENABLED=true`, the
household app now requests titles (**Get this**), lists the household's
requests and signs members in inside the app. With the app off (the default), only household
hostnames change: how sign-in there answers (see below) and the caching
headers of `/jellypass/app` answers. No setting is added, removed or renamed,
the state file stays at schema v7, and the administrator API only gains
`GET /v1/app/outstanding`. Read these before upgrading;
[Upgrading from 2.3.0](#upgrading-from-230) has the steps:

- **With the app enabled, it now requests titles.** There is no separate
  switch: after upgrading, every household member with Seerr request
  permission gets a **Get this** button that makes a real Seerr request as
  them (or adds the household to a title Jellyfin already has). To keep the
  app read-only, block `POST /jellypass/app/v1/movie/*/get` and
  `POST /jellypass/app/v1/tv/*/get` at the reverse proxy, or leave
  `HOUSEHOLD_APP_ENABLED` off.
- **Members with a Seerr request limit see "Can't request".** Seerr request
  quotas are not supported yet: a member whose Seerr user has a movie or series
  request limit, their own or Seerr's default, sees every title they cannot
  play as **Can't request** (2.3.0 showed **Available to request soon**), and
  their **Get this** does nothing; they still request in Seerr. If Seerr has a
  default request limit, that is every member who does not bypass quotas.
- **The Seerr website is not restricted yet, so the late-request risk
  remains** for requests made in Seerr directly. Seerr 3.5.x accepts a request
  for a title that is already available, and for a user with auto-approve, the
  webhook and backfill treat it as a genuine request, which can make a public
  title private, re-add access an administrator removed, or extend a
  manual-only grant. **Get this** never requests a title Jellyfin has, and
  grants a request it made for a title that arrived meanwhile as a join, but
  the risk closes only once the Seerr website is restricted to administrators
  (step 4 of [the app plan](docs/app-design.md#late-requests-closed-by-design),
  planned, not part of 2.4.0).
- **Sign-in on household hostnames answers differently, with or without the
  app.** `POST /Users/AuthenticateByName` on a household address (Jellyfin
  web, the app and any other Jellyfin client) now:
  - answers `400` (`invalid_request`) to a malformed sign-in: no
    `Authorization` or `X-Emby-Authorization` header with a `Client`,
    `Device`, `DeviceId` and `Version`, or a body that is not a `Username` and
    a `Pw` (both strings). Jellyfin's own clients send both; a script that does
    not is refused on household addresses (2.3.0 passed it to Jellyfin, or
    answered `401`);
  - answers every other failure with a fixed JellyPass body, never Jellyfin's:
    `401` (`invalid_credentials`) for a wrong name or password, a name that is
    no member's, and any answer but success that Jellyfin gives a member; `502`
    (`jellyfin_unavailable`) only when Jellyfin's user list cannot be read.
    These `400`, `401` and `502` answers come no sooner than one second after
    the attempt (2.3.0 refused a non-member at once); `429`
    (`too_many_login_attempts`) still answers at once;
  - shows a member whose sign-in Jellyfin fails to answer (unreachable, a
    `5xx`, or no answer within 15 seconds) **wrong name or password** (`401`),
    not an outage, unless Jellyfin's user list cannot be read either (then
    `502`);
  - looks the name up in Jellyfin's full user list, read with the API key
    (2.3.0 read the public list), so hidden members can sign in by typing their
    name, and Jellyfin web's **Manual Login** is shown again on household
    addresses.
- **After deploying, purge your CDN's cache for `/jellypass/app/*` once**, if
  a CDN sits in front of household hostnames: it may still hold 2.3.0's app
  files for up to four hours. 2.4.0 names its files by content hash and sends
  every other `/jellypass/app` answer `no-store`, so no rule is needed
  afterwards.
- **The state file stays at schema v7.** Only **Get this** adds to it
  (`appRequests`, `appIdKey`, `appRequestIntents`, `deferredWebhooks`,
  `appSafetyTombstones`, `householdEpochs`, `nextHouseholdEpoch`); with the
  app off, 2.4.0 writes no new field. 2.3.0 and 2.2.1 load these fields and
  write them back unread. **Before rolling back** to 2.3.0, drain and wait for
  the admin-only `GET /v1/app/outstanding` to answer `"clear": true`; see
  [Rolling back to 2.3.0](#rolling-back-to-230) for what 2.3.0 then keeps and
  what stops.
- **No new settings.** Webhook payloads and the existing administrator API
  responses are unchanged.
- **Install and sign-in on a real iPhone are still not verified.** The in-app
  sign-in has been tested in a simulated browser and against a real Jellyfin;
  see [Household app (PWA)](README.md#household-app-pwa).

### Added

- **Household app "Get this" API (with `HOUSEHOLD_APP_ENABLED=true`).**
  Household hostnames serve
  `POST /jellypass/app/v1/{movie|tv}/{tmdbId}/get` (series:
  `{"seasons": [...]}`), which answers `202 {"status":"accepted"}` as soon as
  the caller's sign-in, the input and the rate limits pass, before the
  caller's eligibility or anything about the title is read, and then
  in the background: does nothing if the caller can already play it or the
  household already asked; joins the household to the title's grant if
  Jellyfin already has it (found by TMDB ID, by the item Seerr links to the
  title, or by name and year, so items without TMDB metadata count; by the Add
  to my library rules: request grants only, administrator removals stick, only
  the household whose hostname was used), **never requesting a title Jellyfin
  has**; records the household's interest if someone already requested it,
  joining the household when the title becomes available; and otherwise makes
  a real HD Seerr request as the caller. Before that request is sent, a request
  intent is written to the state file and the caller is confirmed, and
  Jellyfin is read once more as the last step; until the request is recorded
  and settled, no webhook or backfill grants a request for the title (webhooks
  are acknowledged and granted afterwards, also after a restart). A request
  whose title arrived while it was being made (or whose settle-time check
  could not be read in time), and a request for new seasons of a series
  Jellyfin already has, are granted by the join rules, never as a new private
  grant: a public title stays public. Series are decided season by season and
  are ready once every season asked for has episodes. **Seerr request quotas
  are not supported yet:** a caller with a quota sees every title they cannot
  play as `unavailable` ("Can't request") and their "Get this" does nothing;
  they still request in Seerr. New per-user (10), per-address (30) and
  per-household (30) limits per 10 minutes. `GET /jellypass/app/v1/requests`
  lists the household's own titles with a coarse status (`requested`, `ready`,
  `failed`, per season for a series), an opaque ID and whether the caller
  asked, from JellyPass's records only. Titles now show `requested` from those
  records alone, never from Seerr or membership. Records are brought up to
  date by the scheduled reconciliation and when a grant is created; a
  household deleted while a call runs (even if created again under the same
  ID) never gets that call's records or joins. Seerr title answers are parsed
  in a bounded worker thread, stopped at shutdown. New metrics
  `jfa_app_get_this_total{result}` and `jfa_app_get_this_branches_total{branch}`,
  and a `deferred` result for `jfa_webhooks_total` and
  `jfa_request_backfill_total`. **When in doubt, the join rules:** a request
  "Get this" made, or may have made, whose grant must not be private is kept
  as a safety tombstone apart from the records (so pruning a record never
  loosens it); an intent whose request cannot be told apart (several or a
  declined one found, none found in time, its household replaced, or Seerr or
  Jellyfin unreadable for 30 minutes) records nothing for the household and
  makes the member's requests for the title joins for 30 days (a tombstone
  naming a request not handled yet is kept until it is, up to 400 days), and
  after 30 minutes no longer holds up anyone else's grant. Deferred webhooks are
  granted genuine ones first, and a join that finds no grant waits for one.
  Jellyfin's search by name is read in full (up to 2,000 items a name, more
  counts as present) and an item without metadata whose name contains the
  title's counts too. The title worker's timeout runs from when the oldest
  answer was handed over. The state file stays at schema v7 and gains
  `appRequests`, `appIdKey`, `appRequestIntents`, `deferredWebhooks`,
  `appSafetyTombstones`, `householdEpochs` and `nextHouseholdEpoch`, which 2.3.0
  and 2.2.1 keep without reading. **Before rolling back** to 2.3.x or 2.2.1,
  drain: stop new "Get this" calls, wait until no `appRequestIntents` or
  `deferredWebhooks` are left (at most 30 minutes plus one reconciliation
  interval), then roll back only once the admin-only
  `GET /v1/app/outstanding` answers `"clear": true`. Requests covered by an
  outstanding safety marker (`appSafetyTombstones`) are granted as ordinary
  requests while rolled back, and a marker naming a request not handled yet
  lasts until it is, up to 400 days, not 30 (see
  [Store, bounds and rollback](docs/app-design.md#get-this-as-implemented-step-2a)).
  See ["Get this" as implemented](docs/app-design.md#get-this-as-implemented-step-2a).
- **Get this, a season picker and My requests in the app.** A title (or
  season) the API marks `get_this` has a **Get this** button; a series page
  first asks **Choose the seasons you want** among its seasons available to
  get (a season page asks for its own season only). The button shows
  **Sending…** while the call is in flight, then one fixed confirmation,
  "Thanks — we'll get this for your household.", as soon as the call is
  accepted, whatever happens afterwards; it is kept if reading the page again
  then fails, with a **Try again** that only reloads the page. Too many tries,
  being offline and an outage each have their own fixed message. A title the
  household already asked for is not offered again, and one whose request
  failed shows **We couldn't get this** with no button and "Ask your JellyPass
  admin to try again.", since the API does not ask again while the failed
  record stands. New **My requests** tab: the household's requests with their
  status (**Requested**, **Ready to watch**, **We couldn't get this**, per
  season for a series) and whether the member asked ("Asked for by you") or
  someone else in the household did, with titles named from TMDB a few at a
  time. Title states are relabelled: **In your library** is now **Ready to
  watch** and **Available to request soon** is now **Available to get**.
- **"Ready to watch" only for members who can play it.** A title (or season)
  the household's "Get this" record says is ready shows `ready` in
  `GET /jellypass/app/v1/requests`, and `in_library` on its page, only to a
  member whose own Jellyfin view has it; to a member another library, a
  parental limit or a blocked tag hides it from, it stays `requested` (before:
  `ready` in the list and `get_this` on the page). The list reads the
  member's own view of every listed title, ready or not, and lists a title
  whose read fails as `requested` rather than failing, so a title arriving in
  a library the member cannot see changes neither the list's Jellyfin reads
  nor its answer.
- **A "Get this" request is never sent before its intent is on disk.** Just
  before the Seerr request leaves, JellyPass checks that the state file holds
  the request intent that protects its grant (written and renamed into place,
  though not fsynced, so this survives a process crash, not a power cut);
  if it does not, nothing is sent (new branch `request_unsaved` in
  `jfa_app_get_this_branches_total`). The test suite checks the same from
  Seerr's side for every request.
- **What "Get this" still has outstanding, for administrators.** New
  `GET /v1/app/outstanding` (admin host and admin token or session only; never
  on household hosts) lists the safety tombstones that still decide a grant,
  the request intents not settled yet and the webhooks deferred for them:
  counts by kind, the oldest age, each title's TMDB ID and (for intents) the
  household, never a member, and `clear: true` once all are 0 (always, if
  "Get this" was never used). New gauges `jfa_app_safety_markers{kind}`,
  `jfa_app_request_intents{status}` and `jfa_app_deferred_webhooks` carry the
  counts.

### Fixed

- **The household app signs in inside the app.** Tapping **Sign in** used to
  send the member to Jellyfin web (`/web/`), which has no return address, so
  they had to open the app again, and the installed iPhone app, whose storage is
  apart from Safari's, could not be signed in from Safari at all. The app now
  shows the household's profile picker, a password step (or one tap for
  passwordless members), and signs in through the household gateway exactly as
  Jellyfin web does, with the same household scoping and sign-in rate limit and
  fixed messages for a wrong password, too many attempts and an outage. The
  sign-in is stored in Jellyfin web's own format, so the app and Jellyfin web
  share one session and **Play** stays signed in. New **Sign out** revokes the
  session and also signs Jellyfin web out on that address. **Open Jellyfin to
  sign in** remains as a fallback.
- **Hidden Jellyfin users in a household can sign in.** Jellyfin leaves hidden
  users off its public list, so they were missing from the household's profile
  picker and, with Jellyfin web's **Manual Login** hidden on household
  addresses, could not sign in there at all. The app's picker now always offers
  **Sign in with a different name** (and starts there when it lists nobody),
  and Jellyfin web's **Manual Login** is shown again on household addresses.
  A typed name is checked against the household's members whether or not they
  are hidden; any other name gets exactly the answer a wrong password gets, no
  sooner than one second after the attempt, under the same per-client limit.
  No failed sign-in tells a member from anyone else: a request Jellyfin would
  refuse whoever it named (no client metadata in `Authorization`, or a body
  that is not a name and a password) is refused with `400` before the name is
  looked up, any answer but success that Jellyfin gives a member is a wrong
  password, and "Jellyfin unavailable" means its user list could not be read,
  for any name. A sign-in waits at most 15 seconds for Jellyfin.
- **No CDN keeps any `/jellypass/app` answer.** Errors, unknown paths, API
  answers, refusals and the WebSocket refusal under `/jellypass/app` are now
  sent with `Cache-Control`, `CDN-Cache-Control` and
  `Cloudflare-CDN-Cache-Control: no-store`, like the page; fingerprinted files
  stay `immutable`. The WebSocket refusal a household hostname sends while
  JellyPass shuts down carries the same headers, on any path.
- **The app's files can no longer be mixed across releases by a CDN.** Cloudflare
  rewrote the `Cache-Control: no-cache` on the app's `.css`/`.js` files
  (including `sw.js`) to `max-age=14400` and stripped the page's `ETag`, so after
  an update a browser could run old and new files together for up to four hours.
  Every file the page loads except the page and `sw.js` now has a content hash
  in its name (`app.<hash>.css`) and is served `public, max-age=31536000,
  immutable`; the page names exactly its own release's files and an old hash
  answers `404`. The page, the `/jellypass/app` redirect and `sw.js` are sent
  `no-store` with `CDN-Cache-Control` and `Cloudflare-CDN-Cache-Control:
  no-store`, and the worker is registered with `updateViaCache: 'none'` and
  precaches the hashed names. Purge your CDN's cache for `/jellypass/app/*`
  once after upgrading.

### Upgrading from 2.3.0

1. **Back up the state file** first, as before any upgrade (see
   [Backup and restore](README.md#backup-and-restore)): stop JellyPass, copy
   the file with its permissions (`cp -p`), start it again. 2.4.0 does not
   migrate the file, but the backup is the clean way back if anything else
   goes wrong.
2. **No setting changes are needed.** Nothing is added, removed or renamed.
3. **If the household app is enabled, decide about Get this before
   upgrading.** Members with Seerr request permission will be able to request
   titles from the app as themselves (with auto-approve, those requests are
   approved at once). Check Seerr's request limits: a member with a limit, or
   everyone if Seerr has a default limit, sees **Can't request** and requests
   in Seerr instead. Household members still must not have Seerr's
   `MANAGE_BLOCKLIST` permission. To keep the app read-only for now, block
   `POST /jellypass/app/v1/movie/*/get` and `POST /jellypass/app/v1/tv/*/get`
   at the reverse proxy before upgrading.
4. **Upgrade:** set `JELLYPASS_IMAGE` to
   `ghcr.io/nicklongmore86/jellypass:2.4.0`, pull, recreate the container and
   check `/health` and the logs.
5. **Purge your CDN's cache for `/jellypass/app/*` once**, if a CDN sits in
   front of household hostnames.
6. **Check sign-in on a household address:** a member signs in with their
   password (and a hidden member through **Manual Login** or **Sign in with a
   different name**). A client or script that signs in there without
   Jellyfin's `Authorization` client fields now gets `400`, and every refused
   sign-in but a rate-limited one takes at least one second.
7. **Watch the new metrics** once **Get this** is used:
   `jfa_app_get_this_total{result}` (`error` means the member's Seerr user or
   quota could not be read), `jfa_app_get_this_branches_total{branch}`
   (`request_unsaved`, a request held back because its intent was not in the
   state file, should stay 0), and the gauges
   `jfa_app_request_intents` and `jfa_app_deferred_webhooks`, which should
   return to 0 within about 30 minutes plus one reconciliation interval.

### Rolling back to 2.3.0

**Drain first** if **Get this** was used (if the app was never enabled,
`GET /v1/app/outstanding` already answers `"clear": true`):

1. Stop new **Get this** calls (block the two `POST .../get` paths at the
   reverse proxy, or pick a time no one uses the app), and leave 2.4.0 running
   with `RECONCILE_INTERVAL_SECONDS` above 0.
2. Wait until no request intents and no deferred webhooks are left: at most 30
   minutes plus one reconciliation interval (a restart reconciles at once).
3. Check the admin-only `GET /v1/app/outstanding` and roll back only once it
   answers `"clear": true`. Safety markers cannot be drained early: one
   covering a member's new requests lasts 30 days, and one naming a request not
   handled yet (pending, declined, never available) lasts until that request is
   handled, up to 400 days. Rolled back while any is outstanding, a request it
   covers is granted by 2.3.0's webhook or backfill as an ordinary (private)
   request, which can make a public title private (revoke that request in the
   admin UI to make it public again).

What 2.3.0 does then:

- **It keeps the state file whole.** 2.3.0 loads the seven new fields and
  writes them back unread, so nothing is lost and the backup is not needed to
  roll back; upgrading to 2.4.0 again picks them up (statuses catch up at the
  next reconciliation, and every opaque request ID stays the same).
- **It does not read them.** The app has no **Get this** and no
  `GET /jellypass/app/v1/requests` (the app is read-only, as in 2.3.0, and
  shows nothing as requested); records are not brought up to date and
  interests are not joined when their grant is created (after upgrading again,
  such an interest joins only at a later reconciliation); the webhook and
  backfill grant every request as an ordinary one; a household deleted while
  rolled back does not detach its records and keeps its epoch, so one created
  again under the same ID is taken for it after upgrading again.
  `GET /v1/app/outstanding` and the new metrics do not exist.
- **Sign-in on household addresses is 2.3.0's again:** Jellyfin's own failure
  answers are relayed, a non-member is refused at once, **Manual Login** is
  hidden and names are looked up in the public list, so **hidden members can
  no longer sign in** on household addresses. The app's **Sign in** sends
  members to Jellyfin web again; sessions already signed in stay signed in
  (they are stored in Jellyfin web's own format).
- **Purge your CDN's cache for `/jellypass/app/*` again** after rolling back:
  2.3.0 serves the app's files under fixed names with `no-cache`, which a CDN
  may keep for hours.

To roll back, set `JELLYPASS_IMAGE` back to
`ghcr.io/nicklongmore86/jellypass:2.3.0` and recreate the container. Rolling
back to 2.2.1 needs the same drain; 2.2.1 also keeps the new fields unread;
see [Rolling back to 2.2.1](#rolling-back-to-221) for the rest.

## [2.3.0] - 2026-10-24

This is a minor release. It adds the household app, which is **off by
default**: with `HOUSEHOLD_APP_ENABLED` unset, the only changes are the
household hostnames' `/jellypass/app` paths and a format check on
`TMDB_API_KEY` if it is set (see below); groups can be created without limit,
as in 2.2.1. Read these before
upgrading;
[Upgrading from 2.2.1](#upgrading-from-221) has the steps:

- **The household app is off by default.** To enable it, set
  `HOUSEHOLD_APP_ENABLED=true` together with `HOUSEHOLD_DOMAIN`, `SEERR_URL`
  and `SEERR_API_KEY`, and the new `TMDB_API_KEY` (a TMDB v3 API key or v4 API
  read access token). Startup stops if the app is enabled without any of
  them, or if TMDB refuses the key (`401` or `403`); a TMDB that cannot be
  reached at startup is only logged, and the app answers `unavailable` until
  it is back. A `TMDB_API_KEY` that is set but is neither a key nor a token
  stops startup even while the app is off.
- **What it serves:** on each household hostname, and nowhere else, an
  installable web app (a PWA) at `/jellypass/app/` and its JSON API under
  `/jellypass/app/v1`. Members sign in with their existing Jellyfin web
  session on that address, browse and search titles from TMDB, and see each
  title's state for their household (**In your library** with **Play**,
  **Available to request soon**, or **Can't request**). While the app is off,
  `/jellypass/app` paths on household hostnames answer `404` instead of being
  proxied to Jellyfin.
- **It is read-only in 2.3.0.** There is no **Get this** yet: the app makes no
  Seerr requests, and households keep requesting through Seerr as before.
- **The Seerr website is not restricted yet, so the late-request risk
  remains.** Seerr 3.5.x accepts a request for a title that is already
  available, and for a user with auto-approve, the webhook and backfill treat
  it as a genuine request, which can make a public title private, re-add
  access an administrator removed, or extend a manual-only grant. 2.3.0 does
  not change this; it is closed only once the app can request titles and the
  Seerr website is restricted to administrators (step 4 of
  [the app plan](docs/app-design.md#late-requests-closed-by-design)).
- **With the app enabled, at most 100 households.** While
  `HOUSEHOLD_APP_ENABLED=true`, creating a 101st household (group) is refused
  with `400`. A state file with more than 100 groups still loads (startup logs
  a warning) and every existing group keeps working and can still be changed
  or deleted; only new groups are refused until there are fewer than 100.
  With the app off there is no limit, as in 2.2.1.
- **Install and sign-in on a real iPhone are not verified yet.** They have
  only been exercised in a simulated browser; see
  [Household app (PWA)](README.md#household-app-pwa).
- **The state file is unchanged:** schema v7, with the same fields as 2.2.1.
  The app keeps everything it caches in memory and writes nothing to the
  state file, so 2.2.1 reads a state file written by 2.3.0; see
  [Rolling back to 2.2.1](#rolling-back-to-221).

### Added

- **Household app page (read-only PWA, off by default).** With
  `HOUSEHOLD_APP_ENABLED=true`, each household hostname also serves an
  installable web app at `/jellypass/app/` (iPhone: Share, Add to Home Screen;
  Android and desktop Chrome: Install app). It signs in with the member's
  existing Jellyfin web session on that address (no password, nothing stored),
  shows Home (Trending, Popular movies, Popular series, Upcoming movies),
  Search, movie and series pages with seasons and episodes, and About & credits
  with TMDB's logo and notice. Each title carries the household's state: **In
  your library** with a Play button, **Available to request soon** (no request
  button yet) or **Can't request**. A service worker caches only the app's own
  static files, one complete set per release, never the API. Install and
  sign-in on a real iPhone are not yet verified. The files are served with a
  strict CSP and security headers, the same for everyone, and only on
  household hosts. Built with `tsc` alone from `app/`; `linkedom` is a new dev
  dependency for tests.
- **Household app API (read-only, off by default).** With
  `HOUSEHOLD_APP_ENABLED=true` (which requires `HOUSEHOLD_DOMAIN`, Seerr and
  the new `TMDB_API_KEY`, a TMDB API key or read access token; startup stops
  without them, or if TMDB refuses the key), each household hostname serves
  JSON endpoints under `/jellypass/app/v1`: `me`, `search`,
  `discover/{trending,popular-movies,popular-tv,upcoming}`, `movie/:tmdbId`,
  `tv/:tmdbId` and `tv/:tmdbId/season/:n`. The caller signs in with their
  Jellyfin token (checked with Jellyfin, trusted for at most 5 minutes) and
  must belong to that household. Titles are read straight from TMDB, never
  from Seerr, so other households' Seerr records cannot change an answer or
  how long it takes. Each title carries the household's own state:
  `in_library` (the caller's own Jellyfin view has it, with a Play link, even
  without Seerr request permission), `unavailable` (blocklisted in Seerr, or
  the caller may not request it) or `get_this`; `requested` is reserved for
  when "Get this" records which household asked, so no Seerr request is shown
  in any household yet. Answers are built from allowlisted fields only, never
  depend on what another household holds or asked for, and have fixed error
  bodies and `Cache-Control: no-store`; calls are limited per client address,
  per user and per household, and counted in
  `jfa_app_requests_total{endpoint, outcome}`. Each household has its own
  caches, and households take turns at TMDB under a rate kept well below
  TMDB's (honouring its `Retry-After`), so one household's volume cannot
  evict another's cached answers or use up its share of TMDB calls. App cache
  limits count entries, not bytes (500 TMDB answers per household, each up to
  4 MiB as read): size memory for the households actually browsing; see
  [One cache per household](docs/app-design.md#one-cache-per-household). Do
  not give household members Seerr's `MANAGE_BLOCKLIST` permission. While the
  setting is off, `/jellypass/app` paths answer `404` and are never proxied to
  Jellyfin. See [Household app API](README.md#household-app-api) and
  [docs/app-design.md](docs/app-design.md).
- **At most 100 households while the household app is enabled.** With
  `HOUSEHOLD_APP_ENABLED=true`, creating a 101st household (group) is refused
  with `400` (`groups must be at most 100`); existing ones can still be
  changed. With the app off, groups are created without limit, as in 2.2.1.
  **Enabling the app with more than 100 groups:** the state file still loads
  and startup logs a warning; every existing group can still be changed or
  deleted and keeps working, but new groups are refused until there are fewer
  than 100, and the app caches nothing for any household while there are more
  than 100 (every app call goes upstream).
- **At most 10 TMDB calls in flight.** Besides the start rate, no more than 10
  TMDB calls are ever unanswered at once, and a call TMDB has not answered in
  15 seconds is abandoned, so a slow or hung TMDB cannot pile up connections.
- **Foundation for the household app.** Adds a Seerr client that acts as a
  household member's own Seerr user and never with a missing or empty
  `X-API-User` (which Seerr runs as its owner): it holds a Jellyfin user and
  confirms with Seerr, immediately before every call, which Seerr user is
  linked to it. Also a cached Jellyfin-to-Seerr user map that fails closed for
  unmapped users, synthetic Seerr 3.5.1 and TMDB fixtures with canary values
  for privacy tests, and `pnpm test:seerr`, which checks the client against a
  throwaway Seerr 3.5.1 container (also run in CI). The design is in
  [docs/app-design.md](docs/app-design.md).

### Upgrading from 2.2.1

1. **Back up the state file**, as before any upgrade. 2.3.0 keeps the schema
   v7 format and does not migrate the file or add fields to it, but the
   backup is the clean way back if anything else goes wrong.
2. **No setting changes are needed.** `HOUSEHOLD_APP_ENABLED` and
   `TMDB_API_KEY` are new and optional, and nothing is removed or renamed.
   Webhook payloads, the administrator API and its existing responses are
   unchanged while the app is off. If you already
   set `TMDB_API_KEY` for something else, make sure it is a valid TMDB key or
   token, or remove it: a malformed value stops startup.
3. **Optional: enable the household app.** Set `HOUSEHOLD_APP_ENABLED=true`
   and `TMDB_API_KEY`, with `HOUSEHOLD_DOMAIN`, `SEERR_URL` and
   `SEERR_API_KEY` already configured, recreate the container and check the
   logs: startup stops if any is missing or TMDB refuses the key. Check your
   household count first: with the app enabled, new groups are refused once
   there are 100, and if you have more than 100, startup logs a warning, new
   groups are refused until there are fewer than 100 and the app caches
   nothing. Then share
   `https://jelly-<household>.<HOUSEHOLD_DOMAIN>/jellypass/app/` with each
   household (with the default `HOUSEHOLD_HOST_PREFIX`). Make sure household
   members do not have Seerr's `MANAGE_BLOCKLIST` permission, and remember the
   app is read-only: households still request titles in Seerr, and the
   late-request risk above remains.
4. **Watch the new metric** `jfa_app_requests_total{endpoint, outcome}` once
   the app is enabled. A rise in `outcome="unavailable"` means Jellyfin, Seerr
   or TMDB failed or did not answer in time, or TMDB calls queued too long;
   check the logs.

### Rolling back to 2.2.1

The state file is unchanged, so 2.2.1 reads a state file written by 2.3.0
with nothing lost. 2.2.1 does not read `HOUSEHOLD_APP_ENABLED` or
`TMDB_API_KEY`, does not serve `/jellypass/app` (on household hostnames those
paths are proxied to Jellyfin again, so an installed app stops working; tell
households), and has no household limit. To roll back, set `JELLYPASS_IMAGE`
back to `ghcr.io/nicklongmore86/jellypass:2.2.1` and recreate the container.

## [2.2.1] - 2026-10-24

This is a patch release with one bug fix. There is nothing to do when
upgrading from 2.2.0: settings, webhook payloads, API fields and responses are
unchanged, and the state file is unchanged (schema v7, with the same fields as
2.2.0), so 2.2.0 reads a state file written by 2.2.1. To roll back, set
`JELLYPASS_IMAGE` back to `ghcr.io/nicklongmore86/jellypass:2.2.0` and recreate
the container.

### Fixed

- **A store write that failed partway no longer kept its first half.** A
  manual-access batch with an invalid later item, a grant move with a
  malformed later target, or a sync-status batch with a malformed later item
  ID left the earlier items changed in memory, and the next save stored them.
  None of these could happen in normal operation: the API validates and
  previews manual-access changes and grant moves first, and sync-status
  batches only name grants that were just stored. All three are now
  all-or-nothing.

## [2.2.0] - 2026-10-24

This is a minor release. No settings change, and most deployments can upgrade
without changes. Check four things first;
[Upgrading from 2.1.1](#upgrading-from-211) has the steps:

- **The request backfill now grants only approved or completed Seerr
  requests.** Earlier versions also granted pending, declined and failed
  requests whose media was available, which could make a title private to a
  household or add a household to an existing grant. Grants such requests
  already produced are not changed; review them if this affected you.
- **Tell households about the new Add to my library page,**
  `/jellypass/add` on each household hostname. It is served only when both
  household hostnames (`HOUSEHOLD_DOMAIN`) and Seerr lookup (`SEERR_URL`,
  `SEERR_API_KEY`) are configured; without Seerr lookup those paths are still
  proxied to Jellyfin.
- **The state file stays at schema v7 but gains fields:** `removedAccess` and
  `revokedRequests` at the top level, `joins` and `remap` on grants, and the
  `orphaned` sync state. 2.1.1, 2.1.0 and 2.0.0 still load it.
- **Rolling back to 2.1.1 needs care.** 2.1.1 keeps the new records but does
  not act on them, retries orphaned grants, drops a grant's join history when
  it rewrites the grant, and its backfill grants unapproved requests again; see
  [Rolling back to 2.1.1](#rolling-back-to-211).

### Added

- **Add to my library.** Household hostnames serve `/jellypass/add`, where a
  user signed in to Jellyfin pastes a Seerr or TMDB link and adds a title
  another household requested to their own library. Seerr hides Request for an
  available movie and rejects duplicates while it downloads, so this was
  otherwise impossible for movies. JellyPass resolves the title's HD item
  through Seerr and adds the caller's households (or the caller, when they
  belong to none) to the item's grant if the grant came from a request;
  manual-only grants are untouched and nothing is removed. Once the caller is
  signed in and the input is valid, the answer is the same `202` at once in
  every case: the lookup and the join run in the background afterwards, so
  neither the answer nor the time it takes reveals whether, or by whom, a title
  is held. The caller is identified only by their Jellyfin token, checked with
  Jellyfin; calls are rate-limited per client address (30 per 10 minutes),
  each user may start 10 joins and all users together 200 per 10 minutes
  (further calls get the same answer but are not started, and a call past a
  user's own budget does not use up the shared one; the budgets count calls,
  never how long a join took, over fixed 10-minute windows starting at the
  first call counted, so they limit the rate joins are started, not how many
  are in flight: joins still queued from one window add to the next), and
  calls are refused during shutdown, which stops running joins and waits for
  them like other background work. An administrator's join changes nothing,
  since administrators already see every title. Requires household hostnames
  (`HOUSEHOLD_DOMAIN`) and Seerr lookup (`SEERR_URL`, `SEERR_API_KEY`); no new
  settings.
- Grants record each join in `joins`. The groups an administrator removed from
  an item, and the users an administrator's change took access from (including
  the members of a removed household and a revoked request's requester), are
  kept in one per-item removal record in the state file (`removedAccess`,
  shown as `removed` on each grant in `GET /v1/grants`) that library joins and
  grant moves both check, so a join never undoes an administrator's removal: a
  marked user's joins change nothing, even through a household they join later
  or after leaving the removed one. Joins never touch a grant left behind on a
  deleted item (`orphaned`, or carrying a `remap` note). The state file stays
  at schema v7.
- `jfa_library_joins_total{result}` counts joins as `joined`, `unchanged`,
  `error` or `dropped` (not started because a budget was used up).
- **Orphaned grants.** A grant whose deleted item has no resolvable
  replacement is marked `orphaned` (`sync.state` in `GET /v1/grants`, an
  `orphaned` status in Grants) and logged once. It is kept, no longer retried
  by scheduled reconciliation, and counted by the new `jfa_orphaned_grants`
  gauge instead of `jfa_sync_errors`. A full `POST /v1/reconcile` tries it
  again.
- **`POST /v1/grants/{itemId}/remap`** (`{"toItemId": "..."}`, supports
  `?dryRun=true`) and a **Move** action in Grants move a grant whose item was
  deleted to another Jellyfin item, merging its whole audience into any grant
  already there. The target must exist. A grant whose item still exists is
  refused with `409` (`code: "source_item_exists"`), since moving it would make
  that item visible to every household: revoke it explicitly instead. Moving a
  4K request onto the title's HD item (or HD onto 4K) is refused with `409`
  (`code: "quality_mismatch"`). The old grant is removed only after the target
  is applied; if applying fails, it is kept and the move can be repeated, and if
  the old item reappears meanwhile it is kept as above and the move answers
  `409` (`code: "source_reappeared"`).
- `jfa_grant_remaps_total{result="remapped"|"orphaned"|"source_reappeared",trigger="auto"|"admin"}`
  counts grants moved to a new item, marked orphaned, or kept because their
  item reappeared, by whether reconciliation or an administrator's move did it.

### Changed

- `pnpm test` and `pnpm test:real` run with a private temporary directory and
  fail if a test leaves anything in it; the tests now remove the temporary
  directories they create.

### Fixed

- **A deleted and re-imported title kept its grant on the deleted item.** When
  Jellyfin deleted a title and imported it again under a new item ID, the
  request-derived grant kept pointing at the deleted item: reconciliation
  failed on Jellyfin's `404` forever (backing off to hourly, with
  `jfa_sync_errors` stuck), and the new item had no grant, so every household
  could see it. Reconciliation (including a re-sent `MEDIA_AVAILABLE` webhook
  for the request) now asks Seerr which item each of the grant's requests
  resolves to, keeping 4K and HD items apart, and moves the grant there,
  merging into any grant already on the new item. When every request resolves
  to the same item (the usual re-import) the whole audience moves, manual users
  and groups included. When they resolve to several items, each gets only its
  own requests and those requesters' households (limited to groups the grant
  already had); manual users and groups that cannot be attributed stay on the
  old grant, which is marked `orphaned`. A request that resolves to no existing
  item is never assigned to another one (so a 4K request never lands on an HD
  item); it too stays on the orphaned grant. A grant left over from such a
  split remembers it (`remap.splitTo`): when its remaining requests resolve
  later, only they and their requesters' households move, and its manual users
  and groups stay orphaned until an administrator assigns them. The new grants are stored and
  applied before the old one is removed or reduced, so a restart partway
  through converges on the next run without anyone gaining or losing access;
  the deleted item's tag is then removed from user policies. If the deleted item
  exists again by then, the old grant is kept intact with its restrictions and
  marked `source reappeared` (`remap.sourceReappeared`), logged and counted; the
  new grants stay applied. Revoking a request is remembered per item
  (`revokedRequests` in the state file): no recovery or move adds that request
  to that item again, even from a copy left on the old grant by an unfinished
  move. A new Seerr request for the title is unaffected. Removing a manual
  user or a group from an item is remembered the same way, per item, in the
  removal record shared with **Add to my library** (see Added): no recovery or
  move, dry runs included, adds it to that item again, removing it from the old
  grant leaves the new one alone, and assigning it to the item again as an
  administrator (or deleting the group) clears the record. When a grant moves,
  the old item's removal marks and revoked requests are recorded for the new
  item too (except for what the new item's grant already had on its own), so
  nobody an administrator removed before the move can add themselves back with
  a library join; the old grant's join audit history moves with the households
  it added. Only a `404`
  counts as deleted; network failures and `5xx` responses keep the usual retry.
- A grant left with no requests, manual users or groups on a deleted item (for
  example after revoking its last request) is now removed instead of failing
  on the `404`.
- **The request backfill granted requests Seerr had not approved.** Seerr's
  request list includes pending, declined and failed requests, and the backfill
  only checked that the media was available. A pending or declined request for
  a title that was available through another request (or already in the
  library) therefore made the title private to the requester's household, or
  added that household to an existing grant. The backfill now also requires
  the request status to be approved or completed (Seerr v3.5.0 statuses 2 and
  5). Such requests are not recorded as handled, so one that Seerr approves
  later is still picked up. The webhook is unchanged.
- **Administrator dry runs now return exactly the grant the write would
  store.** With `?dryRun=true`, the `current` grant in manual access
  (`PUT /v1/grants/{itemId}/manual`) and bulk access (`PUT /v1/library/access`)
  previews left out `sync.lastSuccessAt`; revoke request
  (`DELETE /v1/grants/{itemId}/requests/{requestId}`) and set groups
  (`PUT /v1/grants/{itemId}/groups`) previews returned the grant's previous
  `sync` instead of `pending`; and the set groups preview also kept the
  previous `updatedAt` and listed `groupIds` in input order instead of sorted.
  Only the previews were wrong: real writes and access were never affected.

### Upgrading from 2.1.1

1. **Back up the state file**, as before any upgrade. 2.2.0 keeps the schema
   v7 format and does not migrate the file, but it adds records that 2.1.1
   does not act on (see [Rolling back to 2.1.1](#rolling-back-to-211)), so the
   backup is the clean way back.
2. **No settings change.** No environment variable is added, removed or
   renamed, and webhook payloads and existing API fields are unchanged.
   `GET /v1/grants` gains the optional `joins`, `remap` and `removed` fields
   and the `orphaned` sync state.
3. **Review grants the backfill may have made from unapproved requests.** If
   request backfill is enabled, earlier versions could have granted a pending,
   declined or failed request whose media was available. 2.2.0 does not undo
   those grants; check Grants for titles that are private to a household that
   never had its request approved, and revoke the request or adjust the groups.
4. **Tell households about Add to my library.** With `HOUSEHOLD_DOMAIN` and
   Seerr lookup configured, share `/jellypass/add` on each household hostname
   (see "Add to my library" in the README). Without both, the page is not
   served and nothing changes.
5. **Watch the new metrics.** Grants left on deleted items that cannot be
   recovered move from `jfa_sync_errors` to the new `jfa_orphaned_grants`
   gauge; remap them with **Move** in Grants or revoke them.

### Rolling back to 2.1.1

The state file format is unchanged (schema v7), so 2.1.1 (and 2.1.0 and 2.0.0)
still load a state file written by this version and keep its top-level
`removedAccess` and `revokedRequests` records when they save it. They do not
act on them, though, and they differ in these ways:

- Access added by **Add to my library** stays: a join adds ordinary groups or
  manual users to a grant. 2.1.1 does not serve `/jellypass/add`; those paths
  are proxied to Jellyfin, so tell households the page is unavailable.
- They do not know the `orphaned` state: a scheduled run retries an orphaned
  grant, fails on the deleted item's `404`, and then backs off to hourly
  retries, counting it in `jfa_sync_errors` again. They do not recover
  re-imported titles either.
- Whenever they rewrite a grant (a new request granted to it by the webhook or
  backfill, a revoked request, an administrator changing its groups or manual
  access, deleting one of its groups) they drop that grant's `joins` and
  `remap` fields. A rewritten grant loses its join audit history and its
  `remap.splitTo` or `remap.sourceReappeared` note for good.
- Administrator changes made while rolled back do not update `removedAccess`
  or `revokedRequests`: a user or group removed then is not marked (after
  upgrading again, they can join that grant with **Add to my library** or be
  restored by a move), and one assigned again then stays marked (which only
  stops their own later joins and moves, not the access they have).
- Their request backfill grants pending, declined and failed requests whose
  media is available again. Requests 2.2.0 skipped for that reason are not
  recorded as handled, so 2.1.1 grants them on its next backfill. Turn the
  backfill off while rolled back (`REQUEST_BACKFILL_ENABLED=false`) if this
  matters to you.

Before rolling back, remap or revoke orphaned grants and resolve grants marked
`source reappeared`. To roll back, set `JELLYPASS_IMAGE` back to
`ghcr.io/nicklongmore86/jellypass:2.1.1` and recreate the container. After
upgrading again, review the audiences of grants changed while rolled back, or
restore the state-file backup taken before rolling back.

## [2.1.1] - 2026-10-16

This is a patch release. No configuration, API or state-file changes are
needed: settings, webhook payloads and API field names are unchanged, and the
state file format is unchanged (schema v7), so 2.1.0 can read a state file
written by 2.1.1. To roll back, set `JELLYPASS_IMAGE` back to
`ghcr.io/nicklongmore86/jellypass:2.1.0` and recreate the container.

### Changed

- **Seerr naming.** The administrator UI, error messages and documentation now
  say Seerr instead of Jellyseerr, and the Dashboard's "Jellyseerr activity"
  section is now "Activity". Seerr is the successor to Jellyseerr, and
  Jellyseerr installations keep working unchanged. API field names and error
  codes that contain `jellyseerr` (`importToJellyseerr`,
  `jellyseerrImportAvailable`, the `jellyseerr` result of `POST /v1/users`, and
  `user_created_jellyseerr_import_failed`) are unchanged, as are environment
  variables, metrics and the state file.
- **Releases are gated on a real Jellyfin.** The publish workflow runs the
  real-Jellyfin integration test before it publishes any image or creates a
  release, so a failing test blocks both.
- The real-Jellyfin integration test now sends webhooks through JellyPass's
  HTTP server: an HD `Movie Request Now Available` webhook, matching the README
  template, must grant and then revoke access on Jellyfin, and without Seerr
  lookup a webhook with no recognized HD `event` must be rejected with `502`
  and grant nothing. The test had failed since the 2.1.0 webhook change,
  including on the 2.1.0 release commit, because it still sent a webhook
  without `event`; JellyPass behaved correctly and the test was out of date.
- `pnpm test:real` starts a throwaway Jellyfin container with Docker (or uses
  `JELLYFIN_REAL_URL`), and `pnpm test:all` runs both suites.

### Fixed

- **Stopping the container waited for SIGKILL.** On `SIGTERM` or `SIGINT`
  JellyPass waited for every connection to close, and a proxied household
  WebSocket (an idle browser tab, for example) never does, so `docker stop`
  hung for 10 seconds and ended with exit code 137. Shutdown now stops the
  reconcile, catalog sync and backfill timers, stops accepting connections,
  and closes proxied WebSockets on both sides. Reconciliation, request
  backfill and catalog sync that are already running start no further steps.
  In-flight HTTP requests and background jobs get one second to finish while
  idle keep-alive connections are closed. JellyPass then waits for any pending
  state-file write, refuses further changes, and exits `0`, normally well
  under a second. It exits `1` if that final write fails (logged as
  `shutdown failed`) or if anything still hangs after five seconds (logged as
  `shutdown timed out; exiting`). A second signal during shutdown is ignored
  rather than killing the process mid-write.

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

[Unreleased]: https://github.com/nicklongmore86/jellypass/compare/v2.6.0...HEAD
[2.6.0]: https://github.com/nicklongmore86/jellypass/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/nicklongmore86/jellypass/compare/v2.4.1...v2.5.0
[2.4.1]: https://github.com/nicklongmore86/jellypass/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/nicklongmore86/jellypass/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/nicklongmore86/jellypass/compare/v2.2.1...v2.3.0
[2.2.1]: https://github.com/nicklongmore86/jellypass/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/nicklongmore86/jellypass/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/nicklongmore86/jellypass/compare/v2.1.0...v2.1.1
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
