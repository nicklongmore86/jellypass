# Changelog

All notable changes to the JellyPass mobile app (`mobile/`) are documented in
this file. The app ships through EAS, separately from the JellyPass server
image (see the root `CHANGELOG.md`).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **My requests: one status pill per request.** A series request no longer
  shows the same status twice (once under the title and again on its season's
  row), matching the household web app. A request for one season shows a
  single pill and says the season on the line under the title
  (`2027 · Series · Season 1`). When several seasons share one status, the
  request shows one pill and lists them there as text (`Seasons 1–3`,
  `Seasons 1, 3`); when their statuses differ, each season keeps its own pill
  and the request shows none. Movies are unchanged. Each entry's screen-reader
  name says every status once, and the admin note follows what did not work
  out (the season, when seasons differ).
