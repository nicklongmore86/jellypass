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
  Seerr versions, deployment method, relevant redacted logs, expected
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
Jellyfin or Seerr credentials.

`pnpm test:real` runs `test/real-jellyfin.test.mjs` against a real Jellyfin, once
for each supported release. It needs Docker: it starts a throwaway container of
each image `scripts/jellyfin-versions.json` pins (the same images as CI) on
`127.0.0.1:18096`, one after the other, and removes it afterwards. Set
`JELLYFIN_IMAGE` and `JELLYFIN_REAL_VERSION` to run one image only, or
`JELLYFIN_REAL_URL` to use another fresh, unconfigured Jellyfin instead. When
the supported releases change, update `SUPPORTED_JELLYFIN_RELEASES` in
`src/jellyfin-version.ts`, `scripts/jellyfin-versions.json` and the
`jellyfin-integration` matrices in both workflows together;
`test/jellyfin-version.test.mjs` fails until they agree. `pnpm test:all`
runs both suites. CI and the release workflow run both, so run `pnpm test:all`
before opening a pull request that touches webhooks, grants, or the Jellyfin
client.

`pnpm test:seerr` runs `test/real-seerr.test.mjs` against a throwaway
`ghcr.io/seerr-team/seerr:v3.5.1` container on `127.0.0.1:15055` (set
`SEERR_PORT` to change it), seeded with an owner and a member account, and
removes it afterwards. It needs Docker but no media server or network access,
and checks that the acting-user Seerr client never runs a call as Seerr's
owner. CI runs it too; run it before opening a pull request that touches
`src/seerr.ts` or `src/seerr-users.ts`.

## Pull requests

1. Fork the repository and create a focused branch from `main`.
2. Keep unrelated formatting or refactoring out of the change.
3. Add or update tests for behavior changes.
4. Update README or operational documentation when configuration, API behavior,
   security boundaries, or deployment steps change.
5. Run `pnpm check`, `pnpm test:all`, `pnpm build`, and `docker build .`.
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

## Private identifier guard

`pnpm test` scans all tracked files when a private deny-list is available. Set
`JELLYPASS_PRIVATE_DENYLIST` to an external UTF-8 file, or use the gitignored
`.private-denylist.txt` at the repository root. Use one literal identifier per
line; blank lines and lines beginning with `#` are ignored. Matching is case
insensitive. Never commit the list or include its values in reports.

```sh
JELLYPASS_PRIVATE_DENYLIST=/path/to/private-list.txt pnpm test
```

Without a list, the guard and private release-note sub-check visibly skip;
generic release-note checks still run. CI maintainers should supply the file
through private runner configuration and set the environment variable to its
path. An explicitly configured unreadable or empty list fails the tests.
