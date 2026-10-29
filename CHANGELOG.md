# Changelog

All notable changes to JellyPass are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

JellyPass's public interface is its settings, its state file, its administrator
API, its webhook and app endpoints, and successful responses on the endpoints it
relays to Jellyfin. Failure responses on relayed Jellyfin endpoints (status,
body and headers when a request is refused or fails) are not part of that
interface: they may change in a minor or patch release to close a security or
privacy leak. Requests on a household hostname that would get around a
household check (signing in without the membership check, for example, or
reaching an item the caller may not see) may likewise be refused in a minor or
patch release, even where Jellyfin used to answer them with a success. Such
changes are always listed at the top of the release notes.

## [Unreleased]

### Added

- TV add-on: **service and studio pages** on the Discover page. A service row's heading ("Popular on Netflix ›") is now a
  link, and each studio's logo is a tile you can choose; either opens that service's or studio's own page in Jellyfin
  (`#/jellypass/service/<id>`, `#/jellypass/studio/<id>`), as in the household app: the logo and name, **All / Series /
  Films** tabs (Films only for a service whose films are listed; a service without them has its series only), **Hide what I
  have** (the same choice as on Discover), a grid of 20 titles with a **Load more** button, the JustWatch credit under All and
  Films, and the TMDB notice. Back from a title returns to the same title on the same tab with the pages that were showing,
  without asking again; a service opened from a row costs no new call. Only the services and studios the app lists have a page:
  any other address says "Not found". Headings stay headings for a screen reader (the control inside is named "Popular on
  Netflix, see all"). No server, API or setting change.

## [3.7.0] - 2026-10-29

This is a minor release for the TV add-on, which is still experimental and off
by default: **unless `TV_ADDON_ENABLED` is set, nothing changes** on any host.
The add-on gains a **Discover** page, the household app's Home inside Jellyfin
web, and the compass button in Jellyfin's header that opens it. Everything is
additive. No setting is added, removed or renamed, and the server itself is
unchanged: the state file (schema v7), the app API (`v1`, `apiVersion` 2),
webhook payloads, the administrator API, the admin UI, the household app and
the gateway are as in 3.6.1. The page uses only app API calls that already
exist. The add-on's pages are not part of the public interface described at
the top of this file. This is a minor release because the add-on gains a page.
Read these before upgrading:

- **Nothing to configure.** No setting is new, and nothing in `.env` needs to
  change. Only households the TV add-on is on for (`TV_ADDON_ENABLED` and
  `TV_ADDON_HOUSEHOLDS`) see anything new.
- **The state file is unchanged** (schema v7, with the same fields as 3.6.1),
  so 3.6.1 reads a state file written by 3.7.0.
- **The Discover page is reached only from the compass button** that the
  add-on puts in Jellyfin's header, immediately before Search. On Jellyfin web
  12.3 it is drawn in both the TV layout and the desktop layout. Jellyfin web
  10.11 in a desktop browser gets no button (the Samsung app's 10.11 runs the
  TV layout, whose header has it). If a Jellyfin update changes its header so
  that the button cannot be placed, the button does not appear, and **there is
  no other way in**: no link on Home, no card at the end of a row, no menu
  entry. Only an address typed into a browser opens it then.
- **The services' headings and the studios' tiles are not links yet.** They
  show what is there; their own pages come in a later release.
- **No CDN purge is needed.** The add-on's script and stylesheet are named for
  a hash of their content, and both names change in this release. The
  household address's `/web/` page that carries the add-on's tag and the
  Samsung app's manifest are sent `no-store`, so they name the new files at
  once.
- **It has been tested in a real Jellyfin 12.3 container,** in the TV layout
  and the desktop layout, in a desktop browser, but **not on a real TV**.
  Check the button, the page, its rows and Back in a desktop browser on that
  household's address, then on a TV, before relying on it;
  [docs/tv-addon.md](docs/tv-addon.md) lists what to check. **Memory on a
  2019 Samsung is a real-TV check:** the page keeps pictures only for the rows
  near the screen, but how much memory such a TV holds for them has not been
  measured. Scroll the whole page down and up a few times, switch chips and
  open and leave a title, and look for a crash, a reload or rows that stay
  blank.
- **The Samsung app picks it up by itself.** Its loader reads the manifest
  each time it starts, so a Samsung TV with the JellyPass build of the app
  gets the new add-on at its next start. Nothing is reinstalled on the TV.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.6.1` and recreate the container. No
  state-file or setting change is needed. The add-on loses the Discover page
  and its header button, and is otherwise as in 3.7.0.

### Added

- **TV add-on: the Discover page.** On the households the TV add-on is on
  for, Jellyfin web gains a **Discover** page (`#/jellypass/discover`, a page
  of Jellyfin web's own under its real header and Back, in the TV and the
  desktop layout, with no key handling of its own), opened from a **compass
  button in Jellyfin's header, right before Search** (see the upgrade notes
  for where it appears). It is the household app's Home on the TV:
  - a **hero** of up to five titles (the first row's first titles with a
    wide picture), with **‹**, **View** and **›** buttons and dots, and no
    auto-advance; **View** opens the title;
  - the **All / Movies / TV** chips and a **Hide what I have** toggle, which
    hides the row titles in the library or already requested (the hero's
    slides are unchanged) and asks for nothing;
  - on All, the **Trending**, **Popular movies**, **Popular series**, **New
    movie releases**, **Upcoming movies** and **Upcoming series** rows and
    the eight **Popular on …** service rows (Movies and TV show their own
    rows, as the app does), at most 14 titles a row;
  - a badge in words on each title, not only in colour: **In your library**,
    **Requested**, **Available to get** or **Can't request**;
  - at the foot, the studios (All and Movies), the JustWatch line (All and
    Movies) and the TMDB notice (every chip), reachable by the remote.

  Choosing a title opens the JellyPass title page, and Back returns to the
  same title on the Discover page with no Discover call (within ten minutes
  of opening it; after that the page asks again and focus may land on the
  hero's **View**). The page asks
  for 5 things when it opens on All and 10 more as the remote scrolls down to
  the rows that need them; a row's pictures are set only while it is near the
  screen, to spare a 2019 Samsung's memory. Its answers are kept in memory
  for ten minutes and forgotten on a sign-out, another member or a new
  sign-in, and an answer that comes back for a session that has ended is
  dropped. A row that fails says why, with **Try again** (a refused sign-in
  shows **Sign in to continue** instead, with no Try again); nothing is asked
  again by itself, and after a "too many requests" answer nothing is asked
  until the time the server gave (or 30 seconds) is over. Home's and
  Search's Discover rows are unchanged. The calls the page makes are written
  in `docs/app-api/fetch-budget.json` (`tv-discover`).

## [3.6.1] - 2026-10-28

This is a patch release for the TV add-on, which is still experimental and off
by default: **unless `TV_ADDON_ENABLED` is set, nothing changes** on any host.
It fixes one thing, the add-on's cards showing no focus ring, and adds nothing.
No setting is added, removed or renamed, and the server itself is unchanged:
the state file (schema v7), the app API (`v1`, `apiVersion` 2), webhook
payloads, the administrator API, the admin UI, the household app and the
gateway are as in 3.6.0. Only the add-on's stylesheet changes. Read these
before upgrading:

- **Nothing to configure.** No setting is new, and nothing in `.env` needs to
  change. Only households the TV add-on is on for (`TV_ADDON_ENABLED` and
  `TV_ADDON_HOUSEHOLDS`) see anything new.
- **The state file is unchanged** (schema v7, with the same fields as 3.6.0),
  so 3.6.0 reads a state file written by 3.6.1.
- **No CDN purge is needed.** The add-on's script and stylesheet are named for
  a hash of their content, and both names change in this release (the script
  names the stylesheet). The household address's `/web/` page that carries the
  add-on's tag and the Samsung app's manifest are sent `no-store`, so they name
  the new files at once.
- **It has been tested in a real Jellyfin 12.3 container,** in the TV layout
  and the desktop layout, in a desktop browser, but **not on a real TV**.
  Move through Home's and Search's Discover rows with the arrow keys in a
  desktop browser on that household's address, then on a TV, and check that
  each card shows the ring.
- **The Samsung app picks it up by itself.** Its loader reads the manifest
  each time it starts, so a Samsung TV with the JellyPass build of the app
  gets the new add-on at its next start. Nothing is reinstalled on the TV.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.6.0` and recreate the container. No
  state-file or setting change is needed. The add-on's cards lose the ring and
  are otherwise as in 3.6.1.

### Fixed

- **TV add-on: the add-on's cards show a focus ring.** The **Discover** title
  cards on Home and on Search, and the **My requests** card at the end of
  Home's Discover row, now show a white ring (the page's text colour) when
  they have focus, in both of Jellyfin web 12.3's layouts. In 3.6.0 a remote
  or keyboard could not see which of them had focus: the TV layout only zoomed
  the card slightly, and the desktop layout showed nothing. The ring is drawn
  inside the card, uses `:focus` (so it works on the older TVs' browsers) and
  adds no key handling. Jellyfin's own cards are unchanged, as are the title
  page's My requests button and the My requests page's filters, entries and
  Cancel/Keep buttons, which already showed focus.

## [3.6.0] - 2026-10-28

This is a minor release for the TV add-on, which is still experimental and off
by default: **unless `TV_ADDON_ENABLED` is set, nothing changes** on any host.
The add-on gains a **My requests** page, the links that reach it, and one rule
for late answers across the add-on. Everything is additive. No setting is
added, removed or renamed, and the server itself is unchanged: the state file
(schema v7), the app API (`v1`, `apiVersion` 2), webhook payloads, the
administrator API, the admin UI, the household app and the gateway are as in
3.5.0. The add-on's pages are not part of the public interface described at the
top of this file. This is a minor release because the add-on gains a page.
Read these before upgrading:

- **Nothing to configure.** No setting is new, and nothing in `.env` needs to
  change. Only households the TV add-on is on for (`TV_ADDON_ENABLED` and
  `TV_ADDON_HOUSEHOLDS`) see anything new.
- **The state file is unchanged** (schema v7, with the same fields as 3.5.0),
  so 3.5.0 reads a state file written by 3.6.0.
- **No CDN purge is needed.** The add-on's script and stylesheet are named for
  a hash of their content, and both names change in this release. The
  household address's `/web/` page that carries the add-on's tag and the
  Samsung app's manifest are sent `no-store`, so they name the new files at
  once.
- **It has been tested in a real Jellyfin 12.3 container,** in the TV layout
  and the desktop layout, in a desktop browser, but **not on a real TV**.
  Check My requests, its links and Back in a desktop browser on that
  household's address, then on a TV, before relying on it;
  [docs/tv-addon.md](docs/tv-addon.md) lists what to check.
- **The Samsung app picks it up by itself.** Its loader reads the manifest
  each time it starts, so a Samsung TV with the JellyPass build of the app
  gets the new add-on at its next start. Nothing is reinstalled on the TV.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.5.0` and recreate the container. No
  state-file or setting change is needed. The add-on loses My requests and its
  links, and is otherwise as in 3.5.0.
- **The iPhone, iPad and Android app ships separately.** Its 1.1.0 release
  (Cancel request, the day each title was requested, and My requests filters)
  is out, and its notes are in `mobile/CHANGELOG.md`. Neither 1.0.0 nor 1.1.0
  needs anything from 3.6.0, and both work with it as with 3.5.0.

### Added

- **TV add-on: My requests.** On the households the TV add-on is on for,
  Jellyfin web gains a **My requests** page (`#/jellypass/requests`, a page
  of Jellyfin web's own under its real header and Back, in the TV and the
  desktop layout, with no key handling of its own). It lists the household's
  requests as the web and mobile apps do: the status once (one pill, the
  seasons as text when they share it, a pill per season when they differ),
  **Asked for by you**, the day it was asked, the status, type and **Asked by
  me** filters (in memory only, applied to what is loaded, with no extra
  call), and **Load more**, which names ten requests at a time and reuses the
  titles it has named in the last ten minutes. **Cancel request** (on the
  requests the server says the member may cancel) asks first, with **Keep
  request** focused, and has the same fixed **Request cancelled** outcome and
  fixed failure messages; the title is **Get this** again on Home's Discover
  row, the Search row and its title page with no extra call. Choosing a
  request opens its title page, and Back returns to the same request. It is
  reached from a **My requests** card at the end of Home's Discover row and a
  **My requests** button on the title page of a title the household is
  following; Jellyfin's own menu is unchanged. When Home's Discover row has
  nothing to show (nothing left to get, or its load failed), a small row with
  only the **My requests** card is drawn instead, with no extra call, so the
  page is always reachable from Home (but not when Jellyfin web's sign-in was
  refused, where no row is drawn). The page's calls are pinned in
  `docs/app-api/fetch-budget.json` (`tv-requests`). The title page's note for a
  Requested title no longer points to the phone app. No setting is added or
  changed, and the app API is unchanged. See `docs/tv-addon.md`, "My requests".

### Fixed

- **TV add-on: an answer that comes back after a sign-out or a new sign-in is
  dropped.** Jellyfin web's sign-out does not reload the add-on, so a call
  could come back after it. That includes the same member signing in again
  with a new token. In 3.5.0 such an answer could still be applied if it was
  for the same member. Now one check, by member, token and sign-in, covers the
  whole add-on, for successes and failures alike. A late **Get this** or
  **Cancel request** answer changes nothing. A late title page, My requests,
  Home row or Search row answer is not drawn, and the add-on reads again once
  for the new sign-in.

## [3.5.0] - 2026-10-28

This is a minor release. Members can cancel their own requests, administrators
get a **Requests** tab to approve, decline and cancel requests and to release
held titles, My requests can be filtered, and the TV add-on gains a Search row
and a Samsung app. Everything is additive. No setting is added, removed or
renamed. The state file stays at schema v7 and only gains optional fields.
The app API (`v1`, now `apiVersion` 2) gains two fields and one endpoint, the
administrator API gains endpoints and fields, and the household host answers
the TV add-on's Samsung app across origins, only on households the add-on is
on for. No field, endpoint or status is removed, and nothing changes meaning in
a way an existing client depends on (see the one change of behaviour below).
Read these before upgrading:

- **Nothing to configure.** No setting is new, and nothing in `.env` needs to
  change. The Requests tab and member cancels are there wherever the household
  app is on (`HOUSEHOLD_APP_ENABLED` with Seerr); without it, the new admin
  endpoints answer `404 requests_not_configured`. The Samsung app's CORS and
  `/jellypass/tv/manifest.json` exist only on households the TV add-on is on
  for (`TV_ADDON_ENABLED` and `TV_ADDON_HOUSEHOLDS`): **unless
  `TV_ADDON_ENABLED` is set, nothing about the TV changes** on any host.
- **The state file stays at schema v7 and needs no migration.** Nothing is
  written until the first cancel or decline: then the state file gains
  `appWithdrawals`, and a cancelled "Get this" record gains a `withdrawn` mark
  on the existing `deleted` status. `appWithdrawals` is removed again once
  empty, and a withdrawn record is pruned like any other settled one. A state
  file written by 3.5.0 loads in 3.4.0, which keeps both fields
  as they are and reads a withdrawn record as `deleted`, so every household's
  list stays as it is.
- **Rolling back to 3.4.0 loses the cancel's protection.** 3.4.0 does not read
  withdrawals. While it runs:
  - a request a household cancelled, or an administrator declined or
    cancelled, is granted as an ordinary request to its requester's households
    if it arrives;
  - a requester who cancelled a request already on a grant gets access to that
    title again;
  - a title hold is not read, so a title whose request was deleted in Seerr
    arrives public;
  - a held grant that records a request with no linked requester (a Seerr user
    no Jellyfin user is linked to) fails to sync ("Jellyfin user not found")
    and keeps what it last applied.

  Members lose Cancel request (the apps get no `cancellable` and show no button),
  and administrators lose the Requests tab. To roll back without those
  effects:
  1. Stop cancels and "Get this" at the reverse proxy (block
     `POST /jellypass/app/v1/requests/*/cancel` as well as
     `/jellypass/app/v1/movie/*/get` and `/jellypass/app/v1/tv/*/get`), and use
     neither Decline nor Cancel request in the Requests tab.
  2. Read `GET /v1/app/outstanding` and look at `withdrawals`.
  3. For each `waiting` withdrawal that is not a title hold, wait until its
     title arrives (it is then `granted`), or delete its request in Seerr and
     wait for the next refresh (a requester's own withdrawal of a genuine
     request then becomes a title hold, step 4; one following the join rules,
     or a follower's, is dropped). Declining it in Seerr does not drain it: the request
     still exists, so the withdrawal keeps waiting.
  4. For each title hold (`titleHolds`), wait until its title arrives (it is
     then `granted`), or accept that it arrives public while rolled back.
  5. For each `granted` one, first give a held title (`GET /v1/app/held`) to
     the households that should have it with **Release**. Then revoke the
     request from **every** grant that records it
     (`DELETE /v1/grants/{itemId}/requests/{requestId}` for each item, including
     a title's other HD items and any copies left by a remap). The withdrawal
     stays while any grant still records the request, so repeat until
     `outstanding` no longer counts it.
  6. Roll back once `GET /v1/app/outstanding` answers `"clear": true`: set
     `JELLYPASS_IMAGE` to `ghcr.io/nicklongmore86/jellypass:3.4.0` and
     recreate the container. No state-file or setting change is needed.

  You can also skip steps 2 to 5 and accept those effects while rolled back.
  The full procedure is under "Rolling back" in "Cancelling (step 2c)" in
  `docs/app-design.md`. Upgrading again picks up what 3.4.0 left.
- **No CDN purge is needed.** The household app's and the add-on's files are
  still named for a hash of their content, and the pages that name them, the
  admin site and the new manifest are sent `no-store`. The add-on's stylesheet
  keeps its name, so a CDN may still hold a copy without the new
  `Vary: Origin`. That is harmless: the Samsung app loads it with a `<link>`,
  which needs no CORS.
- **Administrators should cancel through the Requests tab, not by deleting a
  request in Seerr.** A cancel in the Requests tab records the hold before
  Seerr forgets the request. When a request is deleted in Seerr's own website,
  JellyPass only finds out at its next read. Seerr says nothing about a
  delete, and sends no webhook for a title that arrives without a request.
- **A residual window remains.** A title hold (a cancelled request then
  deleted in Seerr) is eventual protection, not a guarantee. Until JellyPass
  has found the request gone and applied the hold, the title can be public to
  members whose libraries include it. That lasts about one reconciliation
  interval (`RECONCILE_INTERVAL_SECONDS`, 5 minutes by default) from the later
  of the delete and the arrival, plus the run itself. A `MEDIA_AVAILABLE`
  webhook or library catalog sync shortens it. It lasts longer in three cases:
  - while Seerr or Jellyfin cannot be read;
  - while more than 50 withdrawals or holds wait their turn;
  - with scheduled reconciliation turned off
    (`RECONCILE_INTERVAL_SECONDS=0`), when it has no bound.

  Only HD items found by TMDB ID or Seerr's HD link are held, and a hold lasts
  400 days after the cancel. A cancel in the Requests tab removes the wait for
  the delete to be noticed. Applying the hold is still asynchronous, though:
  until the next webhook, catalog sync or reconciliation applies it, an item
  that arrives can be public.
- **The Samsung app is a separate, sideloaded build.** JellyPass's image does
  not contain it, and upgrading the server installs nothing on a TV.
  `tv/samsung/build-wgt.sh` builds it (`Jellyfin.wgt`), and it replaces the
  stock Jellyfin app on each Samsung TV. Replacing it usually means
  uninstalling the stock app first, which clears its sign-ins. The build and
  the install procedure are in "The Samsung app" in `docs/tv-addon.md`. It has
  not been installed on a real TV yet. After that, a JellyPass release needs
  nothing on the TV.
- **The iPhone, iPad and Android app ships separately.** Its Cancel request
  button and My requests filters are in `mobile/CHANGELOG.md` (Unreleased) and
  arrive with the app's own next release. They need this server for Cancel.
  The current app (1.0.0) works with 3.5.0 as before.

### Added

- **Members can cancel a request they made, before it arrives.**
  `POST /jellypass/app/v1/requests/{id}/cancel` always answers the same
  `202 {"status":"accepted"}`, and the member always sees the same afterwards:
  the entry leaves My requests and the title shows **Get this** again. Only the
  member who asked may cancel, and not once anything of the title is ready for
  them. In the background, the Seerr request is deleted as the member only
  while it is still pending and no other household follows it. Otherwise it is
  kept, and when the title arrives the cancelling household is not given it.
  Households still following it are. With none left, the title is **held for
  no household** (private to everyone but Jellyfin administrators, never
  public) until an administrator gives it to someone. Access already given is
  never taken back, and another household following the request sees nothing
  change. Suppose an administrator then deletes the request in Seerr. Every
  household is back to Get this, but the download may go on without the
  request, so JellyPass keeps a **title hold**. It holds each HD item of the
  title as it appears, unless a "Get this" safety marker says the request
  follows the join rules (see the residual window above). Cancels share the
  "Get this" limits.
- **`GET /jellypass/app/v1/requests` entries gain `cancellable` and
  `requestedOn`** (the day the household last asked, `YYYY-MM-DD`, never a
  time). `apiVersion` in `GET /me` is now `2`.
- **Household web app: Cancel request on My requests.** An entry the server
  lists as `cancellable` has a **Cancel request** button. It asks first, in
  words ("This withdraws your household's request. If it has already been
  approved, the download may still finish, but it won't be added for your
  household."), and then sends the cancel once. On the fixed `202` the page
  always says **Request cancelled**, drops the entry and reads the list again.
  The title shows as **Get this** again on Home, Search and its page while the
  server catches up. Each entry also shows the day it was requested.
  - For keyboard and screen reader users, the controls are real buttons.
    Focus moves into the confirmation and back, and Escape keeps the request.
  - Nothing is shown of what became of the cancel, or of other households.
  - An older server (no `cancellable`) shows no button.

  The call budget gains a `cancel` entry for "requests" in
  `docs/app-api/fetch-budget.json`.
- **My requests in the household web app can be filtered.** Chips above the
  list choose a status (All, Requested, Ready to watch, Couldn't get this), a
  type (All, Films, Series) and an "Asked by me" toggle, and they combine. A
  series matches a status if any status it shows has it: a series with
  Season 1 ready and Season 2 requested appears under both Ready to watch and
  Requested. When nothing matches, the screen says what is missing for that
  combination and offers "Show all requests". Choosing a filter makes no call
  to the app API or TMDB and does not change which titles are reused. It only
  hides entries already on the page, so with more than ten requests the filter
  applies to the ones loaded so far and Load more names the next ten. The
  choice is kept while the app is open and cleared on sign-out or when another
  member signs in.
- **Administrators' Requests tab** (`docs/app-design.md`, "Administrators'
  Requests tab"). A new **Requests** tab in the admin site lists every
  household's "Get this" requests. Each row shows the title, type, seasons,
  status, requester, household, day requested, Seerr's status, how many other
  households follow it, and whether it is held. The page filters by
  household, status, type, and title or requester. Each row offers these
  actions, each after a confirmation:
  - **Approve** and **Decline** a pending request in Seerr. A decline shows
    **We couldn't get this** at once to every household following the
    request, and it is recorded. Should the title still arrive through the
    declined request (a late webhook, its replay or the backfill), none of
    those households is given it, so it is held for no household. This holds
    even after the declined request is deleted in Seerr (the decline then
    becomes a title hold). It also holds for a request made by a Seerr user no
    Jellyfin user is linked to.
  - **Cancel request** for every household: each goes back to **Get this**,
    and the request is deleted in Seerr. JellyPass records the cancel (so the
    title is held for no household if it still arrives) **before** Seerr
    forgets the request. A title that arrived in Jellyfin before the cancel
    but was not granted yet is held too. Only a request that follows the join
    rules (a title Jellyfin already had) leaves a public title public. This
    holds whoever made the request, including a Seerr user no Jellyfin user is
    linked to.
  - **Also remove from Radarr**, offered only for a movie Jellyfin does not
    have, and only when Seerr has an HD Radarr server. It goes through Seerr,
    with the credentials Seerr holds; JellyPass holds no Radarr credential. It
    is never offered for a series, because Seerr would remove the whole series
    from Sonarr, files included.

  A **Held titles** section lists titles that arrived with nobody left
  following them (after a cancel or a decline), and **Release** gives one to
  chosen households. Of two releases of the same title at once, only the first
  takes effect. The other is refused (`409 title_not_held`) unless it asked
  for the same households.
- **Administrator API for those actions.** They are served on the admin host
  only, with the admin token or a session, and with the same origin and JSON
  checks as every other admin change:
  - `GET /v1/app/requests`;
  - `POST /v1/app/requests/{requestId}/approve`, `/decline` and `/cancel`
    (the last with an optional `{"removeFromRadarr": true}`);
  - `POST /v1/app/held/{requestId}/release` with `{"householdIds": [...]}`;
  - `GET /v1/app/held`, which lists held titles read-only.

  Every action is idempotent: once it has taken effect, repeating it answers
  `changed: false`. Actions are logged by request ID with no names, and
  limited to 60 a minute (`429 too_many_requests`). A refusal is `409` with a
  `code`, and a Seerr failure is `502`. Without the household app, all but
  `GET /v1/app/held` answer `404 requests_not_configured`.
- **`GET /v1/app/outstanding` counts the withdrawals that still decide a
  grant.** `withdrawals` reports `waiting`, `titleHolds`, `granted` and
  `held`, and `clear` waits for them. New gauges: `jfa_app_withdrawals{kind}`
  and `jfa_app_held_titles`.
- **TV add-on: a Discover row on Jellyfin web's Search page.** This is for
  households the TV add-on (experimental, off by default) is on for. Searching
  in Jellyfin web now also shows a **Discover** row under Jellyfin's own
  results, built from the household app's search:
  - It shows only titles that can be had ("Available to get"), in the same
    cards as the Home row: never what is already in the library, Requested
    titles or titles that are not available.
  - It asks once the words have been still for 600 ms, never while the search
    field is empty, and at least a second apart. It cancels a call the words
    have outgrown and waits out a `429`.
  - Choosing a card opens the title page. Back returns to the Search page with
    the query and the card focused.

  No setting, state file, app API or gateway change. Nothing changes on a host
  the add-on is not on for. See [docs/tv-addon.md](docs/tv-addon.md) ("The
  Search row").
- **TV add-on: the Samsung app** (`docs/tv-addon.md`, "The Samsung app"). It is
  still experimental and off by default. The household host gains the
  following, but only on a household the add-on is on for:
  - `GET`/`HEAD /jellypass/tv/manifest.json` answers
    `{"script":"jellypass-tv.<hash>.js"}`, the add-on's current script. It is
    sent `no-store`, with no token needed, for the loader below.
  - Cross-origin access for the JellyPass build of Jellyfin's Samsung app. It
    is allowed only from the app's own origin: `Origin: file://` or
    `Origin: null`, what a packaged Tizen app's page sends. It covers:
    - the app API (`/jellypass/app/v1/*`, `GET` and `POST` with
      `Authorization` and `Content-Type`);
    - the add-on's files and manifest (`/jellypass/tv/*`, `GET` and `HEAD`).

    A preflight from that origin is answered `204` before any token is
    checked. Its other answers carry `Access-Control-Allow-Origin` with that
    origin, and credentials are never allowed. Every answer on those paths
    there now carries `Vary: Origin`, whatever its `Origin`, the add-on's
    long-cached files included. Apart from that header, every other origin
    answers exactly as before. Every other household, the household app's own
    pages and the administrator host also answer exactly as before.
  - `tv/samsung/` holds a script that builds that app (see the upgrade note
    above). The app is `Jellyfin.wgt`, with the same app id as Jellyfin's,
    `AprZAARz4r.Jellyfin`, so it replaces it. It is built from Jellyfin web
    12.3 and jellyfin-tizen at pinned commits, and signed in the pinned
    `ghcr.io/georift/install-jellyfin-tizen` image. It adds a loader that
    loads the add-on from the household host the app is signed in to. If the
    script fails to load, the loader removes the tag and asks for the manifest
    again later, less and less often.

### Changed

- **A request an administrator deletes in Seerr now sends every household
  following it back to Get this.** The requester's entry already left My
  requests. A household that followed the same request showed "We couldn't
  get this" instead; now its entry leaves the list too, and the title can be
  asked for again. The app API's fields and statuses are unchanged: an entry
  leaving the list is something every client already handles (it is what the
  requester's entry did), so this is not a breaking change.
- The native-client contract (`docs/app-design.md`): "CORS stays off" now has
  one exception, the Samsung app's origin on a household host the TV add-on is
  on for (above).

## [3.4.0] - 2026-10-27

This is a minor release. It redesigns the TV add-on, which is still
experimental and off by default: **unless `TV_ADDON_ENABLED` is set, nothing
changes** on any host. No setting is added, removed or renamed, and the state
file is unchanged (schema v7, with the same fields as 3.3.1), so 3.3.1 reads a
state file written by 3.4.0. The app API (`docs/app-api/v1.openapi.json`),
webhook payloads, the administrator API, the admin UI, the household app and
the gateway are unchanged. The add-on's row and title view are not part of the
public interface described at the top of this file, so redesigning them is not
a breaking change; it is a minor release because the add-on gains new
behaviour (a page host and a new title page). Read these before upgrading a
household the add-on is on for:

- **What changes for households the add-on is on for:**
  - The Home row is now headed **Discover** and shows only titles that can be
    had ("Available to get"): titles already in the member's library,
    Requested titles and titles that can't be requested are left out, and the
    cards look like Jellyfin web's own.
  - Choosing a card opens the title as a page of Jellyfin web's own, at
    `#/jellypass/title/<movie|tv>/<id>`, under Jellyfin's header, instead of
    an overlay on Home. **Back is Jellyfin's** (its header button, the remote's
    Back key, or the browser's history) and returns to Home with the card
    focused; the add-on handles no key.
- **It has been tested in a real Jellyfin 12.3 container,** in the TV layout
  and the desktop layout, in a desktop browser, but **not on a real TV**, and
  the page host has been checked only against Jellyfin web 12.3. Where
  Jellyfin web's page is not as the add-on expects, the title page is not
  drawn and Jellyfin's own page shows. Check the row, the title page and Back
  in a desktop browser on that household's address, then on an LG TV, before
  relying on it; [docs/tv-addon.md](docs/tv-addon.md) lists what to check.
- **Samsung TVs still show nothing:** the sideloaded Samsung app bundles its
  own Jellyfin web and needs the JellyPass loader app planned for a later
  step.
- **No CDN purge is needed:** the household address's `/web/` page that
  carries the add-on's tag is already sent `no-store` (since 3.3.0), and the
  add-on's script and stylesheet are named for a hash of their content, so the
  page names the new files at once.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.3.1` and recreate the container. No
  state-file or setting change is needed; the 3.3.1 row and overlay come back.

### Added

- **The TV add-on can now show JellyPass pages inside Jellyfin web, at
  `#/jellypass/...`.** A page is drawn into Jellyfin's own "page not found"
  page, so Jellyfin's real header, its Back and Home buttons, its history and
  its focus handling apply, in the TV layout and the desktop layout, and the
  add-on handles no key. Jellyfin's "page not found" text is hidden before it
  is drawn, so it never flashes. If Jellyfin web's page is not what the add-on
  expects, nothing is drawn and Jellyfin's page is left alone. Besides the
  title page (below), the only page is a small placeholder at
  `#/jellypass/about`, which nothing links to and which makes no call. Nothing
  changes on the admin host or on households the add-on is off for.

### Changed

- **The TV add-on's title view is now a page of Jellyfin web's, not an
  overlay.** Choosing a Discover card opens `#/jellypass/title/<movie|tv>/<id>`
  as a history entry, laid out as Jellyfin's own item details page (poster,
  name, year, runtime and rating, buttons in Jellyfin's style, overview,
  genres, and the seasons of a series), under Jellyfin's real header, so its
  Back and Home buttons are never covered, in the TV layout and the desktop
  layout. Back returns to Home with the card focused. The title's backdrop is
  now drawn across the whole screen whatever Jellyfin's Backdrops setting says.
  An address whose ID is not one the app API takes (digits with no leading
  zero, at most 2147483647) shows "Not found" and makes no call. The overlay,
  its key listener and its stacking rules are gone: the add-on handles no key,
  and every listener it adds to the document only watches (capturing and
  passive). Play, Get this (same confirmation, words and errors, no automatic
  retry, season choice with Select all, HD only), the two-minute Requested
  state, sign-out and member changes, and the call budget (`tv-movie`,
  `tv-series`) are unchanged. Nothing changes on the admin host or on
  households the add-on is off for.
- **The TV add-on's Home row is now "Discover", in Jellyfin web's own card
  style, and shows only what can be had.** It no longer repeats what Jellyfin's
  own rows show: titles already in the member's library ("Ready to watch") are
  left out, and so are "Requested" titles (they will be in My requests) and
  titles that can't be requested, so the row has no badge. A title the member
  asks for leaves the row. The cards use Jellyfin web's card markup, so their
  size, type, near-black look and focus ring match Jellyfin's own rows in both
  the TV and the desktop layout, and the add-on's own navy colours are gone
  from the row. If nothing is left the row is not drawn. When the row is drawn
  again while one of its cards has focus, focus stays on the same title. The
  row still makes one call (`tv-home-row`, unchanged) and depends only on the
  caller's own answer.

## [3.3.1] - 2026-10-27

This is a security patch release for household hostnames, with the household
app on or off. It closes two gaps that were present before 3.3.0: one
household could list another household's members, and a Jellyfin token from
one household's hostname, or from the main Jellyfin site, worked on any other
household's hostname. The main Jellyfin site and the admin host are
unaffected. There is nothing to configure: no setting is added, removed or
renamed, and the state file is unchanged (schema v7, with the same fields as
3.3.0), so 3.3.0 reads a state file written by 3.3.1. The app API
(`docs/app-api/v1.openapi.json`), webhook payloads, the administrator API, the
admin UI, the household app and the TV add-on are unchanged. Read these before
upgrading:

- **No CDN purge is needed:** none of the household app's or the TV add-on's
  source files and nothing Jellyfin's own web client loads changed (only the
  embedded version number differs in the built app), and the new
  refusals and narrowed listings are answered `Cache-Control: no-store`.
- **Clients may notice these changes, on household hostnames only:**
  - A token from one household's hostname, or from the main Jellyfin site, no
    longer works on another household's hostname: requests relayed to
    Jellyfin with it get `401 {"error":"unauthorized"}` (routes that name an
    item or user keep their `404`; the sign-in screen's own calls are
    unaffected), so a client that kept such a token must sign in again on that
    hostname. Members using their own household's
    hostname, and anyone using the main Jellyfin site, are not affected.
  - A sign-out (`POST /Sessions/Logout`) with no token, or with a token that is
    not one of the household's members', gets `401 {"error":"unauthorized"}`
    and revokes nothing.
  - A sign-out while Jellyfin cannot say whose the token is (Jellyfin down,
    unless that token was checked in the past minute) gets
    `502 {"error":"jellyfin_unavailable"}` and is not sent to Jellyfin.
  - User lists (`GET /Users`), session lists (`GET /Sessions`) and SyncPlay
    group lists show only the household's own members, and joining another
    household's SyncPlay group gets `404 {"error":"item_not_found"}`.
- **Two gaps remain, by design:**
  - SyncPlay's WebSocket messages are not filtered. A member who joined a
    household group still learns the names of anyone who joins it later
    through the main Jellyfin site, or in the moment between the check and the
    join; another household's members cannot join it through their own
    household hostnames.
  - Whose a token is, is remembered for up to a minute. A token signed out
    elsewhere (on the main Jellyfin site, say, or by an administrator) may
    still be passed to Jellyfin for that minute, which then refuses it itself;
    a sign-out through the household hostname forgets it at once, and
    membership is checked on every request.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.3.0` and recreate the container. No
  state-file or setting change is needed, but rolling back reopens both gaps:
  household hostnames list every Jellyfin user again and accept any
  household's tokens.

### Security

- **Household hostnames no longer show one household another's members.**
  Jellyfin lists every user, with their name and settings, to any signed-in
  user at `GET /Users`; every SyncPlay group with its participants' names to
  anyone at `GET /SyncPlay/List` and `GET /SyncPlay/{id}`; and, to a user
  allowed to control other users' sessions, those sessions with their users'
  names at `GET /Sessions`. On a household hostname these were relayed
  unchanged. They are now narrowed to the household's own members, as
  `GET /Users/Public` already was, keeping Jellyfin's order and schema:
  `GET /Users` lists only members (whatever its `isHidden` and `isDisabled`
  filters), `GET /Sessions` only sessions all of whose users are members, and
  `GET /SyncPlay/List` only groups all of whose participants are members; a
  group that is not gets the fixed `404 {"error":"item_not_found"}` at
  `GET /SyncPlay/{id}`. A `userId` or `controllableByUserId` in their query
  must still be the caller's own. They are matched as Jellyfin routes them,
  like every household check. Allowed in a patch release by the
  household-check rule at the top of this file: "Requests on a household
  hostname that would get around a household check [...] may likewise be
  refused in a minor or patch release, even where Jellyfin used to answer them
  with a success."
- **A household hostname now works only with its own members' tokens.** A
  Jellyfin token issued on one household's hostname, or on the main Jellyfin
  site, was accepted on every other household's hostname. Now every request
  relayed to Jellyfin that carries a token (in an `Authorization`,
  `X-Emby-Authorization`, `X-Emby-Token` or `X-MediaBrowser-Token` header, or
  an `api_key`, `ApiKey` or `access_token` query parameter, in any case) is
  relayed only if Jellyfin's `GET /Users/Me` says the token is a member's of
  that household. Any other token, valid at Jellyfin or not, gets the same
  fixed, non-cacheable `401 {"error":"unauthorized"}` and never reaches
  Jellyfin; a WebSocket upgrade with one gets `401`. Routes that name an item
  or a user keep their fixed `404 {"error":"item_not_found"}`, now also for a
  token that is not a member's. Who a token belongs to is remembered for a
  minute (a sign-out through the household hostname forgets it at once);
  membership is checked on every request, so taking a member out of a
  household takes effect at once. A request with no token is relayed as
  before, and the sign-in screen's calls (`GET /Users/Public`,
  `GET /Branding/Configuration`, `POST /Users/AuthenticateByName`) are
  answered whatever token they carry. The household app, the TV add-on,
  "Add to my library" and sign-out keep their own checks. The main Jellyfin
  site and the admin host are unaffected. Allowed in a patch release by the
  same household-check rule.
- **Signing out through a household hostname now takes a member's token.**
  `POST /Sessions/Logout` was relayed whoever's token it carried, so another
  household's member, or anyone with a token from the main Jellyfin site,
  could revoke it through a household hostname (`204`), and tell it from a
  token Jellyfin never issued (`401`). Now a sign-out is relayed only if
  Jellyfin's `GET /Users/Me` says its token is a member's of that household;
  any other, and a sign-out with no token, gets the same
  `401 {"error":"unauthorized"}`, never reaches Jellyfin and revokes nothing.
  A member's own sign-out forgets and revokes the token as before. If
  Jellyfin cannot say whose the token is, the sign-out is not sent and gets
  `502 {"error":"jellyfin_unavailable"}`; before, it was sent anyway and
  Jellyfin's own answer relayed. Allowed in a patch release by the same
  household-check rule.
- **Household user listings fail closed on any answer but Jellyfin's `200`.**
  `GET /Users`, `GET /Sessions`, `GET /SyncPlay/List`, `GET /SyncPlay/{id}`
  and `GET /Users/Public` relayed any other answer from Jellyfin unchanged,
  body included, so a `201` (say) listing another household's member reached
  the caller. Now any other `2xx` or `3xx` gets `502` with a fixed error, a
  `401` and a `404` their household host's fixed answers, any other `4xx` its
  status with `{"error":"jellyfin_refused"}`, and a `5xx`
  `502 {"error":"jellyfin_unavailable"}`. `GET /SyncPlay/{id}` for a group
  Jellyfin does not have now gets the same fixed
  `404 {"error":"item_not_found"}` as another household's group. Allowed in a
  patch release by the same household-check rule.
- **A household hostname joins a SyncPlay group only if it is the
  household's own.** Jellyfin lets anyone join any SyncPlay group by its ID
  (`POST /SyncPlay/Join`), then sends them its participants' names over the
  WebSocket. On a household hostname a join is now relayed only for a group
  all of whose participants, as Jellyfin's `GET /SyncPlay/{id}` describes
  them, are the household's members; any other group, and one Jellyfin does
  not have, gets the fixed `404 {"error":"item_not_found"}` and is never
  joined. A body that is not `{"GroupId": "<GUID>"}` gets
  `400 {"error":"invalid_request"}`. WebSocket messages are not filtered.
  Allowed in a patch release by the same household-check rule.

## [3.3.0] - 2026-10-27

This is a minor release. It adds the TV add-on, a JellyPass row and title view
inside Jellyfin web on household hostnames, with two new optional settings,
`TV_ADDON_ENABLED` and `TV_ADDON_HOUSEHOLDS`. **It is off by default: unless
`TV_ADDON_ENABLED` is set, nothing changes** on any host. No setting is removed
or renamed, and the state file is unchanged (schema v7, with the same fields as
3.2.4), so 3.2.4 reads a state file written by 3.3.0. The app API
(`docs/app-api/v1.openapi.json`), webhook payloads, the administrator API, the
admin UI and the household app are unchanged. Read these before switching the
add-on on:

- **To switch it on for some households,** set `TV_ADDON_ENABLED=true` and
  `TV_ADDON_HOUSEHOLDS` to their household (group) IDs separated by commas
  (`*` means every household), then recreate the container. Start with one
  household. The list is required when the add-on is on, and startup stops on
  an empty or invalid list.
- **It needs the household app:** `HOUSEHOLD_APP_ENABLED=true`, because the
  add-on reads the app API. Startup stops if the add-on is on without it.
- **It has been tested only against Jellyfin web 10.11 and in simulated
  browsers,** never on a real TV or on Jellyfin web 12.x. Before rolling it out
  more widely, check it in a desktop browser on that household's address
  (Jellyfin web in TV layout: the row, the title view, the arrow keys and Back),
  then on an LG TV; [docs/tv-addon.md](docs/tv-addon.md) lists what to check.
- **You may need to purge Cloudflare's cache once** for that household's
  `/web/` page. From now on the page is sent `no-store`, but that can't remove
  a copy cached before. Check that the household address's `/web/` page comes
  back with the `data-jellypass-tv` tag and `no-store`, or purge it, before
  testing on a TV.
- **Samsung TVs show nothing yet:** the sideloaded Samsung app bundles its own
  Jellyfin web, and needs the JellyPass loader app planned for a later step.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.2.4` and recreate the container. No
  state-file change is needed. 3.2.4 ignores `TV_ADDON_ENABLED` and
  `TV_ADDON_HOUSEHOLDS`, so the add-on goes away with it.

### Added

- **TV add-on, step 1 (off by default).** With `TV_ADDON_ENABLED=true` and
  the households listed in `TV_ADDON_HOUSEHOLDS` (household IDs separated by
  commas, or `*` for all; required when the add-on is on, and it needs
  `HOUSEHOLD_APP_ENABLED=true`), those households' hostnames add one
  `<script>` to Jellyfin web's page (`/web/`, `/web/index.html`). It adds a
  **JellyPass: Trending** row to Jellyfin web's Home, after its first section,
  showing the household's own view of Trending from the app API with the
  app's coarse statuses. The row is drawn for remote-control navigation by
  Jellyfin web's own focus manager on LG TVs (the LG app loads Jellyfin web
  from the server) and in browsers. Choosing a card opens a title view (step 2,
  below). The script and its stylesheet are served fingerprinted at
  `/jellypass/tv/` and built for Chromium 63 (ES2017). The page is sent
  `no-store` without Jellyfin's validators, and asked of Jellyfin whole and
  unencoded. Anything other than a whole HTML page is relayed unchanged. The
  row makes one app API call (`GET /discover/trending`) when Home is laid out,
  and at most one a minute after that; `docs/app-api/fetch-budget.json` lists
  it as `tv-home-row`. With the add-on off, on any household not listed, and
  on the admin host, nothing changes: `/jellypass/tv` is still relayed to
  Jellyfin there. Nothing has been checked on a real TV yet. See
  [docs/tv-addon.md](docs/tv-addon.md) for the design, the later steps
  (Search, My requests and the Samsung app), and what to check on a TV.
- **TV add-on, step 2: title pages and "Get this" (off by default, with the
  add-on).** Choosing a card in the JellyPass row opens a JellyPass title view
  over Jellyfin web's Home, laid out for the TV and navigated by Jellyfin web's
  own focus manager. It shows the title's household status in the app's
  coarse words and one action: **Play**, which opens Jellyfin web's own
  details page for the title on the same host (Jellyfin's own player), or
  **Get this**, with a season picker for a series. "Get this" behaves exactly
  as in the app: one fixed confirmation whatever happened, fixed words for
  each failure, never retried by itself, and the title shown as Requested on
  the view and the row for up to two minutes while the server records it (in
  memory only, forgotten when another member signs in, on sign-out or when
  either read is refused); it ends on a screen left alone too, with no call. The
  remote's Back closes the view and puts focus back on the card. The view
  makes two app API calls when opened (`tv-movie` and `tv-series` in
  `docs/app-api/fetch-budget.json`) and an accepted "Get this" three. Nothing
  has been checked on a real TV yet; see
  [docs/tv-addon.md](docs/tv-addon.md) for what to check.

## [3.2.4] - 2026-10-27

This is a security patch release for household hostnames, with the household
app on or off. It matters only if the
[Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin is
installed in Jellyfin; without it, nothing changes. It applies to Jellyfin
Enhanced 12.13 and 12.14, whose routes are the same. There is nothing to
configure: no setting is added, removed or renamed, and the state file is
unchanged (schema v7, with the same fields as 3.2.3), so 3.2.3 reads a state
file written by 3.2.4. The app API (`docs/app-api/v1.openapi.json`), webhook
payloads, the administrator API, the admin UI and the household app are
unchanged. Read these before upgrading:

- **No CDN purge is needed:** none of the household app's files and nothing
  Jellyfin's own web client loads changed, and the refused routes are answered
  `Cache-Control: no-store`.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.2.3` and recreate the container. No
  state-file or setting change is needed, but rolling back relays the routes
  below to Jellyfin again on household hostnames.
- **If you use Jellyfin Enhanced,** also turn off its Jellyseerr integration
  unless you need it, keep its option to show every user's active streams
  (`ActiveStreamsAllUsers`) off, and keep its option to show users other than
  administrators only their own activity (`ActivityFeedOwnOnlyForNonAdmins`)
  on. JellyPass cannot check those for you, and they also apply on the main
  Jellyfin site, which JellyPass does not filter.

### Security

- **Household hostnames no longer relay the Jellyfin Enhanced plugin's Seerr
  routes.** With the plugin's Seerr feature on, any signed-in household member
  could see Seerr's answers with other households' requests in them, the
  request list with other requesters' names, and what Sonarr and Radarr fetched
  for them, and could request titles in Seerr directly, past the household
  app's own checks on what may be requested. `/JellyfinEnhanced/jellyseerr`,
  `/JellyfinEnhanced/arr` and `/JellyfinEnhanced/proxy`, every path below each,
  and the plugin's Seerr search and genre lists
  (`/JellyfinEnhanced/tmdb/search/person`, `/tmdb/search/keyword`,
  `/tmdb/genres/movie` and `/tmdb/genres/tv`) are now a fixed
  `404 {"error":"not_found"}` with `Cache-Control: no-store`, the same for
  anyone, and never reach Jellyfin; a WebSocket upgrade to them is answered
  `404`. They are matched as Jellyfin routes them, like the Streamyfin plugin's
  routes. The plugin's Seerr panels stop working on household hostnames; its
  other features, its scripts and settings included, are unaffected. The main
  Jellyfin site and the admin host are unaffected. Allowed in a patch release
  by the household-check rule at the top of this file: these routes get around
  the household app's checks on what members see and request.
- **Household hostnames no longer relay the Jellyfin Enhanced plugin's reviews
  or its lookup of library items by provider ID.** Its reviews showed any
  signed-in household member other users' reviews and names, for titles the
  member may not be able to see, and took reviews from them; its lookup by
  provider ID searched the whole library, so a member could find out whether a
  title they may not see is on the server, and its ID.
  `/JellyfinEnhanced/reviews` and every path below it, and
  `/JellyfinEnhanced/items/by-providers`, now get the same fixed
  `404 {"error":"not_found"}` with `Cache-Control: no-store` as the plugin's
  Seerr routes, for anyone, matched the same way, and never reach Jellyfin; a
  WebSocket upgrade to them is answered `404`. The plugin's reviews and the
  features that look items up by provider ID stop working on household
  hostnames; its other features are unaffected. The main Jellyfin site and the
  admin host are unaffected. Allowed in a patch release by the household-check
  rule at the top of this file: these routes get around the household app's
  checks on which items a member may see.

## [3.2.3] - 2026-10-27

This is a patch release for the household app (`HOUSEHOLD_APP_ENABLED=true`)
only: with the app off (the default), nothing changes. There is nothing to
configure: no setting is added, removed or renamed, and the state file is
unchanged (schema v7, with the same fields as 3.2.2), so 3.2.2 reads a state
file written by 3.2.3. The app API (`docs/app-api/v1.openapi.json`), webhook
payloads, the administrator API and the admin UI are unchanged; on the server,
only how JellyPass saves a "Get this" request changed (see Fixed). Read these
before upgrading:

- **Close and reopen the installed app** to pick up the change. An open app
  keeps running the files it loaded until then.
- **No CDN purge is needed:** the app's files, the stylesheet and the
  scripts included, are still named by content hash (those fingerprinted files
  are sent `public, max-age=31536000, immutable`), and the page, the service
  worker and every other `/jellypass/app` answer are sent `no-store`, so the
  changed files have new addresses.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.2.2` and recreate the container. No
  state-file or setting change is needed.

The app API's fetch budget (`docs/app-api/fetch-budget.json`) now also lists
the calls on coming back to **My requests** (`revisit`) and on a network's or
a studio's page. It is documentation: the API is unchanged.

**Mobile app (not in the server image).** The household app for iPhone, iPad
and Android (`mobile/`) reached its first release, 1.0.0, since 3.2.2. It has
its own version and its own [changelog](mobile/CHANGELOG.md); nothing in it
runs on the server.

### Changed

- **Household app: one status pill per request on My requests.** A series
  request no longer shows the same status twice (once under the title and
  again on its season's row). A request for one season shows a single pill and
  says the season on the line under the title (`2027 · Series · Season 1`).
  When several seasons share one status, the request shows one pill and lists
  them there as text (`Seasons 1–3`, `Seasons 1, 3`); when their statuses
  differ, each season keeps its own pill and the request shows none. Movies are
  unchanged. "Ask your JellyPass admin to try again." now also shows on My
  requests, under whatever did not work out (under the season, when seasons
  differ). Only the app changed for this.
- **Household app: My requests reuses the titles it has already read.** The
  list is still read on every visit, so statuses are always current, but a
  title's name, year and poster read in the last ten minutes of the same
  sign-in are reused instead of asked for again: coming back to My requests
  now makes one call (`GET /requests`) plus one per request not seen before,
  where it used to make one per request shown (11 calls for ten requests, 51
  for fifty). Load more still names only the requests it adds. The titles are
  kept in memory only (at most 300), never their status, and are forgotten on
  sign-out, a refused sign-in, or another member, household or sign-in. The
  app API's fetch budget (`docs/app-api/fetch-budget.json`) lists the calls on
  coming back as `revisit`. Only the app changed for this.

### Fixed

- **Household app: a "Get this" request is no longer dropped when it coincides
  with JellyPass's own check of earlier requests.** If that check (at startup or
  every few minutes) ran while a new request was still being saved, it could
  mistake the new request for one left over from before and clear it. The
  request was then never sent, or, if Seerr's answer to it was lost (a timeout,
  for example), it could be sent without showing as Requested for the household.
  A request is now marked as in progress before it is saved, and the check
  leaves it alone.

## [3.2.2] - 2026-10-27

This is a patch release for the household app (`HOUSEHOLD_APP_ENABLED=true`)
only: with the app off (the default), nothing changes. There is nothing to
configure: no setting is added, removed or renamed, and the state file is
unchanged (schema v7, with the same fields as 3.2.1), so 3.2.1 reads a state
file written by 3.2.2. No server behaviour changed (only the version string
JellyPass reports to Jellyfin): the app API, the household gateway, webhook
payloads, the administrator API and the admin UI are unchanged. Read these
before upgrading:

- **Close and reopen the installed app** to pick up the change. An open app
  keeps running the files it loaded until then.
- **No CDN purge is needed:** the app's files, the stylesheet included, are
  still named by content hash (those fingerprinted files are sent
  `public, max-age=31536000, immutable`), and the page, the service worker and
  every other `/jellypass/app` answer are sent `no-store`, so the changed files
  have new addresses.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.2.1` and recreate the container. No
  state-file or setting change is needed.

The app API's fetch budget (`docs/app-api/fetch-budget.json`) now also lists
the calls the app makes on **Search** and **My requests**. That documents what
the app already did; neither the app's calls nor the server changed.

The mobile app's source (`mobile/`) also changed since 3.2.1. It is not part
of this release: it is not in the image and nothing in it runs on the server.

### Changed

- **Household app: card rows settle with a card centred.** Backdrop rows,
  poster rows (including a service's "Popular on" rows) and the Studios strip
  now snap to the centre of a card instead of loosely to a card's start. A fast
  flick can still pass several cards; the first card sits at the row's start
  and the last at its end. Rows now snap with reduced motion on too, without
  added CSS animation. The Home hero keeps paging one slide at a time.

### Fixed

- **Household app: a card reached with Tab is no longer clipped by its row.**
  The focused card is centred in its row, where the row's snap leaves it, or,
  if it is wider than the row, lined up with the row's start. Studios logo
  tiles now get the same treatment, and a backdrop card is never wider than
  the row it sits in.

## [3.2.1] - 2026-10-26

This is a patch release for the household app (`HOUSEHOLD_APP_ENABLED=true`)
only: with the app off (the default), nothing changes. There is nothing to
configure: no setting is added, removed or renamed, and the state file is
unchanged (schema v7, with the same fields as 3.2.0), so 3.2.0 reads a state
file written by 3.2.1. No server behaviour changed (only the version string
JellyPass reports to Jellyfin): the app API, the household gateway, webhook
payloads, the administrator API and the admin UI are unchanged. Read these
before upgrading:

- **Close and reopen the installed app** to pick up the fix. An open app keeps
  running the files it loaded until then.
- **No CDN purge is needed:** the app's files are still named by content hash
  (those fingerprinted files are sent `public, max-age=31536000, immutable`),
  and the page, the service worker and every other `/jellypass/app` answer are
  sent `no-store`, so the changed files have new addresses.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.2.0` and recreate the container. No
  state-file or setting change is needed.

The mobile app's source (`mobile/`) also changed since 3.2.0. It is not part
of this release: it is not in the image and nothing in it runs on the server.

### Fixed

- The household app now shows **Requested** right after **Get this** is
  accepted, on the title and season pages and on every card elsewhere (Home,
  Search, service and studio pages). The server records a request a couple of
  seconds after it answers, so the page it reads straight afterwards could
  still say "Available to get". The app now remembers, in memory only, the
  titles and seasons its member just asked for: for two minutes at most (by
  the monotonic clock or, if the device slept, the wall clock moving forward;
  a clock set back never extends it), dropped as soon as the server says
  anything else, never stored or sent. It belongs to the member who is signed
  in: any sign-out, sign-in, change of credentials or refused (401) answer
  clears it, so another member on the same device never inherits it. The app
  makes no extra calls, and the server is unchanged.

## [3.2.0] - 2026-10-26

This is a security release for household hostnames, and a minor release.
**Upgrading is strongly recommended** for every installation that serves
household hostnames. There is nothing to configure: no setting is added,
removed or renamed, and the state file is unchanged (schema v7, with the same
fields as 3.1.1), so 3.1.1 reads a state file written by 3.2.0. The main
Jellyfin site, the admin host, the administrator API, the admin UI and the
Seerr webhook are unchanged.

**What 3.1.1 and earlier exposed on household hostnames.** Jellyfin answers
some requests without checking who may see what, and the household gateway
did not catch all of them:

- **Anyone who could reach a household hostname** could list every Jellyfin
  user, reach password recovery and load any Jellyfin user's profile picture,
  and **anyone with a Jellyfin account**, not only the household's members,
  could sign in there: the membership check could be got around by spelling a
  path differently, by Jellyfin's old sign-in by user ID, or by Quick Connect
  on a Jellyfin that has it enabled.
- **A signed-in household member** could play, download, or read the
  subtitles and other files of titles hidden from them (by HLS streaming,
  among other routes), see another Jellyfin user's private playlists and
  profile, and add another user to a playback session.
- **With the Streamyfin plugin installed,** any signed-in user could read its
  settings, Seerr's API key among them.

3.2.0 closes all of these; the Security section below lists each change.
None of them needs a setting or a change to Jellyfin. One gap that needs Live
TV set up in Jellyfin remains; see the known follow-ups below.

The repository now also holds the source of a mobile app (`mobile/`). It is
not part of this release: it is not in the image and nothing in it runs on
the server.

**Why this is a minor release.** The rule at the top of this file allows a
minor or patch release to refuse, on a household hostname, requests that
would get around a household check, even where Jellyfin used to answer them
with a success, and to change failure responses on relayed Jellyfin endpoints
to close a leak. Every refusal below is one or the other, and each is cited
against that rule. The release also adds a field to the household app API
(`apiVersion` in `GET /jellypass/app/v1/me`), a backward-compatible addition
to the public interface, so it is a minor release rather than a patch one.
Nothing that is part of the public interface is removed or changed in an
incompatible way, so it is not a major one.

Read these before upgrading. In the setup this project documents (Quick
Connect disabled in Jellyfin, as `docs/household-access.md` requires, and no
Streamyfin plugin installed), a member using a supported client notices at
most two of them: the subtitle fonts and the extra round trip.

- **Fonts embedded in subtitles no longer load on household hostnames.**
  jellyfin-web loads the fonts embedded in a video's ASS/SSA subtitles without
  credentials, and the per-item check needs them, so on household hostnames it
  draws those subtitles with its fallback fonts. The subtitles themselves
  still show. Refusing an item's routes to a caller who cannot be checked is
  allowed in a minor release by the household-check rule at the top of this
  file.
- **Quick Connect stops working on household hostnames.** On a Jellyfin that
  has it enabled, it still works on Jellyfin's own address. Quick Connect
  signs in without the membership check, so refusing it is allowed by the
  household-check rule. The Streamyfin plugin's routes also stop answering on
  household hostnames. On a Jellyfin without the plugin they were already
  failures, so that changes failure responses only; with it, they handed any
  signed-in user Seerr's API key, and with it a way around the household
  app's own checks on what is requested, so refusing them is allowed by the
  household-check rule.
- **Playlist sharing is not refused.** Sharing by path
  (`GET`/`POST`/`DELETE /Playlists/{id}/Users/{userId}`) is relayed to
  Jellyfin unchanged, and Jellyfin checks the caller may see or edit the
  playlist; only a `userId` query parameter there naming someone else is
  refused (see the Security section). Jellyfin 10.11.3's own bugs still show
  on those routes: a first share by path fails with `500`, and removing a
  share by path answers `204` but keeps it. Sharing through the playlist body,
  as jellyfin-web does, works.
- **Oddly encoded paths get `400`.** A path Jellyfin might read otherwise than
  the gateway (an encoded slash, a `.` or `..` segment, invalid
  percent-encoding and the like; the Security section has the full list) gets
  `400 {"error":"invalid_request"}` and never reaches Jellyfin. Browsers and
  Jellyfin clients do not send these; they are the spellings a household
  check could be skipped by, so refusing them is allowed by the
  household-check rule.
- **Some household requests take one more round trip to Jellyfin.** Every
  request on a household hostname that names an item or a user (most of what
  a Jellyfin client asks for while browsing and playing, HLS segments
  included) is checked with Jellyfin's `GET /Users/Me`, plus one lookup per
  item it names, before it is sent on. Those answers are not cached yet, so
  each such request waits for them. This changes no answer, only how long one
  takes, so no part of the public interface the versioning rule covers.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.1.1` and recreate the container. No
  state-file or setting change is needed, but rolling back re-opens every
  issue listed above.

Known follow-ups, for a later release:

- **Live TV:** the household gateway does not yet check a user ID sent in the
  body of Jellyfin's `POST /LiveTv/Programs`. Live TV is not part of the
  setup this project documents; do not enable Live TV in a Jellyfin that
  household hostnames reach until a release refuses it.
- **A short identity cache:** remembering, briefly, who a set of credentials
  belongs to would remove most of the extra round trips above.

### Security

- **Household checks now apply to every spelling of a path.** Jellyfin routes
  one endpoint by several spellings: with its legacy `/emby` or `/mediabrowser`
  prefix, with a trailing slash, or with percent-encoded letters. The household
  gateway matched most of its checks on the plain spelling only, so a
  non-member could sign in on a household hostname, list every Jellyfin user,
  reach password recovery, or stream an item they may not see by spelling the
  path another way. A sign-out spelled that way also left the household app
  trusting the session until its cache expired. Every check (sign-in
  membership, the household's `/Users/Public` list and login styles, password
  recovery, sign-out, protected media, Quick Connect, Streamyfin and
  JellyPass's own `/jellypass/...` paths) now matches the route Jellyfin takes
  the path to: decoded once, in any case, with trailing or repeated slashes
  ignored, and without the legacy prefix. A path Jellyfin might read otherwise
  than the gateway (an encoded slash, a dot segment, invalid
  percent-encoding, a control or non-ASCII character, a backslash, a repeated
  legacy prefix, or percent-encoding that, decoded once more, would change
  which household check applies, such as `/Users/%2541uthenticateByName`)
  gets a fixed `400 {"error":"invalid_request"}` with
  `Cache-Control: no-store`, the code the household app already documents and
  household sign-in already uses, and never reaches Jellyfin; a WebSocket
  upgrade to one gets `400` too. Allowed in a minor release by the household-check rule at the top of this file.
- **Household hostnames refuse Jellyfin's sign-in by ID.** Jellyfin 10.11
  still routes the obsolete `POST /Users/{id}/Authenticate`, which signs in by
  user ID and password without the household check. No Jellyfin client in use
  (Jellyfin web, Swiftfin, Streamyfin, Findroid) or Jellyfin SDK calls it; they
  sign in by name or with Quick Connect. On a household hostname every such
  call, a member's or not and whatever the password, now counts against the
  same per-address sign-in limit as a sign-in by name and gets the same
  `401 {"error":"invalid_credentials"}` a refused sign-in by name gets, after
  the same minimum delay, without asking Jellyfin. So the answer no longer
  tells a member's ID from anyone else's. Allowed in a minor release by the household-check rule at the top of this file.
- **Household hostnames check every route that names an item.** Jellyfin
  10.11 serves an item's HLS playlists and segments (`master.m3u8`,
  `main.m3u8`, `live.m3u8`, `hls1/...`, the legacy `hls/...`), its subtitles,
  attachments and direct streams to any signed-in user, and some of them to
  anyone, without checking whether that user may see the item. The gateway
  checked only `/Videos|Audio/{id}/stream`, `master.m3u8`, `main.m3u8` and
  `/Items/{id}/Download`, so a household member could still play, by HLS, a
  title hidden from them (this affected 3.1.1 too). Every route under
  `/Videos/{id}`, `/Audio/{id}`, `/Items/{id}`, `/UserItems/{id}`,
  `/UserPlayedItems/{id}`, `/UserFavoriteItems/{id}`, `/PlayingItems/{id}`,
  `/MediaSegments/{id}`, `/Shows/{id}`, `/Users/{userId}/Items/{id}` (and its
  played, playing and favourite variants) and the item routes of `/Albums`,
  `/Artists`, `/Movies`, `/Songs` and `/Trailers` (`InstantMix`, `Similar`) is
  now checked against the caller's own Jellyfin view of the item before it is
  sent on, by any method, including routes Jellyfin may add later, and so is
  every `itemId` query parameter on them, however Jellyfin reads the query
  (Jellyfin takes a subtitle's item from it over the path). An item the caller may not see gets the fixed
  `404 {"error":"item_not_found"}`; a WebSocket upgrade to any of these routes
  gets `404`. The one exception is an item's images
  (`GET /Items/{id}/Images/...`), which Jellyfin serves to anyone and clients
  load without credentials; Jellyfin still refuses them to a signed-in caller
  who may not see the item. Jellyfin's anonymous live TV routes for its own
  transcoder (`/LiveTv/LiveRecordings/...`, `/LiveTv/LiveStreamFiles/...`) are
  now `404` on household hostnames. Because the check needs the caller's
  credentials, a client that fetches one of these routes without any gets
  `404`: jellyfin-web loads the fonts embedded in ASS/SSA subtitles
  (`/Videos/{id}/{mediaSourceId}/Attachments/{index}`) without credentials, so
  on a household hostname it renders those subtitles with its fallback fonts;
  Findroid plays `/Videos/{id}/stream` without credentials, which household
  hostnames already refused before this release. Allowed in a minor release by the household-check rule at the top of this file.
- **Household hostnames refuse any user ID but the caller's own.** Jellyfin
  10.11 takes the user a request names for the caller on some routes without
  checking it is the caller: with a member's token,
  `GET /Playlists/{id}/Items?userId={another user}` listed that user's private
  playlist, items hidden from the caller included; `GET /Users/{id}` returned
  any user's profile and `POST /Sessions/{id}/User/{id}` added any user to a
  session. On a household hostname every user ID a request names must now be
  the caller's own, as Jellyfin reports it for the request's own credentials:
  the second segment of every route under `/Users` but Jellyfin's fixed ones
  (`/Users/Me`, `/Users/Public`, `/Users/AuthenticateByName` and the like), by
  any method and including routes Jellyfin may add later; the user in
  `/Sessions/{id}/User/{userId}`; and
  every non-empty `userId`, `controllableByUserId` and `controllingUserId`
  query parameter, in any case, each of them when one is given more than once,
  however Jellyfin reads the query. IDs are compared as Jellyfin reads them
  (with or without dashes or braces, in any case). Anything else, the empty
  user ID `00000000-0000-0000-0000-000000000000` included, gets the same fixed
  `404 {"error":"item_not_found"}` as an item the caller may not see, before
  Jellyfin is asked; a WebSocket upgrade to any of these routes gets `404`.
  Jellyfin administrators are not exempt: on a household hostname no one acts
  as another user, and administration stays on Jellyfin's own address. The
  one exception is a user's picture (`GET /Users/{id}/Images/...`,
  `GET /UserImage?userId=`), which Jellyfin serves to anyone and the profile
  picker loads without credentials: it is served for the household's own
  members and refused for anyone else. Playlist sharing is not affected, by
  path or by body: the user in `/Playlists/{id}/Users/{userId}` (`GET`, `POST`,
  `DELETE`) is who the playlist is shared with, not the acting user, and
  Jellyfin checks the caller's own rights there, as it does for
  `Users[].UserId` in `POST /Playlists` and `POST /Playlists/{id}`; a `userId`
  query parameter on those routes must still be the caller's own. Those
  sharing routes are relayed to Jellyfin unchanged, including two Jellyfin
  10.11.3 bugs: a first share by path fails with `500`, and removing a share
  by path answers `204` but keeps it. Sharing through the playlist body is
  unaffected by either. jellyfin-web 10.11 names only the signed-in user (its playlist permission
  check included), so members using it see no difference. Allowed in a minor
  release by the household-check rule at the top of this file.
- **Household hostnames no longer relay Quick Connect to Jellyfin.** Quick
  Connect signs in whoever authorizes the code, so it skipped the membership
  check `POST /Users/AuthenticateByName` has there. `GET /QuickConnect/Enabled`
  still answers `false`, now in every spelling; every other Quick Connect call
  (`/QuickConnect/Initiate`, `/QuickConnect/Connect`, `/QuickConnect/Authorize`,
  `/Users/AuthenticateWithQuickConnect`, any other path under `/QuickConnect`,
  and `/QuickConnect/Enabled` by any method but `GET`) is a fixed
  `403 {"error":"household_quick_connect_disabled"}` with `Cache-Control:
  no-store`, the same for members and anyone else, and never reaches Jellyfin.
  Before, every such call but an exact `GET /QuickConnect/Enabled` was relayed. Allowed in a minor release by the household-check rule at the top of this file.
- **Household hostnames no longer relay the Streamyfin plugin's routes.**
  `/Streamyfin` and every path below it is a fixed
  `404 {"error":"not_found"}` with `Cache-Control: no-store` and never reaches
  Jellyfin, so the plugin, if installed, cannot hand its settings (Seerr's API
  key among them) to household users. Allowed in a minor release by the household-check rule at the top of this file.
- Both are matched as Jellyfin 10.11 routes them, like every household check
  above. A WebSocket upgrade to any of these paths is answered `404` and never
  reaches Jellyfin. The main Jellyfin site and the admin host are unaffected.

### Added

- Household app API: `GET /jellypass/app/v1/me` also answers `apiVersion`, the revision of the `v1` API the server
  speaks (an integer, `1`; it goes up by one with each release that adds a field or endpoint, never down), so a native
  client can ask for a server update instead of failing. Additive: `name` and `household` are unchanged, and the PWA
  does not read it.
- Household app API: a machine-readable contract, `docs/app-api/v1.openapi.json` (OpenAPI 3.1), describing every `v1`
  endpoint and answer, errors included. A test checks every endpoint's answers against it, so an undeclared or missing
  field fails CI.
- Household app API: `docs/app-api/fetch-budget.json` and a test that pin the calls the app makes when Home opens under
  All, Movies and TV and when a title or season page opens, so a change cannot quietly use more of the per-address
  budget a household's devices share.
- Docs: a native-client contract in `docs/app-design.md` ("Native clients (contract)"): one household per address and
  never a list of households, the token header only (no cookies, no token in URLs, no CORS), the required sign-in client
  fields, device-only token storage, fixed errors and wording, the identical **Get this** outcome, and the budgets. `v1`
  only ever gains fields and endpoints; removing, renaming or changing the meaning of anything needs `/jellypass/app/v2`.

## [3.1.1] - 2026-10-26

This is a patch release for the admin UI only. There is nothing to configure:
no setting is added, removed or renamed, and the state file is unchanged
(schema v7, with the same fields as 3.1.0), so 3.1.0 reads a state file written
by 3.1.1. The household app, household hostnames and the Seerr webhook are
unchanged: no file of the household app and none of the household gateway or
app API code changed. No server behaviour changed (only the version string
JellyPass reports to Jellyfin): the administrator API answers as before. Read
these before upgrading:

- **Administrators sign in again after the upgrade.** Sessions are kept in
  memory only, so restarting JellyPass to upgrade signs every administrator
  out, as any restart does.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.1.0` and recreate the container.
  Administrators sign in again. No state-file or setting change is needed.

### Fixed

- **Admin UI: a session that ends just after signing in no longer blames the
  password.** If the session ended (a sign-out elsewhere, or the administrator
  was demoted or disabled) while the admin UI loaded its data right after a
  successful sign-in, the sign-in form said "That username or password was
  not accepted." It now says "Your session has ended. Sign in again." A sign-in
  the server refuses still shows the username-or-password message, and the
  too-many-attempts and Jellyfin-unavailable messages are unchanged.

## [3.1.0] - 2026-10-26

This is a minor release for the household app (`HOUSEHOLD_APP_ENABLED=true`)
only: with the app off (the default), nothing changes. It redraws the app in
Jellyfin's colours and adds an Account tab. There is nothing to configure: no
setting is added, removed or renamed, and the state file is unchanged (schema
v7, with the same fields as 3.0.1), so 3.0.1 reads a state file written by
3.1.0. No server behaviour changed (only the version string JellyPass reports
to Jellyfin): the app API, the household gateway, webhook
payloads, the administrator API and the admin UI are unchanged. Read these
before upgrading:

- **The household app looks different.** It now uses Jellyfin's navy
  `#000b25` and cyan `#00a4dc`, with Jellyfin purple only as a small
  decoration and no brand-colour gradient: no purple-to-blue or cyan blends,
  only subtle navy shading behind images and the loading shimmer (part 1 below
  describes an intermediate teal look
  that part 2 replaces). The header no longer shows the JellyPass wordmark or
  the (i) button: a fourth tab, **Account**, holds **Sign out** and **About &
  credits**, and old `#/about` links open it. Signing out lands on the
  sign-in screen, and Back does not return to Account.
- **The All-time great rows are no longer on Home,** under any filter, so Home
  makes fewer TMDB calls. Their app endpoints, `GET /discover/top-movies` and
  `GET /discover/top-tv`, are kept and answer as before.
- **On iPhone, close and reopen the installed app** to pick up the new look.
  As we understand it (not tested), the Home Screen icon and its colours may
  only update after removing the app and adding it to the Home Screen again;
  do that only if they have not changed.
- **No CDN purge is needed:** the app's files, the stylesheet, manifest and
  icons included, are still named by content hash (those fingerprinted files
  are sent `public, max-age=31536000, immutable`), and the page, the service
  worker and every other `/jellypass/app` answer are sent `no-store`, so the
  new files have new addresses. The app's Content Security Policy is
  unchanged.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.0.1` and recreate the container. No
  state-file or setting change is needed. On 3.0.1 a `#/account` link opens
  Home.
- **Tested in a simulated browser:** the new look, the Account tab, the hero,
  the cards and the detail pages are covered by the app's tests in a simulated
  browser, not yet on a physical phone; see
  [Household app (PWA)](README.md#household-app-pwa).

### Changed

- **Household app: the Tidepool look, part 2** (colours, header, tabs, hero, big cards and detail pages; no setting,
  API, data or **Get this** outcome changes). The app now wears **Jellyfin's colours**: Jellyfin navy `#000b25` with
  lighter navy surfaces, and **Jellyfin cyan `#00a4dc`** as the main colour (primary buttons, the chosen chip, the
  active tab's outline and tint, links and focus rings), with derived cyan text and on-cyan text that hold at least
  4.5:1. Jellyfin purple `#aa5cc3` is only a small decoration (the end-cap of each row heading's waterline, a cyan line
  then a short purple segment with a gap, never a gradient); there is no teal or coral left, `theme-color`, the manifest
  and the app icons follow. The **header** no longer shows the JellyPass wordmark or the (i) button: it carries Back and
  the screen's title, and Home goes straight to the filter chips and the hero. A fourth tab, **Account** (with its own
  key icon), holds the member card with **Sign out**, then **About & credits** (TMDB's logo and exact notice, the
  JustWatch credit and the app's version); the old `#/about` address opens it. **Sign out** lands on the sign-in screen,
  in place of Account's history entry, so Back never returns to a signed-in-looking Account. **Home's hero** is an inset
  rounded card (4:5 on a phone) with a solid navy text panel (title, year, rating, status chip and a two-line overview,
  readable whatever the picture), round bubble buttons and Previous/Next below it, no autoplay and reduced motion
  honoured, and still follows the filter. The **big cards** put the title and "year · ★ rating TMDB" below a 16:9 image
  (radius 24 px) with a solid status chip at its top-left; at large text a tall focused card is scrolled clear of the
  tab bar. **Detail pages** open with an inset rounded backdrop card, then the title, chips, one full-width cyan action
  and the season cards, on navy. Removed from Home under every filter: the **All-time great movies** and **All-time
  great TV** rows (the server endpoints stay), so a first load and the lazy rows make fewer calls. Tests cover contrast
  for the new colour pairs, no teal/coral, no purple on text or controls, no purple-to-blue gradient, the header, the
  four tabs, Account and Sign out, the hero panel and pager, the card and detail layouts, and the fetch counts.
- **Household app: the Tidepool look, part 1** (the app's whole look changes; no setting, API, data or **Get this**
  outcome does). The page is a deep teal-black with an aqua accent and a touch of coral, solid surfaces with no glass
  or glow, and bigger rounded shapes (radii 12/20/24/30 px, 800-weight titles). The header is a solid bar. Home's
  All / Movies / TV filter is a row of outlined chips under the header (the chosen one ticked and tinted aqua; still a
  radio group with the same keys, `?kind=` address and Back restore) in a solid band that sticks under it, above the
  hero. The floating tab bar is now docked full width with rounded top corners and an aqua-outlined, tinted rounded square behind the
  active tab (no dot). Row headings have a short aqua-to-coral line under them (a service's brand colour on its rows)
  instead of a vertical bar. A title's status (the same five words) is a dot and a word at the top-left of its image.
  The primary button is solid aqua and the secondary is outlined. The big cards are rounder, with a thin border.
  Part 2 will redraw the hero and the detail pages (this part only recolours them), and the app icons are not yet
  redrawn. The `theme-color` and the installed app's background colour are now the new page colour. At large text the
  chosen chip, focus ring included, is scrolled fully into the chip row on every choice and on first load. The app
  writes no style attributes via markup or `setAttribute`; the three measured chrome heights are root custom properties
  set via the CSSOM, which `style-src` allows.

## [3.0.1] - 2026-10-26

This is a patch release for the admin UI and the administrator API. There is
nothing to configure: no setting is added, removed or renamed, and the state
file is unchanged (schema v7, with the same fields as 3.0.0), so 3.0.0 reads a
state file written by 3.0.1. The household app, household hostnames and the
Seerr webhook are unchanged: no file of the household app and none of the
household gateway or app API code changed. Read these before upgrading:

- **Administrators sign in again after the upgrade.** Sessions are kept in
  memory only, so restarting JellyPass to upgrade signs every administrator
  out, as any restart does.
- **Scripts that send a non-JSON body to a route that reads none now get
  `415`.** 3.0.0 documented that every admin request body must be declared as
  JSON; 3.0.1 also applies it to the routes that never read their body (see
  Fixed below). Send no body, or declare it as `application/json`.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:3.0.0` and recreate the container.
  Administrators sign in again. No state-file or setting change is needed.

### Fixed

- **Admin UI: a session Jellyfin cannot check for a moment no longer looks
  signed out.** While Jellyfin cannot answer the five-minute session check
  (`503 {"error":"session_check_unavailable"}`), the server keeps the session
  and allows another check 30 seconds later, but the admin UI showed the
  sign-in form at load and the raw code after an action. It now keeps its
  current view, shows "Jellyfin is temporarily unavailable — retrying…" and
  asks again on its own, first after 30 seconds, then doubling to every two
  minutes, and returns to normal once the check passes. The wait is paused
  while the tab is hidden, and time spent hidden does not count towards it. A
  `401` still returns to sign-in, including from the recent-requests widget,
  which used to show the app with empty activity instead. An answer that
  arrives after a sign-out, a `401` or a new sign-in, or a request that fails
  outright after the session ended, no longer changes the view, shows a notice
  or toast, or starts a retry. Other error codes the admin API answers with
  (such as `cross_origin_request_refused` or `too_many_requests`) are shown as
  sentences instead of codes.
- **Admin: routes that never read a body now also reject one not declared as
  JSON,** as documented in 3.0.0. A body (a non-zero `Content-Length` or any
  `Transfer-Encoding`) not declared as `application/json` sent to
  `POST /auth/logout`, `POST /v1/library/sync`, `POST /v1/reconcile`,
  `DELETE /v1/grants/{itemId}/requests/{requestId}` or
  `DELETE /v1/groups/{groupId}` is
  `415 {"error":"unsupported_media_type"}` before the route does anything,
  bearer requests included; routes that read a body already answered so.
  Requests without a body work as before, whatever their `Content-Type`, and
  unknown paths and methods are still `404 {"error":"not_found"}` whatever
  they carry.

## [3.0.0] - 2026-10-26

This is a major release for the administrator API and the admin UI. The
administrator API is part of JellyPass's public interface, and the versioning
policy's one exception (at the top of CHANGELOG.md) covers only failure
responses on endpoints relayed to Jellyfin, so the changes below that refuse
requests 2.7.0 accepted make this 3.0.0. The
household app, household hostnames and the Seerr webhook are unchanged: no
file of the household app and none of the household gateway or app API code
changed. There is nothing to configure: no setting is added, removed or
renamed, and the state file is unchanged (schema v7, with the same fields as
2.7.0), so 2.7.0 reads a state file written by 3.0.0. Read these before
upgrading:

- **Every administrator must sign in again after upgrading.** Over HTTPS the
  session cookie is now `__Host-jellypass_session`, and a `jellypass_session`
  cookie from 2.7.0 is ignored there (restarting JellyPass signs sessions out
  anyway). Plain HTTP (LAN) keeps `jellypass_session`.
- **Scripts that use the session cookie need a matching `Origin`, or should
  use `ADMIN_TOKEN`.** A `POST`, `PUT`, `PATCH` or `DELETE` sent with the
  session cookie, and every `POST /auth/login`, must carry
  `Sec-Fetch-Site: same-origin` or an `Origin` equal to the admin host, or it
  is `403 {"error":"cross_origin_request_refused"}`. Requests with
  `ADMIN_TOKEN` as a bearer token are not origin-checked; scripts should use
  it.
- **Admin request bodies must be declared as JSON.** A body sent without
  `Content-Type: application/json` (parameters such as `charset` allowed) is
  `415 {"error":"unsupported_media_type"}`, bearer requests included. The Seerr
  webhook still accepts any declared type.
- **A reverse proxy must pass `Host` unchanged.** The admin origin is read
  from `Host` only, never from `X-Forwarded-Host`, so a proxy that rewrites
  `Host` to the upstream address makes every sign-in and change from the admin
  UI a `403`. Nginx Proxy Manager keeps `Host`. You may also overwrite a
  client's own `X-Forwarded-Host` at the proxy (in Nginx,
  `proxy_set_header X-Forwarded-Host $host;`); JellyPass ignores it either way.
- **The admin URL is not gated by default.** Anyone who can reach `/admin/`
  can try to sign in. JellyPass limits attempts, but put the admin host behind
  an identity-aware gate such as Cloudflare Access, a VPN or an IP allowlist at
  the proxy, or keep it on the LAN, on a host of its own.
- **Failed sign-ins answer differently.** Every refused sign-in, missing
  fields included (2.7.0 answered `400`), is
  `401 {"error":"invalid_credentials"}`, no sooner than one second after it
  arrived, and Jellyfin's own error text is no longer relayed. Past five
  failures for a name in 15 minutes, from any address, each further sign-in for
  it waits longer (250 ms, doubling, at most five seconds) before Jellyfin is
  asked; the right password still signs in.
- **The rate limit is the one exception:** a fixed
  `429 {"error":"too_many_login_attempts"}`, also no sooner than one second,
  after eight failures from one address in five minutes or, new, ten for one
  name from one address in 15 minutes.
- **Sessions are checked against Jellyfin every five minutes.** A deleted,
  demoted or disabled administrator's session ends (`401`); while Jellyfin
  cannot answer the check, requests with the session get
  `503 {"error":"session_check_unavailable"}`, retried after 30 seconds.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:2.7.0` and recreate the container. Sessions
  are kept in memory only, so administrators sign in again; a leftover
  `__Host-jellypass_session` cookie is ignored by 2.7.0. No state-file or
  setting change is needed.

### Security

- Admin: a state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) signed in by the browser session cookie,
  including `POST /auth/logout`, and every `POST /auth/login`, must come from the admin origin itself:
  `Sec-Fetch-Site: same-origin`, or, without it, an `Origin` equal to the host the request was sent to, read from `Host`
  only, with an https scheme when the proxy reports HTTPS. Anything else is a fixed
  `403 {"error":"cross_origin_request_refused"}` before any work is done, the session included: it is refused before the
  session is looked at, so a cross-origin request never starts the five-minute session check below, never sees its `503`
  and never ends a demoted administrator's session. `X-Forwarded-Host` is not read, even from a trusted proxy: a proxy
  that keeps `Host` (Nginx Proxy Manager does) may still pass a client's own `X-Forwarded-Host` on, which would let a
  sibling page add its origin. A proxy in front of the admin host must therefore pass the browser's `Host` unchanged.
  `SameSite=Strict` did not cover this: every sibling host under the same site (household hosts, Seerr) is same-site.
  `ADMIN_TOKEN` bearer requests and the Seerr webhook (its own token) are exempt; a state-changing request with no
  session cookie is still `401 unauthorized`.
- Admin: a request body must be declared `Content-Type: application/json` (parameters allowed), or the answer is
  `415 {"error":"unsupported_media_type"}` before it is read. The Seerr webhook still accepts any declared type.
- Admin: every refused sign-in (wrong password, unknown name, not an enabled administrator, a malformed body, Jellyfin
  failing or answering an error) is the same `401 {"error":"invalid_credentials"}`, no sooner than one second after it
  arrived; Jellyfin's own error text is never relayed (it is logged). Missing fields used to answer `400`; they now
  answer `401 invalid_credentials` like any other refusal. The one exception is the rate limit, a deliberate separate
  signal so an administrator knows to wait rather than retype: `429 {"error":"too_many_login_attempts"}`, fixed, also no
  sooner than one second, and Jellyfin is not asked. It is reached per client address (eight failures in five minutes,
  as before) or, new, per name from one client address (ten in 15 minutes, case- and width-insensitive). Both count
  whether or not the account exists and are keyed by the caller's own address, so a `429` says nothing about which
  accounts exist and is only ever seen by the address that caused it.
- Admin: failures for a name from any address never refuse it: past five in 15 minutes each further sign-in for that
  name waits longer before Jellyfin is asked (250 ms, doubling, at most five seconds), the right password included, which
  then signs in as usual. Guessing an administrator's name from many addresses slows the guessing but cannot lock the
  administrator out.
- Admin: every five minutes each browser session's administrator is read again from Jellyfin with JellyPass's API key
  (one read per session, however many requests wait on it). A user who was deleted, demoted or disabled ends the
  session (`401`); a check Jellyfin fails to answer keeps the session but answers `503 session_check_unavailable`,
  retried after 30 seconds. Before, such a session lasted up to 12 hours.
- Admin: over HTTPS the session cookie is now `__Host-jellypass_session` (Secure, `Path=/`, no `Domain`), so no
  sibling host can set or overwrite it; plain HTTP (LAN) keeps `jellypass_session`. A session cookie from before the
  change is ignored over HTTPS (sign in again; restarting JellyPass signs sessions out anyway), and is cleared at the
  next sign-in or sign-out.
- Admin: the UI's files carry the household app's headers too: `Permissions-Policy` (same deny list),
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and `form-action 'none'`
  (the UI posts no forms). Admin API answers carry `Cross-Origin-Resource-Policy: same-origin`.

## [2.7.0] - 2026-10-26

This is a minor release for the household app (`HOUSEHOLD_APP_ENABLED=true`)
only: with the app off (the default), nothing changes. It adds a filter, rows,
service films and app endpoints. There is nothing to configure: no setting is
added, removed or renamed, webhook payloads and the administrator API are
unchanged, and the state file is unchanged (schema v7, with the same fields as
2.6.0), so 2.6.0 reads a state file written by 2.7.0. Read these before
upgrading:

- **More TMDB calls as members scroll and switch filters.** Opening Home on
  **All** still makes four TMDB calls before anything is drawn (Trending,
  Popular movies, Popular series and, new, New movie releases; Upcoming movies
  now waits to near the screen); **Movies** makes four and **TV** three.
  Scrolling to the bottom of All adds at most twenty calls (2.6.0: nine): each
  of the eight **Popular on** rows now costs two (its series and its films),
  plus Upcoming movies, Upcoming series and the two all-time rows; the bottom of
  Movies or TV adds at most nine. Switching filter asks for that filter's first
  rows at once. A service's page costs two calls per page on its **All** tab,
  one on **Series** or **Films**. Every answer is cached per household for up to
  ten minutes, under the same key whichever row, filter or tab asked for it,
  and shares TMDB's rate limit as before.
- **Where-to-watch data is for the US only.** A service's films come from
  TMDB's where-to-watch data (JustWatch's) for the US, the same for every
  household and not a setting; outside the US they may not match what the
  service offers there. Its series are not region-specific. **New movie
  releases** are likewise films that opened in US theatres in the last 60 days.
- **JustWatch is credited** on About, under Home's service rows (All and
  Movies) and on a service page's All and Films tabs, as its data requires.
- **Existing app API answers are unchanged.** A path with a second segment
  after a network's or studio's ID, other than `films` or `all` after a listed
  network's (for example `/discover/network/213/2` or
  `/discover/studio/2/films`), is still `404 not_found`, before TMDB is asked.
  `GET /discover/network/:id` still lists the service's series alone, and
  `GET /discover/sources` only gains `hasFilms`. In the app, a service's page
  (`#/network/:id`) now opens on **All**, its series and films mixed.
- **No CDN purge is needed:** the app's files are still named by content hash
  and every other `/jellypass/app` answer, the new endpoints included, is sent
  `no-store`. No new image host or size: backdrops are TMDB's `w780` and
  `w1280` (a `srcset`), both already used in 2.6.0, and the app's Content
  Security Policy is unchanged.
- **To roll back,** set `JELLYPASS_IMAGE` back to
  `ghcr.io/nicklongmore86/jellypass:2.6.0` and recreate the container. On
  2.6.0 a `#/?kind=` link opens Home unfiltered and `#/network/:id?kind=` opens
  the service's series.
- **Tested in a simulated browser:** the switch, the new rows, the backdrop
  cards, the service films and tabs and the focus scrolling are covered by the
  app's tests in a simulated browser (the watch provider IDs were checked
  against TMDB's live API), not yet on a physical phone; see
  [Household app (PWA)](README.md#household-app-pwa).

### Added

- Household app: Home has an **All | Movies | TV** switch under the hero, a floating pill that sticks just below the
  status bar as Home scrolls. Movies shows films only and TV series only, from lists of their own kind (per-kind
  Trending, each service's films or its series), so no row is half empty; the hero follows. The choice is kept in the
  address (`#/?kind=movies`, `#/?kind=tv`), replaced in place, so Back from a title comes back to it. It is a radio group
  of real buttons: arrow keys, Home and End move and choose.
- Household app: each **Popular on** row (Netflix, Disney+, Apple TV, Prime Video, HBO Max, Hulu, Paramount+, Peacock)
  now mixes the service's popular series with the films it streams in the US, film then series in turn, each card
  saying "Movie" or "Series". A service's page has an **All | Series | Films** control (real buttons, arrow keys, Home
  and End), kept in the address (`#/network/:id?kind=series`, `?kind=films`), so Back comes back to the same tab with
  its pages and scroll.
- Household app: new Home rows **New movie releases** (among the first four rows) and, near the foot, **All-time great
  movies** and **All-time great TV**, the last two fetched as they near the screen.
- Household app: each Home row's heading bar is coloured: gold for the all-time rows, a tasteful approximation of the
  brand colour for each of the eight services, the app's purple for the rest. Decorative only; the heading says what
  the row is.
- Household app API: `GET /jellypass/app/v1/discover/{trending-movies,trending-tv,new-movies,top-movies,top-tv}?page=`
  (TMDB `trending/movie/day`, `trending/tv/day`, `discover/movie` for films that opened in US theatres in the last 60
  days, `movie/top_rated` and `tv/top_rated`). Read-only, allowlisted by name (any other spelling is `404`, a bad
  `page` `400`), cached per household, in TMDB's fair share, and the same for every household.
- Household app API: `GET /jellypass/app/v1/discover/network/:id/films?page=` (the service's films in the US: TMDB
  discover by its watch providers with `watch_region=US` and `flatrate`) and
  `GET /jellypass/app/v1/discover/network/:id/all?page=` (series and films mixed, one page of each). `GET
  /discover/sources` gives each network `hasFilms: true`. Only the listed services; films are cached apart from series,
  per household.

### Changed

- Household app: **Popular movies**, **Popular series**, **New movie releases** and **All-time great movies** on Home
  are large landscape backdrop cards: one nearly full-width 16:9 card per phone screen with the next one peeking in
  (about three across on a wide screen), the title and "year · ★ rating TMDB" over a dark gradient at the foot, and
  the status pill on the corner. The whole card is the link to the title's page. A title with no backdrop shows its
  poster, or a plain card. The other rows keep poster cards. The images come from the rows' own answers, and Back still
  puts each row's scroll position back.
- Household app: on **All**, **Upcoming movies** now waits to near the screen (it was among the first four rows), to
  keep Home's first load at four TMDB calls.
- Household app: on Home the **Studios** strip now follows the **Popular on** rows (it came before them), and the
  where-to-watch credit closes the page.
- Household app: a service's page (`#/network/:id`) now opens on **All** (its series and films mixed, like its Home
  row); its series alone are the **Series** tab.
- Household app: a card in a Home row that gets focus from the keyboard is scrolled fully into its row (it could be
  left almost off the edge). A card's link name now includes its status ("Title, 2024 · Movie, Ready to watch"), and
  the status pill beside it is hidden from assistive technology, so the status is said once.

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

[Unreleased]: https://github.com/nicklongmore86/jellypass/compare/v3.7.0...HEAD
[3.7.0]: https://github.com/nicklongmore86/jellypass/compare/v3.6.1...v3.7.0
[3.6.1]: https://github.com/nicklongmore86/jellypass/compare/v3.6.0...v3.6.1
[3.6.0]: https://github.com/nicklongmore86/jellypass/compare/v3.5.0...v3.6.0
[3.5.0]: https://github.com/nicklongmore86/jellypass/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/nicklongmore86/jellypass/compare/v3.3.1...v3.4.0
[3.3.1]: https://github.com/nicklongmore86/jellypass/compare/v3.3.0...v3.3.1
[3.3.0]: https://github.com/nicklongmore86/jellypass/compare/v3.2.4...v3.3.0
[3.2.4]: https://github.com/nicklongmore86/jellypass/compare/v3.2.3...v3.2.4
[3.2.3]: https://github.com/nicklongmore86/jellypass/compare/v3.2.2...v3.2.3
[3.2.2]: https://github.com/nicklongmore86/jellypass/compare/v3.2.1...v3.2.2
[3.2.1]: https://github.com/nicklongmore86/jellypass/compare/v3.2.0...v3.2.1
[3.2.0]: https://github.com/nicklongmore86/jellypass/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/nicklongmore86/jellypass/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/nicklongmore86/jellypass/compare/v3.0.1...v3.1.0
[3.0.1]: https://github.com/nicklongmore86/jellypass/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/nicklongmore86/jellypass/compare/v2.7.0...v3.0.0
[2.7.0]: https://github.com/nicklongmore86/jellypass/compare/v2.6.0...v2.7.0
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
