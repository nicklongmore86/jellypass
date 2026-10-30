# JellyPass

[![CI](https://github.com/nicklongmore86/jellypass/actions/workflows/ci.yaml/badge.svg)](https://github.com/nicklongmore86/jellypass/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/container-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/nicklongmore86/jellypass/pkgs/container/jellypass)

**Private households on one shared Jellyfin server.**

JellyPass runs next to [Jellyfin](https://jellyfin.org/) and
[Seerr](https://github.com/seerr-team/seerr). When a requested title becomes
available, it makes the title visible to the requester's household and blocks
it for every other non-administrator user, using Jellyfin's own tag-based
policies. Each household gets its own address with its own sign-in list, and
members can browse and ask for titles from phone, web and TV apps without any
other household learning what they asked for.

**Documentation: [jellypass.app/docs](https://jellypass.app/docs/)**

JellyPass is independent, community-maintained software. It is not affiliated
with or endorsed by Jellyfin, Seerr, or Jellyseerr.

> [!CAUTION]
> JellyPass changes Jellyfin item tags and complete user-policy documents. Test
> with non-critical users and media first, keep a backup of the state file, and
> retain a separate Jellyfin administrator recovery path.

## Features

- **Private requests.** Seerr's `MEDIA_AVAILABLE` webhook (or the optional
  request backfill) becomes a durable grant: the title is private to the
  requester and every household they belong to. Movies, complete series and
  their local trailers are covered; unrelated tags and blocked tags are kept.
- **Households.** Reusable groups of Jellyfin users. With `HOUSEHOLD_DOMAIN`
  set, each gets an address such as `https://jelly-grove.example.com` (the
  `jelly-` prefix is configurable) whose sign-in list shows only its members,
  with one-tap sign-in for members without a password. Media, byte ranges, HLS
  and WebSockets are proxied; Quick Connect and cross-user requests are refused.
- **Apps for members.** An app for iPhone, iPad and Android, an installable web
  app on every household address, and an optional TV add-on for Jellyfin web:
  browse, **Get this** (a Seerr request made as the member) and **My requests**.
- **Administrator UI.** Signed in with a Jellyfin administrator account:
  households, grants, bulk access for existing titles (up to 500 at a time),
  request approval, and a searchable catalogue of your library.
- **Self-healing.** Tags and policies are reconciled after failures and when
  users change. Health and Prometheus metrics endpoints are included.

JellyPass does **not** replace Jellyfin authentication, manage downloads, or
decide whether a Seerr request should be approved. Seerr remains the request
and acquisition authority; Jellyfin remains the playback authorization
authority. See [how access enforcement works](docs/server-reference.md#how-access-enforcement-works).

## Requirements

- Jellyfin **12.x or 10.11.x**, and a Jellyfin administrator API key. On any
  other version, household addresses pause until an administrator allows that
  exact version ([supported versions](docs/server-reference.md#supported-jellyfin-versions)).
- Seerr (or Jellyseerr) with users imported from or linked to Jellyfin.
- Docker with Compose v2 (images for `linux/amd64` and `linux/arm64`), or
  Node.js 22+ and pnpm.
- For household addresses: a domain, DNS and a TLS reverse proxy that passes the
  original `Host`. For the apps: a [TMDB](https://www.themoviedb.org/) API key.
- A persistent, private location for the state file, `grants.json`.

## Quick start

```sh
mkdir jellypass && cd jellypass
curl -LO https://raw.githubusercontent.com/nicklongmore86/jellypass/main/compose.yaml
curl -Lo .env https://raw.githubusercontent.com/nicklongmore86/jellypass/main/.env.example
mkdir -m 700 data
sudo chown 1000:1000 data   # the container runs as UID 1000
```

Edit `.env`: set `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `SEERR_URL`,
`SEERR_API_KEY`, and two different long random secrets for `WEBHOOK_TOKEN` and
`ADMIN_TOKEN` (`openssl rand -hex 32`). Pin a release from the
[releases page](https://github.com/nicklongmore86/jellypass/releases) rather
than `latest`, which follows `main`:

```dotenv
JELLYPASS_IMAGE=ghcr.io/nicklongmore86/jellypass:X.Y.Z
```

Then:

```sh
docker compose up -d
curl http://127.0.0.1:8787/health
```

Open `http://127.0.0.1:8787/admin/`, sign in with a Jellyfin administrator
account, and run **Sync library**. Then
[connect Seerr's webhook](https://jellypass.app/docs/seerr-webhook/),
[create households](https://jellypass.app/docs/households/) and
[put household addresses behind your reverse proxy](https://jellypass.app/docs/reverse-proxy/).

The Compose file publishes JellyPass on `127.0.0.1:8787` only. In 3.x that one
port serves the admin site, the webhook and every household address, and any
host name that is not a household address gets the admin site: forward only
household names to it from the internet, and keep the admin site on the LAN or
behind an access gate ([security](https://jellypass.app/docs/security/)).

To build from source instead: `cp .env.example .env`, edit it, and
`docker compose -f compose.example.yaml up --build -d`.

## Configuration

A minimal `.env` for households and the apps (plus `JELLYPASS_IMAGE`):

```dotenv
JELLYFIN_URL=http://jellyfin:8096
JELLYFIN_API_KEY=jellyfin-admin-api-key
SEERR_URL=http://seerr:5055
SEERR_API_KEY=seerr-api-key
WEBHOOK_TOKEN=long-random-secret
ADMIN_TOKEN=different-long-random-secret
HOUSEHOLD_DOMAIN=example.com
HOUSEHOLD_APP_ENABLED=true
TMDB_API_KEY=tmdb-key
TRUSTED_PROXIES=192.168.1.5
```

Every setting, with its default and validation, is in the
[settings reference](https://jellypass.app/docs/configuration/) and, in full
detail, in the [server reference](docs/server-reference.md#configuration).
[`.env.example`](.env.example) lists them with comments.

## Apps

All the apps need `HOUSEHOLD_APP_ENABLED=true` (with `HOUSEHOLD_DOMAIN`, Seerr
and `TMDB_API_KEY`) and talk only to the member's household address. See
[Phone, web and TV apps](https://jellypass.app/docs/apps/).

- **iPhone, iPad and Android** ([`mobile/`](mobile/README.md)): iOS through
  TestFlight for now, Android as a sideloaded APK. Needs JellyPass 3.2.0 or
  later; Cancel request needs 3.5.0 or later.
- **TV add-on** (`TV_ADDON_ENABLED`, `TV_ADDON_HOUSEHOLDS`): Discover rows,
  title pages and My requests inside Jellyfin web on the listed households'
  addresses ([design](docs/tv-addon.md)). A Samsung (Tizen) build is in
  `tv/samsung/` for advanced users.

### Household app (PWA)

Each household address serves an installable web app at `/jellypass/app/`. How
it signs in, installs, caches and is secured:
[Household app (PWA)](docs/household-hosts.md#household-app-pwa).

### Household app API

The JSON API the apps use, under `/jellypass/app/v1/` on household addresses:
[Household app API](docs/household-hosts.md#household-app-api), with the
OpenAPI contract in [`docs/app-api/v1.openapi.json`](docs/app-api/v1.openapi.json).

This product uses TMDB and the TMDB APIs but is not endorsed, certified, or
otherwise approved by [TMDB](https://www.themoviedb.org/). Titles, overviews
and images come from TMDB; streaming availability comes from JustWatch.

## Operations

Upgrade by backing up the state file, reading the [changelog](CHANGELOG.md),
setting `JELLYPASS_IMAGE` to the new version, then running `docker compose pull`
and `docker compose up -d`. Every version-to-version note, rollback, and the
drain before rolling back the household app are in
[Upgrade](docs/server-reference.md#upgrade).

### Backup and restore

The state file is the only data JellyPass must keep. Stop JellyPass, copy
`data/grants.json`, and start it again; back up Jellyfin separately. See
[Backup and restore](docs/server-reference.md#backup-and-restore).

## Documentation

| Topic | Where |
| --- | --- |
| Guide: installation, reverse proxy, Seerr, households, apps, upgrading, troubleshooting, security | [jellypass.app/docs](https://jellypass.app/docs/) |
| Server reference: every setting, Seerr payloads, admin UI, operations, troubleshooting, admin API, limitations | [docs/server-reference.md](docs/server-reference.md) |
| Household hostnames, Add to my library, household app API and PWA | [docs/household-hosts.md](docs/household-hosts.md) |
| Design notes | [household access](docs/household-access.md), [household app](docs/app-design.md), [TV add-on](docs/tv-addon.md) |
| Release notes | [CHANGELOG.md](CHANGELOG.md), [mobile/CHANGELOG.md](mobile/CHANGELOG.md) |

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

The runtime uses only Node.js standard-library modules. CI also runs
integration tests against each supported Jellyfin release (`pnpm test:real`)
and against Seerr (`pnpm test:seerr`); see
[Development](docs/server-reference.md#development). Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Report vulnerabilities privately through GitHub Security Advisories; see
[SECURITY.md](SECURITY.md). The admin site is not gated by default: keep it on
the LAN or behind an access gate.

## License

[MIT](LICENSE) © 2026 JellyPass contributors.
