# JellyPass mobile app

The household app for iPhone, iPad and Android, built with [Expo](https://expo.dev) (React Native, SDK 58),
TypeScript (strict) and Expo Router. It talks to a household's JellyPass server through the same
`/jellypass/app/v1` API as the PWA, and wears the same Tidepool look: its theme in `src/theme` is ported from
`app/static/app.css`.

**Sign-in, the tab bar and Account work; the browsing screens come next.** The app connects to a household address,
signs a member in, keeps the sign-in in the device's credential store and signs out. Once signed in it has the PWA's
four docked tabs (Home, Search, My requests, Account) with a header and Back, and a finished Account screen; Home,
Search and My requests are one-line placeholders until their screens come (see [What's next](#whats-next)).

`mobile/` is separate from the server: it has its own `package.json` and `pnpm-lock.yaml`, it is excluded from
the Docker build context (`.dockerignore`), and the root `pnpm check`, `pnpm test` and temp-leak check never look
at it. Its CI is `.github/workflows/mobile.yaml`, which runs only when `mobile/`, `app/static/app.css` or `docs/app-api/` changes. Release builds
are `.github/workflows/mobile-release.yaml` ([Release builds](#release-builds)).

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

The Jest suites check the signed-in app's navigation and Account screen (below), sign-in (below), the API client against the server's contract (below), the theme's colour contrast (the same pairs and thresholds as the PWA's
`test/app-pwa.test.mjs`), that every colour token still matches `app/static/app.css`, and the app config's
promises (the final ids, the Expo owner and project ID, rotation, no update service or analytics), and `eas.json`
and the release workflow (`eas-json.test.ts`, [Release builds](#release-builds)). No test makes a network call.

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

Signed in, the Account tab shows "name · household" from `/me`, **Sign out** and **Change household** (below).

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

## The signed-in app (`src/app/(tabs)`, `src/navigation`, `src/screens/AccountScreen.tsx`)

Expo Router: a root stack holding the one sign-in screen (`src/app/index.tsx`), the setup-link route and the `(tabs)`
group. The tabs show only while signed in with no setup link waiting; otherwise the app goes back to the sign-in
screen (and a setup link opened over the tabs leaves no second copy of them behind).

- **Tab bar** (`TabBar.tsx`), the PWA's `.tabbar`: docked full width on the screen's foot over the home indicator,
  rounded at the top, four labelled tabs of equal width: **Home**, **Search**, **My requests**, **Account** (`tabs.ts`
  holds the routes, labels and icons). The icons are the PWA's own (`app/src/icons.ts`, a key for Account), drawn with
  `react-native-svg` from the code. The active tab is a cyan-tint rounded square with a visible cyan outline and a
  heavier icon stroke, so it is shown by shape and weight, not colour alone. iPad has the same bar.
- **Header** (`Header.tsx`), the PWA's `.app-header`: solid navy with a hairline, the screen's title and, on a pushed
  screen, a **Back** button. No wordmark and no (i). Home's header is bare, as in the PWA.
- **Stacks.** Each tab has its own stack (`TabStack.tsx`), so a pushed screen (title pages, from 3.2) keeps its tab and
  the tab bar. A screen pushed from another tab with `withAnchor: true` gets its tab's first screen under it.
- **Back.** The header's Back, the iOS edge swipe and Android's back button pop the tab's stack; Android's back on a
  tab's first screen goes to Home (`backBehavior: 'firstRoute'`), and on Home leaves the app. Nothing goes back to
  the sign-in screens.
- **Width.** A screen's content stops widening at the PWA's 72rem (1152 pt) and Account's at 40rem (640 pt), centred
  on iPad and wide windows, with the side margins clear of the safe areas.
- **Home, Search and My requests** are placeholders: their routes (`/home`, `/search`, `/requests`), titles and tabs
  are final; 3.2 to 3.6 fill them in.

**Account** is the PWA's Account tab. **Account**: the member card ("name · household" from the `/me` the sign-in
checked), **Sign out** (the session's sign-out) and **Change household** (signs out first, then the address step).
**About & credits**, word for word as the PWA (`src/credits.ts`): what JellyPass is, the TMDB logo (the PWA's
`tmdb-logo.svg`, drawn from the code in `src/TmdbLogo.tsx`, so nothing is loaded) linking to TMDB, TMDB's required
notice, where titles and images come from, the JustWatch credit, the app's version and build
(`JellyPass 0.1.0 (build 1)`, from `version`, `ios.buildNumber` and `android.versionCode` in `app.config.ts`) and the
household's API version from `/me`. The links (TMDB and JustWatch only) open in the system browser with
`Linking.openURL`. The screen makes no call of its own.

**Accessibility.** Tabs have the `tab` role, their label, their selected state and "Tab n of 4"; the bar is a
`tablist` named Main. Headings have the `header` role, the links the `link` role, and Back is a named button. Screen
readers go header, screen, then tab bar. Every target is at least 44 pt. Text scales with the system font size
(Dynamic Type, Android font scale) with no cap, line limit or shrinking, and nothing that holds text has a fixed
height or clips, so labels and titles wrap and the bars grow. The colour pairs are checked with the theme's contrast
helper.

**Tests.** `tabs.test.tsx` runs the real `src/app` routes through Expo Router's `renderRouter` with a fake gateway:
the four tabs, their order, icons and active state, moving between them and their header titles, a pushed screen and
Back, Android's back (pop, then Home, then out), setup links over the tabs, the Account card from a mocked `/me`, Sign
out and Change household through the session, the credits, version and API version, the links opening in the
browser, and that nothing but the start-up `/me` is ever sent. Its accessibility part checks the roles, labels and
reading order, the 44 pt targets, that every text on every tab can grow without clipping, the iPad widths and the
contrast pairs. `credits.test.tsx` fails if the logo, the credits' words or the icons drift from the PWA's files.
Queries are `queryAll*` only, so a failure never prints the component tree.

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
  `react-native-svg` only draws the icons and the TMDB logo from the code; it loads nothing.
- No over-the-air updates: `expo-updates` is not installed and `updates.enabled` is `false`, so a built app
  never checks Expo's servers at launch.
- No Android backup (`allowBackup: false`): the sign-in stays on the device. The `expo-secure-store` config plugin is
  not used, since it would add a Face ID usage string for biometrics the app does not use.
- Expo's **CLI** (`expo start`, `expo lint`) sends anonymous usage telemetry by default. CI sets
  `EXPO_NO_TELEMETRY=1`; set it in your shell too (`export EXPO_NO_TELEMETRY=1`). EAS CLI has its own, which the
  release workflow turns off with `DISABLE_EAS_ANALYTICS=1`; do the same before running `eas` yourself.

## App identity

| | Value | Status |
|---|---|---|
| Name | JellyPass | Keep "Jellyfin" out of the name |
| iOS bundle id | `com.rtc-services.jellypass` | **Final and permanent.** Never change it: a different bundle id is a different app, and TestFlight and every member start over |
| Android package | `com.rtcservices.jellypass` | **Final and permanent.** No hyphen, because Android forbids one. A different package is a different app, and members would have to reinstall and sign in again. Every APK must also be signed with the same key, forever (see [Distribution](#distribution)) |
| Expo owner | `rtc-services-llc` (an Expo organization) | Set in `app.config.ts`. Must match the project's owner on expo.dev, or EAS CLI refuses to run |
| EAS project ID | `1db20c4d-4270-404e-acf4-31a8bd6dd591` (`rtc-services-llc/jellypass` on expo.dev) | Set in `app.config.ts` as `extra.eas.projectId`. **Permanent**: EAS keeps the signing credentials and build numbers under it. Not secret |
| Icon | `assets/icon.png`, `assets/adaptive-icon.png` | Placeholder: the PWA's 512 px icon. The App Store needs 1024 px: draw one with `draw(1024)` from `scripts/make-app-icons.py` before submitting |
| Orientation | iPhone portrait; iPad all four; Android tablets turn freely (`orientation: 'default'`), Android phones locked to portrait at launch | iPad multitasking requires all four |
| URL scheme | `jellypass://` | Setup links: `jellypass://connect?address=https://jelly-<household>.<domain>` |

## What's next

1. **Setup link on the PWA**: a "Set up the app" link on the PWA's Account tab carrying the household's address. Left
   for when the app can be installed (a `jellypass://` link does nothing on a phone without it).
2. **Screens**: Home with its rows and hero, network and studio pages, Search, movie/series/season pages with
   **Get this**, My requests, then an accessibility pass. (The tab bar, header, stacks and Account are done.)
3. **Play**: an in-app Jellyfin web view, optionally a Swiftfin hand-off.
4. **First release build**: the owner's one-time setup in [Release builds](#release-builds), then a run of the
   `Mobile release` workflow. No Google Play Console account or Play config.

## Distribution

### iOS: TestFlight

Members install TestFlight and accept an invitation; builds come from EAS through the `Mobile release` workflow
([Release builds](#release-builds)).

### Android: a sideloaded APK, not Google Play

Android builds are shared as an APK file that members install directly. There is no Play Store listing and
no Play Console configuration in this project.

- **APK, not AAB.** The `preview` and `production` profiles in `eas.json` set
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
  - Back it up offline, with its passwords, somewhere other than the dev box and Expo's servers. EAS manages
    it here: download a copy as in [Back up the Android keystore](#back-up-the-android-keystore).
  - Never commit it: `*.jks`, `*.keystore`, `*.p12` and `*.key` are in `.gitignore`.
- **Updates** are a new APK with a higher `android.versionCode`, shared the same way; members install it over
  the old one.

## Release builds

Release builds run on [EAS Build](https://docs.expo.dev/build/introduction/), Expo's cloud builders (macOS for
iOS), started by the GitHub Actions workflow `.github/workflows/mobile-release.yaml`. Nobody needs a Mac, and no
credential is ever on the dev box or in the repo: the workflow's secrets live in the `mobile-release` GitHub
environment, and the signing credentials live on EAS.

- **iOS** goes to TestFlight for internal testing.
- **Android** is an APK that members sideload ([Distribution](#android-a-sideloaded-apk-not-google-play)).

### What's in the repo

`eas.json` has two build profiles, the same for both platforms apart from their name: `preview` for a build to
try, `production` for a release (what a `mobile-v*` tag builds).

| Setting | Why |
|---|---|
| `"distribution": "store"` | An App Store signed iOS build, the only kind TestFlight takes. On Android, a release-signed APK |
| `"android": { "buildType": "apk" }` | An AAB only installs from Google Play ([APK builds](https://docs.expo.dev/build-reference/apk/)) |
| `"cli": { "appVersionSource": "remote" }` and `"autoIncrement": true` | EAS keeps the build number (`ios.buildNumber`, `android.versionCode`) and raises it for every build, so TestFlight never refuses a repeat and every APK installs over the last. The first build is 1 ([App versions](https://docs.expo.dev/build-reference/app-versions/)). The version members see is `version` in `app.config.ts` |
| `"corepack": true` | The builder installs with the pnpm in `package.json`'s `packageManager` |
| `submit.production.ios` | The App Store Connect API key, as `$EXPO_ASC_API_KEY_PATH`, `$EXPO_ASC_KEY_ID` and `$EXPO_ASC_ISSUER_ID`: EAS CLI fills a `$NAME` in those three fields from the environment (its `eas-json` package, `submit/resolver.ts`; the fields are in the [eas.json reference](https://docs.expo.dev/build-reference/eas-json/)), and the workflow sets them from the secrets |

No profile has a `channel`: EAS Update stays off, as `updates.enabled: false` in `app.config.ts` says. `__tests__/eas-json.test.ts` checks
all of this, and that the workflow only runs by hand or from a tag, behind the environment, with pinned actions and
exactly the five secrets.

### How the workflow talks to EAS and Apple

EAS CLI is pinned (`EAS_CLI_VERSION`, 24.12.1; `eas.json` asks for at least that) and always runs with
`--non-interactive`. It reads these environment variables
([Building on CI](https://docs.expo.dev/build/building-on-ci/)):

| Variable | From | Used for |
|---|---|---|
| `EXPO_TOKEN` | secret `EXPO_TOKEN` | Signing in to Expo |
| `EXPO_ASC_API_KEY_PATH` | secret `ASC_API_KEY_P8`, written to `$RUNNER_TEMP/asc-api-key.p8` (mode 0600) and deleted when the job ends, whatever happened | The App Store Connect API key: EAS creates and repairs the iOS provisioning profile with it, and `eas submit` uploads to TestFlight with it |
| `EXPO_ASC_KEY_ID` | secret `ASC_API_KEY_ID` | The key's ID |
| `EXPO_ASC_ISSUER_ID` | secret `ASC_API_ISSUER_ID` | The key's issuer |
| `EXPO_APPLE_TEAM_ID` | secret `APPLE_TEAM_ID` | The Apple Developer team |
| `EXPO_APPLE_TEAM_TYPE` | environment variable `APPLE_TEAM_TYPE`, default `INDIVIDUAL` | `INDIVIDUAL`, `COMPANY_OR_ORGANIZATION` or `IN_HOUSE` |
| `DISABLE_EAS_ANALYTICS`, `EXPO_NO_TELEMETRY` | set to 1 | No usage telemetry from EAS CLI or Expo CLI |

The Apple variables only reach the build step when iOS is being built.

**What EAS does by itself, and what it can't.** Read from EAS CLI's source (`credentials/` at v24.12.1), since the
docs only say "set up credentials locally first":

- **Android keystore:** on the first Android build with no keystore, `--non-interactive` generates one (random
  passwords and alias) and stores it on EAS. Every later build uses it. [Back it up](#back-up-the-android-keystore)
  straight after that first build.
- **iOS provisioning profile:** created, and recreated when it expires or no longer matches, with the App Store
  Connect API key.
- **iOS distribution certificate: not in non-interactive mode.** With none on EAS the build stops with "Credentials
  are not set up. Run this command again in interactive mode." So the owner creates it once, by hand
  ([step 6](#one-time-setup-owner)). It lasts a year; renew it the same way when Apple expires it.
- **`eas submit` needs the app's App Store Connect ID (`ascAppId`)** in non-interactive mode
  ([Submit to the Apple App Store](https://docs.expo.dev/submit/ios/)). It differs per Apple account and is not
  secret, so the workflow adds it to `eas.json` at run time from the `ASC_APP_ID` environment variable.

### One-time setup (owner)

1. **EAS project.** Done: `rtc-services-llc/jellypass` on [expo.dev](https://expo.dev), ID
   `1db20c4d-4270-404e-acf4-31a8bd6dd591`, committed as `extra.eas.projectId` in `app.config.ts` (the workflow refuses
   to build without it). Its owner and slug must stay `rtc-services-llc` (the
   Expo organization) and `jellypass`.
2. **Expo token.** At [expo.dev/settings/access-tokens](https://expo.dev/settings/access-tokens) create a token for
   GitHub Actions ([Programmatic access](https://docs.expo.dev/accounts/programmatic-access/)). The token must belong
   to an account that is a member of the `rtc-services-llc` organization with permission to build (Owner, Admin, Release Manager or
   Developer): a personal token of `nicklongmore86` works while that account holds one of those roles. An
   organization robot user's token with the Developer role (created under the organization's settings) is
   narrower.
3. **App Store Connect API key.** In [App Store Connect](https://appstoreconnect.apple.com), **Users and Access →
   Integrations → App Store Connect API → Team Keys**, generate a key with the **Admin** role. Note its **Key ID** and
   the **Issuer ID** above the table, and download the `.p8` (Apple only lets you download it once). The **Team
   ID** is under **Membership details** at [developer.apple.com/account](https://developer.apple.com/account).
4. **App record.** In App Store Connect, **Apps → + → New App**: iOS, name JellyPass (App Store names are unique, so
   pick another if it's taken: the name on the home screen stays JellyPass), bundle ID `com.rtc-services.jellypass`
   (register it under **Certificates, Identifiers & Profiles → Identifiers** first if it isn't offered), any SKU.
   Open the app's **App Information** and copy its **Apple ID** (digits): that is `ASC_APP_ID`.
5. **GitHub environment.** In the repo, **Settings → Environments → New environment**, name it `mobile-release`.
   Then:
   - **Required reviewers:** tick it and add yourself. Leave **Prevent self-review** off, or nobody can approve
     your own runs.
   - **Deployment branches and tags:** **Selected branches and tags**, then add the branch `main` and the tag
     pattern `mobile-v*`, so a build only ever comes from reviewed code.
   - **Environment secrets → Add environment secret**, five times, with exactly these names:

     | Secret | Value |
     |---|---|
     | `EXPO_TOKEN` | The token from step 2 |
     | `ASC_API_KEY_ID` | The Key ID |
     | `ASC_API_ISSUER_ID` | The Issuer ID |
     | `ASC_API_KEY_P8` | The whole `.p8` file, from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----` |
     | `APPLE_TEAM_ID` | The Team ID |

   - **Environment variables → Add environment variable:** `ASC_APP_ID` (step 4), and `APPLE_TEAM_TYPE` set to
     `COMPANY_OR_ORGANIZATION` only if the Apple membership is an organisation's (it defaults to `INDIVIDUAL`).

   Then delete the downloaded `.p8` from your computer, or keep it only in a password manager.
6. **iOS distribution certificate, once.** On any computer (Linux is fine), in a checkout of `main`: `cd mobile && pnpm install && npx eas-cli@24.12.1 credentials --platform ios`. Sign in to
   Expo, pick the `production` profile, then **Build Credentials → All: Set up all the required credentials to build
   your project**, and sign in with your Apple ID when asked. EAS makes the distribution certificate and keeps it.
   This is the only interactive step; every build after it runs from the workflow.
7. **TestFlight testers.** Internal testers must be users on your App Store Connect team: invite each member in
   **Users and Access** with the **Marketing** role (the least-privileged role Apple allows for internal testers;
   some roles can't be internal testers, see [internal testers](https://developer.apple.com/help/glossary/internal-testers/)),
   limited to the JellyPass app. Then, after the first upload,
   the app's **TestFlight** tab → **Internal Testing → +**, create a group (say "Household"), turn on automatic
   distribution, and add them. Up to 100 internal testers; they need no Beta App Review.

### Back up the Android keystore

Do this right after the first Android build, and keep the copy for as long as the app exists. Every JellyPass
APK must be signed with this one key: Android installs an update only over an app signed with the same key, and
with no Google Play to re-sign for us, a lost key means every member uninstalls (losing their sign-in) and installs
afresh.

```sh
cd mobile
npx eas-cli@24.12.1 credentials --platform android
```

Pick the `production` profile, then **Keystore: Manage everything needed to build your project → Download existing
keystore**. When EAS asks whether to display sensitive information, answer **yes**: otherwise it saves the `.jks`
file without printing the passwords. It then prints the keystore password, key alias and key password. Store all four
together, offline and somewhere other than the dev box (a password manager plus an offline copy), and delete the
local file. Never commit it (`*.jks` is in `.gitignore`). ([App credentials](https://docs.expo.dev/app-signing/app-credentials/))

### Run a build

**By hand:** **Actions → Mobile release → Run workflow**, choose:

- **platform:** `all`, `ios` or `android`;
- **profile:** `preview` or `production`;
- **Send the iOS build to TestFlight:** on or off.

**From a tag:** push a `mobile-v*` tag (for example `mobile-v0.1.0`, matching `version` in `app.config.ts`). It
builds both apps with `production` and sends iOS to TestFlight.

Each run first runs the mobile checks (`pnpm check`) with no secrets in reach, then waits for your approval as
the `mobile-release` reviewer. It then checks the Expo token (`eas whoami`, `eas project:info`; see
[When a release fails](#when-a-release-fails)), builds on EAS (`eas build --non-interactive --wait --json`) and, for iOS,
uploads that build (`eas submit --platform ios --profile production --id <build> --non-interactive`). On EAS's free
plan builds queue at low priority, so a run can take an hour or more; the job allows five hours. The run's summary
lists each build's page on expo.dev and the Android APK's download link. That summary is public on a public repo:
the APK holds no household address, so the link is fine to show.

**TestFlight builds expire after 90 days.** A commented-out monthly `schedule` in the workflow can keep one current;
uncomment it to turn it on (it still waits for your approval).

### Install

**iPhone and iPad:** install **TestFlight** from the App Store, accept the email invitation (or open the TestFlight
link) with the Apple ID you were invited as, and tap **Install**. New builds appear in TestFlight; turn on automatic
updates there.

**Android:**

1. Open the APK link from the run's summary on the phone and download it.
2. Open the downloaded file. The first time, Android asks to allow the browser (or file manager) to install
   unknown apps: tap **Settings**, turn on **Allow from this source**, and go back. Allow it only for that app.
3. Tap **Install**. Later APKs install the same way, over the old one, keeping the sign-in.

### When a release fails

**"Error: GraphQL request failed."** is EAS CLI's summary of an error from Expo's API. The reason is a line printed
before it; under `--json` that line can go to stdout, into `builds.json`, which is why the log once showed only the
summary (run 40404852233). **Build on EAS** now prints it when the build fails. Almost always it is the token: the
`EXPO_TOKEN` secret on the `mobile-release` environment is missing, revoked or mistyped, or the account it belongs to
is not a member of the `rtc-services-llc` Expo organization with a role that can build (Owner, Admin, Release Manager
or Developer; a Viewer can read the project but not build it). The project belongs to the organization, not to a
personal account, so a valid personal token whose account isn't in the organization fails the same way.

The step **Check the Expo token can build the project** catches this before a build is spent. It prints who the token
signs in as and its role in each organization (`eas whoami`, with the email line left out), and fails with the likely
cause when the token is refused, the account isn't in `rtc-services-llc`, its role there is Viewer, or the project
can't be read (`eas project:info`). The token itself is never printed. To fix it, make a new token ([step
2](#one-time-setup-owner)) or give its account a build role under the organization's **Members** settings on
expo.dev, then replace the `EXPO_TOKEN` environment secret. To check a token locally without leaving it in shell
history: `read -rs EXPO_TOKEN && export EXPO_TOKEN && cd mobile && npx eas-cli@24.12.1 whoami && npx eas-cli@24.12.1
project:info`.

If **Build on EAS** still fails, its log shows EAS CLI's messages (stderr as usual, and the `message` fields of
whatever it wrote to stdout instead of the build list, or the first 4000 bytes if that isn't JSON). `EXPO_DEBUG`
stays off in CI: it dumps whole error objects, request context included. **Report the builds** only runs after a
successful build, and says so if the build list isn't valid JSON.
