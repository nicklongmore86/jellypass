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
- **My requests**: the household's requests and their status.
- **Account**: the member and household, **Sign out**, **Change household**,
  About & credits (TMDB and JustWatch), the app's version and build number,
  and the household's API version.
- **iPhone, iPad and Android.** Portrait on phones; iPad and Android tablets
  turn. iOS is distributed through TestFlight and Android as an APK.

[Unreleased]: https://github.com/nicklongmore86/jellypass/compare/mobile-v1.0.0...HEAD
[1.0.0]: https://github.com/nicklongmore86/jellypass/releases/tag/mobile-v1.0.0
