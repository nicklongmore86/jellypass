# Caddy with the Cloudflare DNS plugin, for DNS-01 certificates (no inbound port 80 needed for ACME).
# Another DNS provider: replace the module with its caddy-dns package (https://github.com/caddy-dns) and change
# `acme_dns` in the Caddyfile to match. Pin a plugin version (module@vX.Y.Z) for repeatable builds.
FROM caddy:2.10-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.10
COPY --from=build /usr/bin/caddy /usr/bin/caddy
