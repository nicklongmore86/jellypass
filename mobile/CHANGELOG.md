# Changelog

All notable changes to the JellyPass household app for iPhone, iPad and Android
(`mobile/`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the app adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
as described in [Versioning](README.md#versioning).

This changelog is the app's alone. The server has its own version and its own
[changelog](../CHANGELOG.md); a server release never changes the app, and an
app release never changes the server. Each release below says which JellyPass
server it needs. Build numbers are not listed: EAS sets a new one for every
build.

## [Unreleased]

### Changed

- **Home: the whole row heading opens its See all page.** On a list row and on a service row, a tap anywhere on the
  heading line (the title, the service's logo or the space beside them) opens the same page the chevron does, with the
  same filter and New only choice and no extra call. The line is at least 44 pt tall, and a press on the title or on the chevron dims the whole line. Screen
  readers are unchanged: the heading is still a heading, and the one "See all <heading>" link is still the chevron.
  Rows without a See all page (Studios) stay plain headings.

## [1.3.0] - 2026-10-30

A minor release, and the first build sent for App Store review: each list row
on Home gains a **See all** page, the app takes **any HTTPS household
address** (not only `https://jelly-<household>.<domain>`), and Account →
About & credits links to the privacy policy and support pages on
jellypass.app. It still works with **JellyPass server 3.2.0 or later** (app API
`v1`), as 1.0.0 to 1.2.1 do; none of these changes needs a server change. See
all uses the list addresses Home already reads (`GET /discover/<list>?page=n`),
which every supported server answers. As in 1.1.0, **Cancel request and the
day each title was requested need JellyPass server 3.5.0 or later**
(`apiVersion` 2 in `GET /jellypass/app/v1/me`); on an older server the app
shows neither, with no error. Members update by installing the new TestFlight
build, or the new APK over the old one.

### Added

- **Home: See all on every list row.** Trending, Popular movies, Popular series, New movie releases, Upcoming movies
  and Upcoming series (and Trending movies / Trending series under the Movies and TV filters) have the same chevron
  after their heading as the service rows, a link named "See all <heading>" (for example "See all Trending"). It opens
  the row's full list as a poster grid on Home's stack, like a service's page: New only (the same choice as Home's),
  the short corner badges, Load more, and Back to Home with the filter as it was. Opened from its row it makes no
  call; Load more asks for one page. It uses the server's existing `GET /discover/<list>?page=n`, as the TV add-on's
  See all pages (server 3.9.0) do.
- Account → About & credits says the app is an unofficial companion, not affiliated with Jellyfin or Seerr.
- About, Privacy policy and Support links to jellypass.app: **Privacy policy**
  (`https://jellypass.app/privacy/`) and **Support** (`https://jellypass.app/support/`) in Account → About & credits,
  and **What is JellyPass?** (`https://jellypass.app/`) on the address screen. They are set in the app config
  (`extra.privacyPolicyUrl`, `supportUrl`, `aboutUrl`), and a link whose URL is unset or not a plain https URL stays
  hidden. They open in the system browser, are allow-listed, and carry no member data.
- The address screen says what the app is: a companion for a JellyPass household server, whose address comes from
  whoever runs your Jellyfin.
- A `production-aab` EAS profile that builds an Android App Bundle for Google Play. The APK builds and their
  signing key are unchanged, so the new APK still installs over the old one.

### Changed

- **Any HTTPS household address works.** The app no longer requires `https://jelly-<household>.<domain>`: it takes
  whatever HTTPS address the household's administrator gives out, such as `https://media.example.com` or
  `https://films.example.net:8443` (a port is kept, `:443` is dropped), typed or in a setup link. It still refuses
  `http://`, IP addresses, `.local` names, and anything around the address (a name or password, a path, a query or a
  fragment), and says which when a typed address is refused. A name with non-ASCII letters must be entered in its
  `xn--` form. A sign-in kept on a `jelly-` address keeps working. App versions up to
  1.2.1 take only the `jelly-` form, so a household on any other address needs this version or later.
- Cancelling a request no longer mentions a "download": an approved title "may still be added to the server, but it
  won't be added for your household."
- The app icons are 1024 × 1024 (the App Store's size), the same drawing as before. The Android adaptive icon's
  foreground is scaled to sit inside the launcher's safe zone, so a round or squircle mask no longer clips the ticket.

## [1.2.1] - 2026-10-29

A patch release: Home's filter chips and the poster badges are no longer cut
off, and "Hide what I have" is now called "New only". It still works with
**JellyPass server 3.2.0 or later** (app API `v1`), as 1.0.0 to 1.2.0 do; none
of these changes needs a server change. As in 1.1.0, **Cancel request and the
day each title was requested need JellyPass server 3.5.0 or later**
(`apiVersion` 2 in `GET /jellypass/app/v1/me`); on an older server the app
shows neither, with no error. Members update by installing the new TestFlight
build, or the new APK over the old one.

### Fixed

- **Home: the last filter chip is no longer cut off.** The chip row scrolls
  sideways with the screen's side padding inside it, so the last chip can be
  scrolled fully into view at any screen width and text size.
- **Poster badges are short and never cut off.** A badge on a poster says "In
  library", "Requested", "Get this" or "Can't get" (the words the TV add-on
  uses) in a small corner pill, at least 11 pt, instead of wrapping over the
  poster. The badge text follows the system text size like all other text. When
  the app estimates that the pill would not fit on one line inside a poster at
  your text size, it shows the same badge under the picture instead, where it
  can wrap. The full wording stays in each card's accessible name and on title
  pages.

### Changed

- **"Hide what I have" is now "New only"** on Home and on the service and
  studio pages. A screen reader hears the visible words first: "New only: show
  only titles you don't have or haven't requested". It still works the same
  way and is on at every sign-in.

## [1.2.0] - 2026-10-29

A minor release: Home can hide what the household already has, and signing in
and out is safer when two of them overlap. It still works with **JellyPass
server 3.2.0 or later** (app API `v1`), as 1.0.0 and 1.1.0 do, so it can be
installed before the household's server is upgraded. **Hide what I have needs no
server change**: it only filters what the app has already loaded, so it works on
any supported server. As in 1.1.0, **Cancel request and the day each title was
requested need JellyPass server 3.5.0 or later** (`apiVersion` 2 in
`GET /jellypass/app/v1/me`); on an older server the app shows neither, with no
error. Members update by installing the new TestFlight build, or the new APK
over the old one.

### Added

- **Home: Hide what I have.** A chip after All | Movies | TV, on by default at
  every sign-in. On, the rows and the hero leave out the titles in your library
  and the ones already requested (including one you just asked for), and the
  hero fills from the next titles; with none left it isn't shown. Turning it on
  or off makes no call to the server. The choice is kept only while you're
  signed in, never stored on the device, and starts on again after a sign-out,
  an expired sign-in or a change of household or member. The network and
  studio pages have the same chip and share the choice. My requests and Search
  are unchanged.

### Fixed

- **Home's hero keeps the title you were on** when Hide what I have is
  turned on or off, or a request removes a title: the dots, the scroll
  position and the slide you see always agree, and if the title is gone it
  moves to the nearest slide. It also stays on that title when its width
  changes (turning an iPad), instead of sitting between slides.
- **A late sign-out no longer touches a newer sign-in.** Signing out (or
  changing household) that finishes late no longer signs you out of, or
  erases the credentials of, the household you signed in to meanwhile, and a
  setup link waits until the sign-out has finished. A late "signed out"
  answer (a 401) from a previous sign-in no longer signs you out of, or resets
  Hide what I have for, the sign-in you made after it.
- **The stored sign-in is read, written and deleted one step at a time**, and
  only ever deleted if it is still the one that ended, whatever order two
  sign-ins finish in.

## [1.1.0] - 2026-10-28

A minor release: My requests can be filtered, and a member can cancel a request
from it. It still works with **JellyPass server 3.2.0 or later** (app API
`v1`), as 1.0.0 does, so it can be installed before the household's server is
upgraded. **Cancel request and the day each title was requested need JellyPass
server 3.5.0 or later** (`apiVersion` 2 in `GET /jellypass/app/v1/me`); on an
older server the app shows neither, with no error, and everything else works as
in 1.0.0. The filters work on any supported server. Members update by
installing the new TestFlight build, or the new APK over the old one.

### Added

- **My requests: Cancel request.** An entry the server lists as cancellable
  has a **Cancel request** button, 44pt, named by its request for VoiceOver and
  TalkBack. It opens a sheet that says what cancelling does ("This withdraws
  your household's request. If it has already been approved, the download may
  still finish, but it won't be added for your household.") with **Cancel
  request** and **Keep request**; it scrolls at the largest text size and stops
  widening on iPad. Confirming sends the cancel once; the screen always says
  **Request cancelled**, drops the entry and reads the list again, and the
  title shows **Get this** again on Home, Search and its page. A busy server
  (429), no connection and any other failure each have one fixed message, and
  nothing is retried by itself. Needs JellyPass server 3.5.0 or later: an
  older server lists no request as cancellable, so there is no button.
- **My requests can be filtered.** Chips above the list choose a status (All,
  Requested, Ready to watch, Couldn't get this), a type (All, Films, Series)
  and "Asked by me", and they combine, as in the household web app. A series
  matches a status if any status it shows has it, so a series with one season
  ready and another requested appears under both. When nothing matches, the
  screen says what is missing and offers "Show all requests". The chips are
  labelled for screen readers, ticked when chosen, at least 44 points high,
  and wrap onto more lines at large text. Choosing a filter makes no call and
  does not change which titles are reused; with more than ten requests it
  applies to the ones loaded so far, and Load more names the next ten. The
  choice is kept in memory while the app is open, never saved to the device,
  and cleared on sign-out, a refused sign-in or any change of household or
  member. It needs no server change.

### Changed

- **Each entry on My requests shows the day it was requested**
  ("Requested on …", in the device's date format), on screen and in its
  screen-reader name. Needs JellyPass server 3.5.0 or later; an older server
  sends no day, and the entry shows none, as before.

## [1.0.0] - 2026-10-27

The first release of the household app. It needs a household on **JellyPass
server 3.2.0 or later** with the household app on (`HOUSEHOLD_APP_ENABLED=true`).
It speaks the household app API `v1` and reads `apiVersion` 1 from
`GET /jellypass/app/v1/me` (3.2.0 is the first server that sends it, and that
publishes the native-client contract and `docs/app-api/v1.openapi.json` the
app is tested against; the contract is unchanged up to 3.2.2). An older server
is not supported.

### Added

- **Sign-in to a household address.** Type or paste the household's address,
  or open a `jellypass://connect?address=…` setup link, which only offers the
  address for the member to confirm. Then pick a profile (one tap for a
  passwordless member), sign in with a password, or sign in with a different
  name. One household at a time; the sign-in stays on the device only.
  Changing household signs out first.
- **Home** with **All | Movies | TV** filters, a hero of the first row's
  titles, poster rows, big backdrop cards for new releases, **Popular on**
  rows for eight streaming services and a **Studios** strip. Every row snaps
  so a card settles in the centre.
- **Network and studio pages**, opened from a service row's **See all** link
  or a studio's logo, as a poster grid with **Load more**.
- **Title and season pages**: backdrop, facts, genres, status and overview,
  with **Play** (opens the title in the household's own Jellyfin, in the
  system browser) when it is in the library and **Get this** when the
  household can ask for it, including choosing the seasons of a series.
  A season page lists its episodes.
- **Requested right after Get this**, on the title and season pages and on
  every card elsewhere, before the server's own answer catches up. Kept in
  memory only, for two minutes at most, and cleared on any sign-out.
- **Search** for movies and series as you type, with **Load more**.
- **My requests**: the household's requests and their status, one status
  pill per request, as in the household web app. A request for one season
  says the season on the line under the title (`2027 · Series · Season 1`).
  When several seasons share one status, the request shows one pill and lists
  them there as text (`Seasons 1–3`, `Seasons 1, 3`); when their statuses
  differ, each season has its own pill and the request shows none. Each
  entry's screen-reader name says every status once, and the admin note
  follows what did not work out (the season, when seasons differ). The list
  is read each time the tab is shown and on pull to refresh, so statuses are
  always current; a title's name, year and poster read in the last ten
  minutes of the same sign-in are reused (pull to refresh included), so
  coming back reads only the list and any request not named before. These
  titles are kept in memory only (at most 300), never their status, and are
  forgotten on sign-out, a refused sign-in or any change of household, member
  or sign-in.
- **Account**: the member and household, **Sign out**, **Change household**,
  About & credits (TMDB and JustWatch), the app's version and build number,
  and the household's API version.
- **iPhone, iPad and Android.** Portrait on phones; iPad and Android tablets
  turn. iOS is distributed through TestFlight and Android as an APK.

[Unreleased]: https://github.com/nicklongmore86/jellypass/compare/mobile-v1.3.0...HEAD
[1.3.0]: https://github.com/nicklongmore86/jellypass/releases/tag/mobile-v1.3.0
[1.2.1]: https://github.com/nicklongmore86/jellypass/releases/tag/mobile-v1.2.1
[1.2.0]: https://github.com/nicklongmore86/jellypass/releases/tag/mobile-v1.2.0
[1.1.0]: https://github.com/nicklongmore86/jellypass/releases/tag/mobile-v1.1.0
[1.0.0]: https://github.com/nicklongmore86/jellypass/releases/tag/mobile-v1.0.0
