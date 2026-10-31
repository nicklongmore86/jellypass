# Reverse proxy recipes

Ready-to-use setups for putting household addresses in front of JellyPass:
[Caddy](#caddy) with DNS-01 certificates, [Cloudflare Tunnel](#cloudflare-tunnel),
[Nginx Proxy Manager](#nginx-proxy-manager) (and plain nginx) and
[Traefik](#traefik). The files are in [`examples/proxy/`](../examples/proxy/).
Every example uses `grove.example.com` and `heath.example.com` as two
households' addresses; replace them with your own names, one per household
(no wildcard DNS record or certificate is needed).

The settings themselves are in the [server reference](server-reference.md):
[Listeners](server-reference.md#listeners),
[Running behind a reverse proxy](server-reference.md#running-behind-a-reverse-proxy)
and [CDNs and HTML pages](server-reference.md#cdns-and-html-pages). Household
addresses are described in [Household addresses](household-hosts.md#household-addresses).

## What every proxy must do

| Requirement | Why |
| --- | --- |
| Route each household address to the **member listener** (`PORT`, default `8787`). Never route a public name to the **admin listener** (`ADMIN_PORT`, default `8788`). | The member listener serves household addresses only. The admin listener serves the admin site, the administrator API, the Seerr webhook and `/metrics`, and is not gated by itself. |
| Pass the client's `Host` on unchanged, exactly once, with no port added (or with the port, if the address has one). | JellyPass picks the household from `Host` alone. A `Host` that is no household's address gets `421` (`unknown_host`); a request that does not name exactly one host gets `400` (`invalid_host`). `X-Forwarded-Host` is never read. |
| Set `X-Forwarded-For` (append the client's address, or replace the header with it) and `X-Forwarded-Proto: https`. Don't pass on a client's own values as if they were yours. | JellyPass takes the client address from `X-Forwarded-For` only when the connecting peer is in `TRUSTED_PROXIES`; it is used for the sign-in rate limits and passed on to Jellyfin. |
| Set `TRUSTED_PROXIES` to the address the proxy connects to JellyPass **from**. | Required while the household gateway is on (startup stops without it). Wrong, and every client looks like the proxy. |
| Pass WebSocket upgrades (Jellyfin's `/socket`). | Remote control, SyncPlay, live updates. |
| Stream responses and request bodies rather than buffering them; pass `Range` requests. | Video playback and seeking. |
| Leave `Cache-Control: no-transform` alone; compression is optional. | JellyPass compresses its HTML pages itself and marks them `no-transform`, so a CDN adds no scripts to them. A proxy may compress other responses, as long as it leaves responses that already have a `Content-Encoding` alone (Caddy's `encode`, Traefik's `compress` and nginx's `gzip` all do). |
| Map each address to its household in JellyPass. | Admin site: **Groups** → **Addresses**, or `PUT /v1/groups/<id>/addresses` on the admin listener. The proxy alone does not make an address a household's. |

Body sizes need no tuning for JellyPass: its own limits are small (a sign-in
body is at most 8 KiB, an administrator API body 64 KiB) and below every
proxy's default.

Keep Jellyfin's own address, if it has a public one, separate from the
household addresses and give it to administrators only: household addresses
refuse administration, and a member who can reach Jellyfin directly bypasses
the household checks. List it in `JELLYFIN_PUBLIC_URLS` so the self-check
reports it.

### Reaching the admin site

None of the examples publishes the admin listener to the internet. Each
publishes it on `127.0.0.1:8788` of the Docker host:

- On the Docker host: `http://127.0.0.1:8788/admin/`.
- From another machine: an SSH tunnel,
  `ssh -L 8788:127.0.0.1:8788 user@docker-host`, then the same URL.
- From your LAN: publish it on the host's private address instead
  (`192.168.1.10:8788:8788` in `ports:`), never on a public one.
- Over HTTPS: a separate proxy host of its own that only your LAN, VPN or an
  identity-aware gate can reach (the Caddy example has a commented
  `admin.example.com` block limited to private addresses; the Cloudflare Tunnel
  example one for use only behind Cloudflare Access).

Seerr's webhook goes to the admin listener over the private network, for
example `http://jellypass:8788/webhooks/seerr`, never through a public name.

### Checking it: the deployment self-check

Once the addresses are mapped, sign in to `/admin/` and choose **Run
self-check** (or `POST /v1/self-check` with the admin token). Its **proxy**
result is the one about the reverse proxy: JellyPass requests each
household's address through the proxy, as a member would, with a one-off
challenge, and counts it only if the request arrived with its `Host`
unchanged, a valid `X-Forwarded-For`, `X-Forwarded-Proto` matching the
address's scheme, and from a peer in `TRUSTED_PROXIES`.

- `pass` (`2 of 2 household addresses completed a self-request…`): the route
  and `TRUSTED_PROXIES` are right.
- `warn` with fewer than all: see [Common failures](#common-failures). The
  self-request comes from inside JellyPass, so JellyPass must be able to
  resolve and reach its own public names: the Caddy and Traefik examples give
  the proxy container those names as network aliases for this; behind a
  Cloudflare Tunnel the request goes out to Cloudflare and back.

The check does not prove that the proxy strips forged headers on every path a
client could take; repeat a sign-in from outside (see
[Common failures](#common-failures)) when you change the proxy.

## Caddy

[`examples/proxy/caddy/`](../examples/proxy/caddy/): JellyPass and Caddy in one
Compose project. Caddy gets its certificates by DNS-01 through Cloudflare's DNS
API, so the certificates need no inbound port 80, and the names can even
resolve to a private address for LAN-only use.

```sh
cd examples/proxy/caddy
cp env.example .env                     # ACME_EMAIL and CLOUDFLARE_API_TOKEN
cp ../../../.env.example jellypass.env  # optional; otherwise the setup wizard
mkdir -m 700 data && sudo chown 1000:1000 data
docker compose up -d --build
```

- **Files.** `Dockerfile` builds Caddy with the
  [`caddy-dns/cloudflare`](https://github.com/caddy-dns/cloudflare) module (stock
  Caddy images have no DNS providers). `Caddyfile` has one site block per
  household address, each `reverse_proxy jellypass:8787`; optional blocks for
  Jellyfin's own address and a LAN-only admin site are commented out.
- **DNS token.** A Cloudflare API token with *Zone → DNS → Edit* on the zone.
  Another DNS provider: build with its module from
  [caddy-dns](https://github.com/caddy-dns) instead and change the `acme_dns`
  line to it (the module's README gives its options).
- **Defaults are enough.** Caddy keeps the client's `Host`, replaces any
  `X-Forwarded-For`/`-Proto`/`-Host` a client sent with its own (no
  `trusted_proxies` is configured), passes WebSockets and streams responses.
  Don't add `header_up Host …`.
- **`TRUSTED_PROXIES`.** Caddy has a fixed address on the Compose network
  (`172.30.87.10`), and `TRUSTED_PROXIES` names it alone. If Docker reports the
  subnet overlaps another network, change the subnet, the address and
  `TRUSTED_PROXIES` together.
- **New household.** Add a site block, add the name to the `aliases` of the
  `caddy` service (for the self-check), point its DNS record at the Docker host,
  `docker compose up -d`, then map it in JellyPass.
- **Cloudflare proxy (orange cloud).** Keep the household records *DNS only*
  with this setup. Proxied through Cloudflare, Caddy's peer is a Cloudflare
  edge server; see [Chains of proxies and CDNs](server-reference.md#chains-of-proxies-and-cdns)
  for what `TRUSTED_PROXIES` then needs, or use a [Cloudflare Tunnel](#cloudflare-tunnel).

## Cloudflare Tunnel

[`examples/proxy/cloudflare-tunnel/`](../examples/proxy/cloudflare-tunnel/):
JellyPass and `cloudflared` in one Compose project. Nothing is published to the
internet; Cloudflare terminates HTTPS with its own certificates (the free
certificate covers one level of subdomain, such as `grove.example.com`).

1. In Cloudflare Zero Trust, **Networks → Tunnels → Create a tunnel**
   (cloudflared), and copy its token into `.env` as `TUNNEL_TOKEN`
   (`cp env.example .env`).
2. Under the tunnel's **Public Hostname**s, add one per household address:
   the hostname, service type **HTTP**, URL **`jellypass:8787`**. Leave
   **HTTP Host Header** empty, so the household's own name reaches JellyPass.
3. `docker compose up -d`, then map each address in JellyPass and run the
   self-check.

A locally-managed tunnel (`cloudflared tunnel create`, a credentials file and
ingress rules) works as well: [`config.yml`](../examples/proxy/cloudflare-tunnel/config.yml)
has the same routes.

- **`TRUSTED_PROXIES`.** The `cloudflared` container's fixed address
  (`172.30.88.10`) alone. Cloudflare's edge puts the visitor's address at the
  end of `X-Forwarded-For` and `cloudflared` passes it on; no Cloudflare ranges
  are needed. `X-Forwarded-Proto` is `https`.
- **The admin listener.** Don't give `jellypass:8788` a public hostname unless
  a Cloudflare Access application covers that hostname and admits your
  administrators only. Even then, keep Seerr's webhook on the private network.
- **Nothing in front of household hostnames.** Cloudflare Access, *Under Attack*
  mode or challenge pages on a household hostname stop the Jellyfin apps, the
  JellyPass mobile app and TVs, which cannot answer them, and the self-check.
- **Web Analytics and other page changes.** Cloudflare's automatic Web
  Analytics setup adds a script to every proxied HTML page; JellyPass marks its
  pages `no-transform`, so Cloudflare leaves them alone, and compresses them
  itself (see [CDNs and HTML pages](server-reference.md#cdns-and-html-pages)).
  Don't add a Transform Rule that removes `no-transform`.
- **WebSockets** are on by default for Cloudflare zones (**Network →
  WebSockets**); keep them on.
- **Video through Cloudflare.** Streaming goes through Cloudflare's network;
  check Cloudflare's service terms for your plan before relying on it for video.

## Nginx Proxy Manager

[`examples/proxy/nginx-proxy-manager/`](../examples/proxy/nginx-proxy-manager/).
One proxy host per household address (or one host listing several addresses
of the same JellyPass):

| Tab | Setting |
| --- | --- |
| Details | **Domain Names** `grove.example.com`; **Scheme** `http`; **Forward Hostname / IP** `jellypass` (or the Docker host's address); **Forward Port** `8787`; **Websockets Support** on; **Cache Assets** off |
| SSL | A Let's Encrypt certificate (**Use a DNS Challenge** if the host is not reachable on port 80); **Force SSL** on |
| Advanced | The contents of [`advanced.conf`](../examples/proxy/nginx-proxy-manager/advanced.conf): `proxy_buffering off;` and `proxy_request_buffering off;` |

NPM's proxy hosts already send `Host $host`, `X-Forwarded-For` with the client
appended, `X-Forwarded-Proto $scheme` and, with **Websockets Support** on, the
WebSocket headers. Don't add a `location /` in **Advanced**: it replaces NPM's
own, and those headers with it.

**`TRUSTED_PROXIES`** is the address NPM connects to JellyPass from:

- NPM and JellyPass on one Docker network: give NPM a fixed address on it and
  name that address. For example, in NPM's Compose file:

  ```yaml
  services:
    npm:
      networks:
        proxy:
          ipv4_address: 172.30.90.10
  networks:
    proxy:
      external: true   # created once: docker network create --subnet 172.30.90.0/24 proxy
  ```

  with JellyPass on the same `proxy` network and `TRUSTED_PROXIES=172.30.90.10`.
- NPM on another machine: that machine's LAN address, with JellyPass's
  `8787` published on a private address only that machine can reach.
- NPM on the Docker host connecting to a published port: usually the Docker
  network's gateway address
  (`docker network inspect <network> --format '{{(index .IPAM.Config 0).Gateway}}'`).
  The self-check tells you whether it is right.

For the self-check, JellyPass must reach NPM by the household names: add them
as network aliases of the NPM container (as the Caddy example does), or make
sure the Docker host's DNS and hairpin NAT send them back to NPM.

**Plain nginx or SWAG.** [`nginx.conf`](../examples/proxy/nginx-proxy-manager/nginx.conf)
is the same proxy as a server block: `proxy_set_header Host $host`,
`X-Forwarded-For $proxy_add_x_forwarded_for`, `X-Forwarded-Proto $scheme`, the
`Upgrade`/`Connection` pair with `proxy_http_version 1.1`, and buffering off.
`$host` has no port: on a port other than 443, for an address that carries
that port, use `$http_host`. nginx stops at startup with
`host not found in upstream "jellypass"` when that name does not resolve yet;
start it after JellyPass.

## Traefik

[`examples/proxy/traefik/`](../examples/proxy/traefik/): JellyPass and Traefik
in one Compose project, certificates by DNS-01 through Cloudflare
(`CF_DNS_API_TOKEN` in `.env`; other providers in Traefik's
[ACME provider list](https://doc.traefik.io/traefik/https/acme/#providers)).

- `traefik.yml` (static): the `web` and `websecure` entry points and the
  `letsencrypt` resolver. No `forwardedHeaders.trustedIPs`, so Traefik replaces
  any `X-Forwarded-*` a client sent with its own.
- `dynamic.yml` (file provider): one router per household address, each a
  `Host` rule on `websecure` to the `jellypass-member` service at
  `http://jellypass:8787`, with `passHostHeader: true` (Traefik's default).
- Docker labels instead of the file: the equivalent labels are commented in
  `compose.yaml`; enable the `docker` provider and mount the Docker socket.
  Use one or the other for the same names. With JellyPass on more than one
  network, add `traefik.docker.network`.
- Leave out the `compress` middleware for these routers (JellyPass compresses
  its pages) and any `headers` middleware that sets `Host` or
  `X-Forwarded-Host`.
- **`TRUSTED_PROXIES`.** Traefik's fixed address (`172.30.89.10`) alone. As
  with Caddy, the household names are network aliases of the Traefik container
  for the self-check, and with Cloudflare's proxy in front see
  [Chains of proxies and CDNs](server-reference.md#chains-of-proxies-and-cdns).

## Common failures

| Symptom | Likely cause |
| --- | --- |
| `421 {"error":"unknown_host"}` on a household address | The address is not mapped to a household in JellyPass, or not exactly as the browser sends it (another subdomain, a port). Or the proxy changed `Host`: NPM's forward host used as `Host`, cloudflared's **HTTP Host Header** set, Traefik's `passHostHeader: false`, Caddy's `header_up Host`, nginx's `$host` dropping a non-default port. Also the answer to any request sent straight to `:8787` by IP. See [A household address returns `421` or `404`](server-reference.md#a-household-address-returns-421-or-404). |
| `400 {"error":"invalid_host"}` | The request named more than one host: two `Host` headers (a middleware or custom header rule adding one), a `Host` with a path or userinfo, or an absolute-form target (`GET http://other/…`) whose authority is not the `Host`. |
| `421` for the admin site or the Seerr webhook | They were pointed at the member listener (`8787`); they are on the admin listener (`8788`). |
| JellyPass stops at startup with `TRUSTED_PROXIES is required` | The household gateway is on and `TRUSTED_PROXIES` is empty. Set it to the proxy's address. |
| Self-check **proxy** warns `0 of N` | `TRUSTED_PROXIES` is not the address the proxy connects from; the proxy does not send `X-Forwarded-Proto: https` (for example a plain-HTTP hop that reports `http`); the proxy changes `Host`; or JellyPass cannot reach its own public names (missing network aliases, no hairpin NAT, split DNS). |
| One person's failed sign-ins lock everyone out (`429 too_many_login_attempts` for all) | `TRUSTED_PROXIES` does not name the proxy, so every client is counted as the proxy's address. |
| Jellyfin's dashboard shows JellyPass's or the proxy's address for every client | Jellyfin's **Known proxies** (Dashboard → Networking) must list JellyPass and the proxy; see [Forwarding to Jellyfin](server-reference.md#forwarding-to-jellyfin). With a CDN in front, see [Chains of proxies and CDNs](server-reference.md#chains-of-proxies-and-cdns). |
| Jellyfin web keeps reconnecting; remote control, SyncPlay or live updates fail | WebSocket upgrades are not passed: NPM's **Websockets Support** off, nginx without the `Upgrade`/`Connection` headers and `proxy_http_version 1.1`, Cloudflare's WebSockets switch off. A `401` on the upgrade itself is JellyPass refusing a token that is not this household's member's, and `404` an upgrade on a path other than `/socket`. |
| Video stalls, or seeking restarts playback | Response buffering or caching on the proxy (`proxy_buffering`, NPM's **Cache Assets**), or `Range` headers stripped. |
| `502` from the proxy | The upstream is wrong (`jellypass:8787` from the proxy's network) or JellyPass is not running; nginx's `host not found in upstream`. |
| An analytics script appears in household pages, or they arrive uncompressed | Something between JellyPass and the browser removed `no-transform` from `Cache-Control`. |

To check `X-Forwarded-For` handling from outside, sign in to a household
address with a wrong password from one network and check that a member on
another network can still sign in at once.
