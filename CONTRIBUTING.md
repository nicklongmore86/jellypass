# Contributing to JellyPass

Thanks for helping improve JellyPass. Bug reports, documentation fixes, tests,
and focused code changes are welcome.

## Before opening an issue

- Search existing issues and discussions.
- Do not include API keys, tokens, passwords, private hostnames, media-library
  exports, or an unredacted `grants.json` file.
- Use GitHub's private vulnerability-reporting flow for security issues; see
  [SECURITY.md](SECURITY.md).
- For a bug, include the JellyPass revision or container tag, Jellyfin and
  Jellyseerr versions, deployment method, relevant redacted logs, expected
  behavior, and actual behavior.

## Development setup

JellyPass requires Node.js 22+ and the pnpm version declared in `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

The normal test suite uses local mock HTTP services and does not require live
Jellyfin or Jellyseerr credentials.

## Pull requests

1. Fork the repository and create a focused branch from `main`.
2. Keep unrelated formatting or refactoring out of the change.
3. Add or update tests for behavior changes.
4. Update README or operational documentation when configuration, API behavior,
   security boundaries, or deployment steps change.
5. Run `pnpm check`, `pnpm test`, `pnpm build`, and `docker build .`.
6. Explain user-visible behavior, operational impact, migration needs, and how
   the change was verified in the pull request.

By submitting a contribution, you agree that it may be distributed under the
repository's [MIT License](LICENSE).

## Release process

Maintainers create releases from a clean, tested `main` branch:

1. Update the version in `package.json` and `pnpm-lock.yaml`.
2. Review user-facing documentation and compatibility notes.
3. Run the complete validation commands above.
4. Create and push an annotated semantic-version tag, for example `v0.3.0`.
5. Verify the GitHub Release and GHCR multi-architecture image.
6. Keep the previous image tag available for rollback.

Do not move or overwrite published version tags.
