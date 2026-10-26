# JellyPass mobile app

The household app for iPhone, iPad and Android, built with [Expo](https://expo.dev) (React Native, SDK 58),
TypeScript (strict) and Expo Router. It talks to a household's JellyPass server through the same
`/jellypass/app/v1` API as the PWA, and wears the same Tidepool look: its theme in `src/theme` is ported from
`app/static/app.css`.

**Sign-in works; the screens come next.** The app connects to a household address, signs a member in, keeps the
sign-in in the device's credential store and signs out. Once signed in it shows a placeholder with the member's
name and household; Home, Search and the rest come next (see [What's next](#whats-next)).

`mobile/` is separate from the server: it has its own `package.json` and `pnpm-lock.yaml`, it is excluded from
the Docker build context (`.dockerignore`), and the root `pnpm check`, `pnpm test` and temp-leak check never look
at it. Its CI is `.github/workflows/mobile.yaml`, which runs only when `mobile/`, `app/static/app.css` or `docs/app-api/` changes.

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

The Jest suites check sign-in (below), the API client against the server's contract (below), the theme's colour contrast (the same pairs and thresholds as the PWA's
`test/app-pwa.test.mjs`), that every colour token still matches `app/static/app.css`, and the app config's
promises (the final ids, the Expo owner, rotation, no update service or analytics). No test makes a network call.

## Sign-in (`src/signin`, `src/session`, `src/screens`)

The PWA's sign-in (`app/src/signin.ts`) with an address step in front, as `docs/app-design.md` ("Native clients
(contract)") asks. One household at a time; changing household signs out first.

1. **Address.** The member types or pastes their household's address (`https://` is added if left off), or opens a
   setup link, `jellypass://connect?address=https://jelly-<household>.<domain>` (the `jellypass` scheme,
   `src/app/connect.tsx`). Both go through `parseHouseholdAddress`. A link is only ever an offer: the app shows the
   address and asks before using it (and, when signed in elsewhere, says Continue signs out first), and even then it
   only opens the profile picker. A link never signs anyone in, and carries only the address. The app suggests no
   address and has no list of households.
2. **Profiles.** `GET /Users/Public` on that address: the gateway lists only the household's visible members and marks
   passwordless ones. Each is a button with their initials; a passwordless member signs in with one tap (and gets the
   password step if that is refused), the others get a password step, and **Sign in with a different name** is always
   there for hidden members (and is the first screen when the list is empty).
3. **Sign-in** is by name only, `POST /Users/AuthenticateByName` with `{"Username","Pw"}` and
   `Authorization: MediaBrowser Client="JellyPass iOS|Android", Device="<model>", DeviceId="<random, kept>", Version`.
   Never `POST /Users/{id}/Authenticate`. The password is only in that request body: the field is emptied as it is
   read, and nothing keeps or logs it.
4. **Failures** have the PWA's fixed wording, which never says whether a name exists: 401/403 "That didn't work", 429
   "Too many attempts", anything else (400, 502, ...) "Can't sign in right now", no answer "Check your connection". Two
   are the app's own: an address no household has (`404 household_not_found` on the profile list) and a sign-in the
   device cannot keep (the token is then revoked). A 429 with `Retry-After` holds the buttons that would try again for
   that long; the app never retries by itself. The gateway answers a refusal no sooner than a second after it arrived,
   so the button just shows "Signing in…" meanwhile.
5. **Storage** (`src/session/store.ts`) is `expo-secure-store` only: the iOS Keychain with
   `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (never synced or moved to another device), and on Android values encrypted with a
   Keystore key, with Android backup off (`allowBackup: false`). One item holds the address, token, user ID and name,
   nothing else; a second holds the random device ID, made once with `expo-crypto`. Nothing goes to AsyncStorage,
   files or logs.
6. **At start** a kept sign-in is checked with `GET /jellypass/app/v1/me`: a 401 deletes it and shows the picker
   ("Your sign-in has expired"); no answer, a 429 or a 502 keeps it and offers **Try again** or **Sign out**.
7. **Sign-out** sends `POST /Sessions/Logout` with the token (best effort, five seconds; the gateway forgets the session
   at once), then deletes the sign-in from the device whatever came of that.

The signed-in placeholder shows "name · household" from `/me`, **Sign out** and **Change household**.

**Orientation.** Phones are portrait and tablets turn: iOS from Info.plist (iPhone portrait, iPad all four), and an
Android phone is locked to portrait at launch with `expo-screen-orientation` when `expo-device` says it is a phone
(`src/orientation.ts`). Android tablets, and devices of unknown type, turn freely.

**Tests.** `signin-api.test.ts` (what each call sends, every status, Retry-After, sign-out never failing and its
five-second limit), `signin-flow.test.tsx` (the screens through React Native Testing Library: the address step, link
confirmation, the picker, one tap, the password and name steps, every failure's wording, Retry-After holding the
buttons, the start-up check and its 401, sign-out clearing the device even offline, no token or password in any log),
`connect-route.test.tsx`, `session-store.test.ts`, `address-input.test.ts`, `identity.test.ts`, `orientation.test.ts`,
`wording.test.ts` (the PWA's wording, word for word) and `no-logging.test.ts`. The credential store is the in-memory
mock in `__mocks__/expo-secure-store.ts`. The UI tests only ever use RNTL's `queryAll*` queries through the helpers in
`__tests__/support/household.ts`, so a failure never prints the component tree.

## The API client (`src/api`)

`createApiClient({ address, token })` talks to one household's `/jellypass/app/v1` API, as
`docs/app-design.md` ("Native clients (contract)") asks:

- **One address.** `parseHouseholdAddress` takes `https://jelly-<household>.<domain>` (lower-cased; no port,
  path, query or credentials) and nothing else, and every call is an absolute URL on it. There is no household
  list. Parsed by hand: React Native's `URL` has no `hostname`.
- **Headers.** `Authorization: MediaBrowser Token="<token>"` and `Accept: application/json` (plus
  `Content-Type` on a POST), `credentials: 'omit'`, and nothing else. No `cache` option, because React Native's
  fetch adds `?_=<time>` to a GET sent with `no-store`; the API answers `no-store` itself.
  `signInAuthorization` builds the sign-in header (`Client`, `Device`, `DeviceId`, `Version`).
- **Types** (`types.ts`) are written by hand from `docs/app-api/v1.openapi.json`, and decoding (`decode.ts`) is
  lenient only where the contract says: unknown fields are ignored, an unknown `state` is `unavailable`, an unknown
  request `status` is `requested`, a `/me` without `apiVersion` is revision 0, an image URL off its field's
  pattern (poster w342, backdrop w780, logo w300) is `null` for that image only, as in the PWA, and a Play link that
  is not exactly the household's own is `null`. Anything else the schema refuses (a wrong type, a missing field, or
  a number, length, item count or pattern outside its limits) is `unexpected`.
- **Errors** are an `ApiError` with a fixed `kind`: `invalid_request` (400, or arguments the API would refuse,
  sent without a call), `unauthorized` (401, or no token), `not_found` (404; `householdNotFound` for
  `household_not_found`), `too_many_requests` (429, with `retryAfterSeconds` when given), `unavailable` (502 and
  any other status), `network` (no answer; `timedOut` after `timeoutMs`, 20 s by default) and `unexpected` (a
  2xx whose body isn't the documented shape, or an answer redirected off the household). An unknown error code is
  read by its status. A caller's `AbortSignal` stops a call with the original `AbortError`, never an `ApiError`.
  An error carries no URL, token or body, and the client logs nothing.
- **No retries.** One request per call. The PWA retries nothing on its own (every retry is a member's tap),
  and a household's devices share one per-address budget (`docs/app-api/fetch-budget.json`).
- **URLs** (`urls.ts`, ported from `app/src/render.ts`): TMDB images at w342, w780 and w1280, logos at w300,
  and Play only as exactly `<household origin>/web/#/details?id=<itemId>`.

**Contract tests.** `__tests__/api-schema.test.ts` reads the server's `docs/app-api/v1.openapi.json` and
`fetch-budget.json` from the repo. They fail when:

- the document has an operation the client lacks, or the other way round;
- an enum differs;
- a fixture in `__tests__/fixtures/app-api` stops matching the document;
- a decoded answer has a field more or less than the document;
- decoding accepts or refuses a value the schema does not (`__tests__/api-decode-constraints.test.ts` tries values
  just inside and just outside every constraint of every answer, and fails on a keyword it cannot try or a
  constrained field no fixture reaches);
- an error status maps to the wrong kind;
- a fetch-budget call takes anything but one request to exactly its path.

The fixtures are synthetic and use only `example.test` addresses. `__tests__/api-client.test.ts` covers lenient
decoding, malformed bodies, every other status, Retry-After, timeouts and aborts, no retries and no secrets in
errors. `__tests__/api-urls.test.ts` covers the address, the allowlists and the headers.

## Run it on a phone with Expo Go

1. Install **Expo Go** from the App Store or, on Android, from Google Play (only Expo Go: the JellyPass app
   itself is never on Play).
2. On the dev box: `cd mobile && pnpm start` (add `--tunnel` if the phone isn't on the same network).
3. Scan the QR code: with the Camera app on iPhone, or from inside Expo Go on Android.

Edits reload on the phone as you save. Expo Go needs no Apple or Google developer account.

## Privacy: no telemetry, no update service

- No analytics, crash-reporting or tracking SDKs. `__tests__/app-config.test.ts` fails if one is added.
- No over-the-air updates: `expo-updates` is not installed and `updates.enabled` is `false`, so a built app
  never checks Expo's servers at launch.
- No Android backup (`allowBackup: false`): the sign-in stays on the device. The `expo-secure-store` config plugin is
  not used, since it would add a Face ID usage string for biometrics the app does not use.
- Expo's **CLI** (`expo start`, `expo lint`) sends anonymous usage telemetry by default. CI sets
  `EXPO_NO_TELEMETRY=1`; set it in your shell too (`export EXPO_NO_TELEMETRY=1`).

## App identity

| | Value | Status |
|---|---|---|
| Name | JellyPass | Keep "Jellyfin" out of the name |
| iOS bundle id | `com.rtc-services.jellypass` | **Final and permanent.** Never change it: a different bundle id is a different app, and TestFlight and every member start over |
| Android package | `com.rtcservices.jellypass` | **Final and permanent.** No hyphen, because Android forbids one. A different package is a different app, and members would have to reinstall and sign in again. Every APK must also be signed with the same key, forever (see [Distribution](#distribution)) |
| Expo owner | `nicklongmore86` | Set in `app.config.ts`. The EAS `projectId` and `eas.json` come with the build PR (`eas init` needs the owner's Expo login) |
| Icon | `assets/icon.png`, `assets/adaptive-icon.png` | Placeholder: the PWA's 512 px icon. The App Store needs 1024 px: draw one with `draw(1024)` from `scripts/make-app-icons.py` before submitting |
| Orientation | iPhone portrait; iPad all four; Android tablets turn freely (`orientation: 'default'`), Android phones locked to portrait at launch | iPad multitasking requires all four |
| URL scheme | `jellypass://` | Setup links: `jellypass://connect?address=https://jelly-<household>.<domain>` |

## What's next

1. **Setup link on the PWA**: a "Set up the app" link on the PWA's Account tab carrying the household's address. Left
   for when the app can be installed (a `jellypass://` link does nothing on a phone without it).
2. **Screens**: tab bar (Home, Search, My requests, Account), Home with its rows and hero, network and studio
   pages, Search, movie/series/season pages with **Get this**, My requests, then an accessibility pass.
3. **Play**: an in-app Jellyfin web view, optionally a Swiftfin hand-off.
4. **Builds**: `eas.json` profiles and EAS Build in the cloud (no Mac needed). iOS goes to TestFlight with
   `eas build --platform ios --auto-submit`; Android is a sideloaded APK (below). These need an Expo account and
   an Apple Developer membership. No Google Play Console account or Play config.

## Distribution

### iOS: TestFlight

Members install TestFlight and accept an invitation; builds come from EAS with `eas build --platform ios
--auto-submit`.

### Android: a sideloaded APK, not Google Play

Android builds are shared as an APK file that members install directly. There is no Play Store listing and
no Play Console configuration in this project.

- **APK, not AAB.** The `preview` and `production` profiles in `eas.json` (a later PR) set
  `"android": { "buildType": "apk" }`. EAS builds an AAB by default, which only Play can install.
- **Members must allow installs from unknown sources.** On Android 8 and later this is a per-app permission:
  the first time they open the APK from their browser or file manager, Android asks them to allow that app to
  install unknown apps (Settings → Apps → Special app access → Install unknown apps). Tell members to grant it
  only to the app they used to open the JellyPass APK.
- **One signing key, forever.** Every APK must be signed with the same key. Android installs an update only if
  its signature matches the installed app's; an APK signed with a different key fails to install over it, and
  the member must uninstall (losing the app's sign-in) and install again. With no Play App Signing to recover
  from, a lost key means every member reinstalls. So:
  - Create the keystore once (EAS-managed credentials, or your own with `keytool`) and use it for every build.
  - Back it up offline, with its passwords, somewhere other than the dev box and Expo's servers. If EAS
    manages it, download a copy with `eas credentials` and store it the same way.
  - Never commit it: `*.jks`, `*.keystore`, `*.p12` and `*.key` are in `.gitignore`.
- **Updates** are a new APK with a higher `android.versionCode`, shared the same way; members install it over
  the old one.
