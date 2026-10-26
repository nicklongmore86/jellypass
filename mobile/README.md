# JellyPass mobile app

The household app for iPhone, iPad and Android, built with [Expo](https://expo.dev) (React Native, SDK 58),
TypeScript (strict) and Expo Router. It talks to a household's JellyPass server through the same
`/jellypass/app/v1` API as the PWA, and wears the same Tidepool look: its theme in `src/theme` is ported from
`app/static/app.css`.

**This is a scaffold.** It shows one placeholder screen and makes no network calls. The API client and sign-in
come next (see [What's next](#whats-next)).

`mobile/` is separate from the server: it has its own `package.json` and `pnpm-lock.yaml`, it is excluded from
the Docker build context (`.dockerignore`), and the root `pnpm check`, `pnpm test` and temp-leak check never look
at it. Its CI is `.github/workflows/mobile.yaml`, which runs only when `mobile/` (or `app/static/app.css`) changes.

## Never ship a household list

The app must never contain a list of households, server addresses, user names or anything else that identifies
a JellyPass install: not in the code, not in config, not as defaults, examples or test fixtures (use
`example.test` addresses). A member gives the app their own household's address (pasted, or from a
`jellypass://` link the household hands out) at sign-in. `__tests__/app-config.test.ts` checks the app config
contains no URL.

## Run the tests on Linux

Node 22 or later and pnpm (the version in `packageManager`, via `corepack enable`).

```sh
cd mobile
pnpm install --frozen-lockfile
pnpm typecheck   # tsc --noEmit, strict
pnpm lint        # expo lint (ESLint), no warnings allowed
pnpm test        # Jest (jest-expo)
pnpm check       # all three
```

The Jest suites check the theme's colour contrast (the same pairs and thresholds as the PWA's
`test/app-pwa.test.mjs`), that every colour token still matches `app/static/app.css`, and the app config's
promises (iPad support, placeholder ids, no update service or analytics).

## Run it on a phone with Expo Go

1. Install **Expo Go** from the App Store or Google Play.
2. On the dev box: `cd mobile && pnpm start` (add `--tunnel` if the phone isn't on the same network).
3. Scan the QR code: with the Camera app on iPhone, or from inside Expo Go on Android.

Edits reload on the phone as you save. Expo Go needs no Apple or Google developer account.

## Privacy: no telemetry, no update service

- No analytics, crash-reporting or tracking SDKs. `__tests__/app-config.test.ts` fails if one is added.
- No over-the-air updates: `expo-updates` is not installed and `updates.enabled` is `false`, so a built app
  never checks Expo's servers at launch.
- Expo's **CLI** (`expo start`, `expo lint`) sends anonymous usage telemetry by default. CI sets
  `EXPO_NO_TELEMETRY=1`; set it in your shell too (`export EXPO_NO_TELEMETRY=1`).

## App identity: placeholders to confirm

| | Value | Status |
|---|---|---|
| Name | JellyPass | Keep "Jellyfin" out of the name |
| iOS bundle id | `io.starrgroup.jellypass` | **Placeholder.** Confirm before the first EAS build: it can't change once in TestFlight |
| Android package | `io.starrgroup.jellypass` | **Placeholder.** Same: it can't change once on Play |
| Icon | `assets/icon.png`, `assets/adaptive-icon.png` | Placeholder: the PWA's 512 px icon. The App Store needs 1024 px: draw one with `draw(1024)` from `scripts/make-app-icons.py` before submitting |
| Orientation | Portrait on phones; all four on iPad | iPad multitasking requires all four |
| URL scheme | `jellypass://` | For the connect link in the sign-in PR |

## What's next

1. **API client**: absolute household URL, `MediaBrowser Token` auth, fixed error kinds, `AbortSignal`, DTO
   types from the server's schema, the image-URL allowlist, and contract tests against the server's JSON
   fixtures.
2. **Sign-in**: the address step (paste or `jellypass://connect` link), profile picker, password, the token in
   `expo-secure-store` (iOS Keychain / Android Keystore, this-device-only), and sign-out.
3. **Screens**: tab bar (Home, Search, My requests, Account), Home with its rows and hero, network and studio
   pages, Search, movie/series/season pages with **Get this**, My requests, then an accessibility pass.
4. **Play**: an in-app Jellyfin web view, optionally a Swiftfin hand-off.
5. **Builds**: `eas.json` profiles and EAS Build in the cloud (no Mac needed): `eas build --platform ios
   --auto-submit` to TestFlight, and `eas build --platform android` for an APK or Play internal testing. These
   need an Expo account, an Apple Developer membership and a Google Play Console account.
