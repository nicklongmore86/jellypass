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

### Added

- **My requests: Cancel request.** An entry the server lists as cancellable
  (a JellyPass server with API version 2 or later) has a **Cancel request**
  button, 44pt, named by its request for VoiceOver and TalkBack. It opens a
  sheet that says what cancelling does ("This withdraws your household's
  request. If it has already been approved, the download may still finish, but
  it won't be added for your household.") with **Cancel request** and **Keep
  request**; it scrolls at the largest text size and stops widening on iPad.
  Confirming sends the cancel once; the screen always says **Request
  cancelled**, drops the entry and reads the list again, and the title shows
  **Get this** again on Home, Search and its page. A busy server (429), no
  connection and any other failure each have one fixed message, and nothing is
  retried by itself. Each entry also shows the day it was requested. On an
  older server there is no button. Needs a JellyPass server with the cancel
  endpoint (the next server release after 3.4.0).
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
  and cleared on sign-out or when another member signs in. It needs no server
  change.

### Changed

- **The app's API client reads the request fields of `apiVersion` 2**
  (`cancellable` and the day a title was asked for, `requestedOn`) and can
  send a cancel, for the Cancel button a later release adds. Nothing on screen
  changes. A server before `apiVersion` 2 sends neither field: the client then
  reads every request as not cancellable, with no day, as before.

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

[Unreleased]: https://github.com/nicklongmore86/jellypass/compare/mobile-v1.0.0...HEAD
[1.0.0]: https://github.com/nicklongmore86/jellypass/releases/tag/mobile-v1.0.0
