# Reverse proxy examples

Working setups for serving household addresses through a reverse proxy. The
guide, with what `TRUSTED_PROXIES` must be for each and how to check it with the
admin site's self-check, is [docs/reverse-proxy.md](../../docs/reverse-proxy.md).

| Directory | What it is |
| --- | --- |
| [`caddy/`](caddy/) | JellyPass + Caddy in one Compose project; certificates by DNS-01 (Cloudflare DNS module, custom Caddy build) |
| [`cloudflare-tunnel/`](cloudflare-tunnel/) | JellyPass + `cloudflared`; dashboard-managed tunnel by token, or `config.yml` for a locally-managed one |
| [`nginx-proxy-manager/`](nginx-proxy-manager/) | The **Advanced** snippet for Nginx Proxy Manager, and the same proxy as a plain nginx server block |
| [`traefik/`](traefik/) | JellyPass + Traefik; DNS-01, routers in a file provider (labels commented in `compose.yaml`) |

Every example routes household addresses (`grove.example.com`,
`heath.example.com`) to the member listener `jellypass:8787` and keeps the
admin listener (`8788`) on `127.0.0.1` of the Docker host. Secrets go in a
`.env` you create from `env.example`; JellyPass's own settings in
`jellypass.env` or the setup wizard.
