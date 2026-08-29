# Security policy

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** flow. Do not open a public issue for an unpatched vulnerability.

The bridge requires a Jellyfin administrator API key because Jellyfin restricts item metadata and user policy updates to administrators. Keep the service on a trusted network, use different long random values for `WEBHOOK_TOKEN` and `ADMIN_TOKEN`, and expose only the webhook endpoint through a TLS reverse proxy if Seerr is on another network. `ADMIN_TOKEN` protects grant inspection, dry runs, group management, revocation, reconciliation, and metrics. It falls back to `WEBHOOK_TOKEN` only for backward compatibility.

The service never logs the Jellyfin API key or webhook token. Its state file contains Jellyfin user and media identifiers and is created with owner-only permissions where the host filesystem supports them.
