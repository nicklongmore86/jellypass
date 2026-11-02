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
| Serve household addresses over HTTPS only: redirect plain `http://` to `https://` at the proxy, before anything reaches JellyPass. | Members' passwords and tokens travel in sign-ins and requests. JellyPass cannot tell a plain-HTTP visitor from an HTTPS one except by what the proxy reports. Caddy redirects by itself; the Traefik and nginx examples include the redirect; in NPM turn on **Force SSL**; behind Cloudflare turn on **Always Use HTTPS** (see [Cloudflare Tunnel](#cloudflare-tunnel)). |
| Set `X-Forwarded-For` (append the client's address, or replace the header with it) and `X-Forwarded-Proto: https`. Don't pass on a client's own values as if they were yours. | JellyPass takes the client address from `X-Forwarded-For` only when the connecting peer is in `TRUSTED_PROXIES`; it is used for the sign-in rate limits and passed on to Jellyfin. |
| Set `TRUSTED_PROXIES` to the address the proxy connects to JellyPass **from**. | Required while the household gateway is on (startup stops without it). Wrong, and every client looks like the proxy. |
| Pass WebSocket upgrades (Jellyfin's `/socket`). | Remote control, SyncPlay, live updates. |
| Stream responses and request bodies rather than buffering them; pass `Range` requests. | Video playback and seeking. |
| Leave `Cache-Control: no-transform` alone; compression is optional. | JellyPass compresses its HTML pages itself and marks them `no-transform`, so a CDN adds no scripts to them. A proxy may compress other responses, as long as it leaves responses that already have a `Content-Encoding` alone (Caddy's `encode`, Traefik's `compress` and nginx's `gzip` all do). |
| Map each address to its household in JellyPass. | Admin site: **Groups** → **Addresses**, or `PUT /v1/groups/<id>/addresses` on the admin listener. The proxy alone does not make an address a household's. |

### Request sizes and timeouts

JellyPass reads only a few request bodies itself, each with a small limit of
its own: a household sign-in, sign-out or SyncPlay join at most 8 KiB (a
sign-in over it is answered `400` `invalid_request`, a sign-out or SyncPlay
join `413` `request_too_large`), a household app "Get this" request 1 KiB, an
administrator API body 64 KiB. Every other request on a household address,
uploads included, is streamed on to Jellyfin as it arrives, with no size limit
from JellyPass; what limits it is the proxy and Jellyfin. Stock nginx's
`client_max_body_size` defaults to 1 MB and answers `413` itself; Nginx Proxy
Manager sets it to 2000 MB for every proxy host
([v2.12.6 `nginx.conf`](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/v2.12.6/docker/rootfs/etc/nginx/nginx.conf)),
so lower it there only if you want a smaller cap. Caddy and Traefik set no
size limit; Cloudflare limits uploads per plan, 100 MB on the Free plan.

Timeouts that apply on the way:

| Where | Limit |
| --- | --- |
| JellyPass, both listeners (Node's HTTP server defaults) | A request's headers must arrive within 60 s, and the whole request, body included, within 5 minutes (`408` otherwise), so one upload that takes longer fails whatever the proxy allows. An idle keep-alive connection from the proxy is closed after 5 s. Responses (video, downloads, HLS) have no time limit. |
| JellyPass, household WebSockets | Closed after `WS_IDLE_TIMEOUT_MS` (default 5 minutes) with no bytes either way, or `WS_UPSTREAM_IDLE_TIMEOUT_MS` (default 3 minutes) with none from Jellyfin. Jellyfin's keepalives (every 30 s or so) keep a healthy socket from ever reaching either. |
| nginx | `proxy_read_timeout` and `proxy_send_timeout` default to 60 s between two reads or writes, about Jellyfin's keepalive window and short for a stream that pauses while transcoding. The example sets both to 1 hour, so nginx is never the first to close a quiet WebSocket or a paused stream. |
| Nginx Proxy Manager | Sets both to 90 s for every proxy host (v2.12.6); still short for a paused stream, so the example's **Advanced** snippet raises both to 1 hour as well. |
| Traefik | Traefik 3 reads a whole request within 60 s by default (`respondingTimeouts.readTimeout`); the example raises it to 5 minutes to match JellyPass for uploads. |
| Caddy | No read, write or stream limit by default. |
| Cloudflare | `524` if the origin sends nothing for 125 s, the proxy read timeout in Cloudflare's [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) (Enterprise zones can change it). A stream or WebSocket that keeps sending stays open in practice, but Cloudflare does not promise that a long one is never cut: its [WebSocket documentation](https://developers.cloudflare.com/network/websockets/) notes that its deployments can end WebSocket connections, so clients should be ready to reconnect. |

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
client could take; run the [checks from outside](#checking-client-addresses-from-outside)
when you set the proxy up and whenever you change it.

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
- **DNS token.** A Cloudflare API token (**My Profile → API Tokens → Create
  Token**) with two permissions, *Zone → Zone → Read* and *Zone → DNS → Edit*,
  and **Zone Resources** limited to the zone the household names are in. The
  Traefik example takes the same token.
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
4. **Make Cloudflare redirect plain HTTP.** A tunnel passes on whatever
   protocol the visitor used: without a redirect, `http://grove.example.com/`
   reaches JellyPass unencrypted between the visitor and Cloudflare, sign-ins
   included. In the zone's **SSL/TLS → Edge Certificates**, turn on **Always
   Use HTTPS** (it covers every hostname in the zone). If you can't turn it on
   for the whole zone, add a redirect rule (**Rules → Redirect Rules**) that
   sends `http` requests for every household hostname to `https`.
5. **Check it from outside your network:**

   ```sh
   curl -sI http://grove.example.com/web/
   ```

   It must answer `301` (or `308`) with `Location: https://grove.example.com/web/`.
   As a sanity check that the redirect came from Cloudflare and not from
   behind the tunnel, look for no JellyPass or Jellyfin headers (no
   `Cache-Control: no-transform`); `Server: cloudflare` alone proves nothing,
   since Cloudflare sets it on every proxied response. Repeat it for each
   household hostname.

A locally-managed tunnel (`cloudflared tunnel create`, a credentials file and
ingress rules) works as well: [`config.yml`](../examples/proxy/cloudflare-tunnel/config.yml)
has the same routes.

- **`TRUSTED_PROXIES`.** The `cloudflared` container's fixed address
  (`172.30.88.10`) alone. Cloudflare's edge puts the visitor's address at the
  end of `X-Forwarded-For` and `cloudflared` passes it on; no Cloudflare ranges
  are needed. `X-Forwarded-Proto` is the protocol the visitor used to reach
  Cloudflare (`http` or `https`), which is why step 4 matters: with **Always Use
  HTTPS** on, only `https` requests get through to the tunnel.
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
| Advanced | The contents of [`advanced.conf`](../examples/proxy/nginx-proxy-manager/advanced.conf): buffering off (`proxy_buffering`, `proxy_request_buffering`) and 1-hour `proxy_read_timeout`/`proxy_send_timeout` (see [Request sizes and timeouts](#request-sizes-and-timeouts)) |

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
`Upgrade`/`Connection` pair with `proxy_http_version 1.1`, buffering off,
1-hour read and send timeouts, and a port-80 server that redirects to HTTPS.
Uncomment `client_max_body_size` if members upload files over 1 MB.
`$host` has no port: on a port other than 443, for an address that carries
that port, use `$http_host`. nginx stops at startup with
`host not found in upstream "jellypass"` when that name does not resolve yet;
start it after JellyPass.

## Traefik

[`examples/proxy/traefik/`](../examples/proxy/traefik/): JellyPass and Traefik
in one Compose project, certificates by DNS-01 through Cloudflare
(`CF_DNS_API_TOKEN` in `.env`: the token described under [Caddy](#caddy),
*Zone → Zone → Read* and *Zone → DNS → Edit* on the zone; other providers in Traefik's
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
| `http://` on a household address loads a page (or reaches JellyPass) instead of redirecting | The proxy or Cloudflare does not redirect plain HTTP: Caddy's automatic redirect turned off, no `web` → `websecure` redirect in Traefik, no port-80 redirect server in nginx, NPM's **Force SSL** off, Cloudflare's **Always Use HTTPS** off. Sign-ins over it are unencrypted. |
| `421` for the admin site or the Seerr webhook | They were pointed at the member listener (`8787`); they are on the admin listener (`8788`). |
| JellyPass stops at startup with `TRUSTED_PROXIES is required` | The household gateway is on and `TRUSTED_PROXIES` is empty. Set it to the proxy's address. |
| Self-check **proxy** warns `0 of N` | `TRUSTED_PROXIES` is not the address the proxy connects from; the proxy does not send `X-Forwarded-Proto: https` (for example a plain-HTTP hop that reports `http`); the proxy changes `Host`; or JellyPass cannot reach its own public names (missing network aliases, no hairpin NAT, split DNS). |
| One person's failed sign-ins lock everyone out (`429 too_many_login_attempts` for all) | `TRUSTED_PROXIES` does not name the proxy, so every client is counted as the proxy's address. |
| Jellyfin's dashboard shows JellyPass's or the proxy's address for every client | Jellyfin's **Known proxies** (Dashboard → Networking) must list JellyPass and the proxy; see [Forwarding to Jellyfin](server-reference.md#forwarding-to-jellyfin). With a CDN in front, see [Chains of proxies and CDNs](server-reference.md#chains-of-proxies-and-cdns). |
| Jellyfin web keeps reconnecting; remote control, SyncPlay or live updates fail | WebSocket upgrades are not passed: NPM's **Websockets Support** off, nginx without the `Upgrade`/`Connection` headers and `proxy_http_version 1.1`, Cloudflare's WebSockets switch off. A `401` on the upgrade itself is JellyPass refusing a token that is not this household's member's, and `404` an upgrade on a path other than `/socket`. |
| Video stalls, or seeking restarts playback | Response buffering or caching on the proxy (`proxy_buffering`, NPM's **Cache Assets**), or `Range` headers stripped. |
| `502` from the proxy | The upstream is wrong (`jellypass:8787` from the proxy's network) or JellyPass is not running; nginx's `host not found in upstream`. |
| An analytics script appears in household pages, or they arrive uncompressed | Something between JellyPass and the browser removed `no-transform` from `Cache-Control`. |

## Checking client addresses from outside

The self-check runs from inside; these two checks run from outside and show
that JellyPass sees each client's real address and that a client cannot choose
its own. They use the household sign-in limit: 20 sign-in attempts from one
client address within 5 minutes, after which that address gets
`429 {"error":"too_many_login_attempts"}` (on every household address) until
the 5 minutes since its first attempt are up. Use two networks you control,
such as your home connection (network A) and a phone on mobile data
(network B), and a household address you can afford to lock for 5 minutes.
The sign-in request:

```sh
signin() {
  curl -s -o /dev/null -w '%{http_code}\n' "$@" \
    -H 'Authorization: MediaBrowser Client="check", Device="curl", DeviceId="proxy-check", Version="1"' \
    -H 'Content-Type: application/json' \
    -d '{"Username":"nobody","Pw":"wrong"}' \
    https://grove.example.com/Users/AuthenticateByName
}
```

**1. One network's failures don't lock another network out.** On network A,
run `for i in $(seq 21); do signin; done`: the answers are `401` (each after
about a second) and then `429`. Within the next 5 minutes, on network B, run
`signin` once: it must answer `401`, not `429`, and a member signing in there
works. A `429` on network B means JellyPass counts both networks as one
address, the proxy's: `TRUSTED_PROXIES` does not name the proxy, or a CDN in
front is not accounted for (see [Chains of proxies and CDNs](server-reference.md#chains-of-proxies-and-cdns)).

**2. A forged `X-Forwarded-For` is not believed.** After the first check's
5 minutes have passed, on network B, send the 21 attempts with a different
forged address each time:
`for i in $(seq 21); do signin -H "X-Forwarded-For: 198.51.100.$i"; done`.
The last must answer `429`, and a plain `signin` from network B afterwards
must too: every attempt was counted against network B's real address. If they
keep answering `401`, the proxy hands the client's own `X-Forwarded-For` on as
if it were the client's address (a proxy, or a proxy in front of it, listed in
`TRUSTED_PROXIES` that passes the header through instead of appending to it or
replacing it). Wait 5 minutes afterwards before members on network B sign in.
