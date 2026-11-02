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
  other version, household addresses answer `503` until an administrator
  confirms that exact version (3.x only warned)
  ([supported versions](docs/server-reference.md#supported-jellyfin-versions)).
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
mkdir -m 700 data
sudo chown 1000:1000 data   # the container runs as UID 1000
docker compose up -d
sudo cat data/admin-token   # the setup token
```

Open `http://127.0.0.1:8788/admin/`, enter the setup token, and follow the
[setup wizard](docs/server-reference.md#setup-wizard): it signs in to Jellyfin
once to create JellyPass's own API key, checks Seerr's key and points Seerr's
webhook at JellyPass with a token it generates, checks your TMDB key, and sets
the request backfill to the install date. Nothing to write by hand. Without
`ADMIN_TOKEN`, the setup token stays the admin token after setup: keep it
private (to rotate it, see [Setup wizard](docs/server-reference.md#setup-wizard)).

Then sign in to the admin site with a Jellyfin administrator account, run
**Sync library**,
[create households](https://jellypass.app/docs/households/), give each its
address (Groups → **Addresses**, for example `https://media.example.com`) and
[put household addresses behind your reverse proxy](https://jellypass.app/docs/reverse-proxy/).

Pin a release from the
[releases page](https://github.com/nicklongmore86/jellypass/releases) rather
than `latest`, which follows `main`, in a `.env` next to `compose.yaml`:

```dotenv
JELLYPASS_IMAGE=ghcr.io/nicklongmore86/jellypass:X.Y.Z
```

Prefer environment variables? Every setting can still be set in `.env`
(`curl -Lo .env https://raw.githubusercontent.com/nicklongmore86/jellypass/main/.env.example`):
set `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `SEERR_URL`, `SEERR_API_KEY`, and two
different long random secrets for `WEBHOOK_TOKEN` and `ADMIN_TOKEN`
(`openssl rand -hex 32`). A variable set there always wins over the wizard,
which shows it as locked; with all the required ones set the wizard is never
shown.

JellyPass has two listeners (see
[Listeners](docs/server-reference.md#listeners)): the **admin listener** on
port `8788` (admin site and API, metrics, the Seerr webhook and health) and the
**member listener** on port `8787` (household addresses only; any other host
name gets a fixed `421`). The default Compose file publishes both only on
`127.0.0.1`. Route household names from the internet to `8787` only, and
publish the admin port only on a private address, never routing a public
hostname to it ([security](https://jellypass.app/docs/security/)). Seerr's
webhook goes to the admin listener, for example
`http://jellypass:8788/webhooks/seerr`, with the
`Authorization: Bearer <WEBHOOK_TOKEN>` header (4.0 takes no `?token=`).

Upgrading to 4.0 from 3.9.x or later 3.x changes the admin port, the health
check, the Seerr webhook URL and the state file (schema 8, which 3.x cannot
read): follow the [4.0.0 upgrade steps](CHANGELOG.md#400---2026-10-31) before
pulling it. 4.1.0 migrates the state file to schema 9 for [household app and TV switches](docs/household-access.md#household-app-and-tv-switches)
(4.0.0 cannot read it): back up state, and remove `TV_ADDON_HOUSEHOLDS` after
migration; see the [4.1.0 notes](CHANGELOG.md#410---2026-11-02).

To build from source instead, run these inside a clone of this repository
(the container runs as UID 1000, so it needs a data directory it can write):

```sh
git clone https://github.com/nicklongmore86/jellypass.git && cd jellypass
mkdir -m 700 data
sudo chown 1000:1000 data
cp .env.example .env   # then edit it
docker compose -f compose.example.yaml up --build -d
```

## Configuration

The [setup wizard](docs/server-reference.md#setup-wizard) stores what it
configures in `data/settings.json`; environment variables override it. A
minimal `.env` for households and the apps without the wizard (plus
`JELLYPASS_IMAGE`):

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
and `TMDB_API_KEY`). They send sign-ins, searches and requests only to the
member's household address; artwork (posters, backdrops, logos) loads straight
from TMDB's image server, `image.tmdb.org`, as the
[privacy policy](https://jellypass.app/privacy/) explains. See
[Phone, web and TV apps](https://jellypass.app/docs/apps/).

- **iPhone, iPad and Android** ([`mobile/`](mobile/README.md)): iOS through
  TestFlight for now, Android as a sideloaded APK. Needs JellyPass 3.2.0 or
  later; Cancel request needs 3.5.0 or later.
- **TV add-on** (`TV_ADDON_ENABLED`, per-household admin switches): Discover rows,
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
| Server reference: every setting, Seerr payloads, admin UI, operations (including the deployment self-check and household plugin routes), troubleshooting, admin API, limitations | [docs/server-reference.md](docs/server-reference.md) |
| Household hostnames, household app API and PWA | [docs/household-hosts.md](docs/household-hosts.md) |
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
[SECURITY.md](SECURITY.md). The admin site is on its own listener, private by
default (`127.0.0.1:8788`); it is not otherwise gated, so keep it on the LAN or
behind an access gate.

## Moved sections

The reference that used to be in this README moved to
[docs/server-reference.md](docs/server-reference.md) and
[docs/household-hosts.md](docs/household-hosts.md). Links to its old sections
land here:

- <a name="what-it-does"></a>[What it does](docs/server-reference.md#what-it-does)
- <a name="how-access-enforcement-works"></a>[How access enforcement works](docs/server-reference.md#how-access-enforcement-works)
- <a name="catalog-items-are-not-grants"></a>[Catalog items are not grants](docs/server-reference.md#catalog-items-are-not-grants)
- <a name="household-scoped-request-grants"></a>[Household-scoped request grants](docs/server-reference.md#household-scoped-request-grants)
- <a name="supported-jellyfin-versions"></a>[Supported Jellyfin versions](docs/server-reference.md#supported-jellyfin-versions)
- <a name="quick-start-with-docker-compose"></a>[Quick start with Docker Compose](docs/server-reference.md#quick-start-with-docker-compose)
- <a name="build-locally-instead"></a>[Build locally instead](docs/server-reference.md#build-locally-instead)
- <a name="request-backfill"></a>[Request backfill](docs/server-reference.md#request-backfill)
- <a name="network-addresses"></a>[Network addresses](docs/server-reference.md#network-addresses)
- <a name="running-behind-a-reverse-proxy"></a>[Running behind a reverse proxy](docs/server-reference.md#running-behind-a-reverse-proxy)
- <a name="chains-of-proxies-and-cdns"></a>[Chains of proxies and CDNs](docs/server-reference.md#chains-of-proxies-and-cdns)
- <a name="cdns-and-html-pages"></a>[CDNs and HTML pages](docs/server-reference.md#cdns-and-html-pages)
- <a name="login-lockouts-are-best-effort"></a>[Login lockouts are best-effort](docs/server-reference.md#login-lockouts-are-best-effort)
- <a name="forwarding-to-jellyfin"></a>[Forwarding to Jellyfin](docs/server-reference.md#forwarding-to-jellyfin)
- <a name="configure-seerr"></a>[Configure Seerr](docs/server-reference.md#configure-seerr)
- <a name="administrator-ui"></a>[Administrator UI](docs/server-reference.md#administrator-ui)
- <a name="household-jellyfin-urls"></a>[Household Jellyfin URLs](docs/household-hosts.md#household-addresses)
- <a name="add-to-my-library"></a>Add to my library: removed in 4.0; use **Get this**. See [Upgrade](docs/server-reference.md#upgrade)
- <a name="get-this"></a>[Get this](docs/household-hosts.md#get-this)
- <a name="health-and-logs"></a>[Health and logs](docs/server-reference.md#health-and-logs)
- <a name="administrative-api-examples"></a>[Administrative API examples](docs/server-reference.md#administrative-api-examples)
- <a name="upgrade"></a>[Upgrade](docs/server-reference.md#upgrade)
- <a name="troubleshooting"></a>[Troubleshooting](docs/server-reference.md#troubleshooting)
- <a name="a-new-download-appears-in-library-but-not-grants"></a>[A new download appears in Library but not Grants](docs/server-reference.md#a-new-download-appears-in-library-but-not-grants)
- <a name="webhooks-never-arrive"></a>[Webhooks never arrive](docs/server-reference.md#webhooks-never-arrive)
- <a name="webhook-returns-401"></a>[Webhook returns `401`](docs/server-reference.md#webhook-returns-401)
- <a name="webhook-reports-missing-jellyfin-ids"></a>[Webhook reports missing Jellyfin IDs](docs/server-reference.md#webhook-reports-missing-jellyfin-ids)
- <a name="library-is-empty-or-stale"></a>[Library is empty or stale](docs/server-reference.md#library-is-empty-or-stale)
- <a name="a-household-hostname-returns-404"></a>[A household hostname returns `404`](docs/server-reference.md#a-household-address-returns-421-or-404)
- <a name="a-re-imported-title-is-public-or-a-grant-is-orphaned"></a>[A re-imported title is public or a grant is orphaned](docs/server-reference.md#a-re-imported-title-is-public-or-a-grant-is-orphaned)
- <a name="changes-do-not-reach-every-user"></a>[Changes do not reach every user](docs/server-reference.md#changes-do-not-reach-every-user)
- <a name="api-reference"></a>[API reference](docs/server-reference.md#api-reference)
- <a name="security-and-privacy"></a>[Security and privacy](docs/server-reference.md#security-and-privacy)
- <a name="limitations"></a>[Limitations](docs/server-reference.md#limitations)
- <a name="releases-and-free-distribution"></a>[Releases and free distribution](docs/server-reference.md#releases-and-free-distribution)

## License

[MIT](LICENSE) © 2026 JellyPass contributors.
