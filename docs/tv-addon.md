# TV add-on: design and rollout

## Status

Step 1 of 5 (the foundation) is done: behind `TV_ADDON_ENABLED`, off by default, the household gateway adds one
script to Jellyfin web's page on the households listed in `TV_ADDON_HOUSEHOLDS`, and that script adds one
**JellyPass: Trending** row to Jellyfin web's Home. Choosing a card only says that title pages are coming. Title pages
with **Get this**, Search, **My requests** and the Samsung loader app come in later steps (see "Rollout"). Nothing has
been run on a real TV yet (see "What must be checked on a real TV").

The architecture study behind this design is the 2026-10-27 TV study (route 1, "a JellyPass TV module in jellyfin-web").
The owner's decisions for it:

1. **Cross-origin calls** are allowed later, so the Samsung app can call the app API from its own origin with the token
   only (no cookies). Not in step 1, but the add-on already calls the API the way that needs (see "API use").
2. **A build step for TV code only** is allowed: esbuild, targeting ES2017 for Chromium 63. The rest of the repository
   keeps its no-bundler rule (`docs/app-design.md`, "Source and build").
3. **Placement:** a Home row inside Jellyfin web's Home screen, with no menu entry.
4. **Samsung:** a JellyPass build of the Jellyfin app replaces the existing Jellyfin app (later steps, and operations).
5. **JellyQuest** is removed from the TVs (operations).

## How it is delivered

```mermaid
flowchart LR
  TV["Jellyfin web<br/>(LG app, browser)"] -->|"GET /web/"| G["household gateway<br/>(jelly-&lt;id&gt; host)"]
  G -->|"GET /web/, whole, identity"| J[Jellyfin]
  G -->|"page + one &lt;script&gt;"| TV
  TV -->|"GET /jellypass/tv/jellypass-tv.&lt;hash&gt;.js, .css"| G
  TV -->|"GET /jellypass/app/v1/discover/trending<br/>Authorization: MediaBrowser Token"| G
```

- **Settings.** `TV_ADDON_ENABLED` (default `false`) and `TV_ADDON_HOUSEHOLDS`, a comma-separated list of household
  (group) IDs or `*` for every household. The list is required when the add-on is on, so it is switched on for one
  household first. It needs `HOUSEHOLD_APP_ENABLED=true`, because the row reads the app API. Startup stops on an
  invalid value. With the add-on off, or on a household not listed, every path on every host is decided and answered
  exactly as before (`src/household-gateway.ts`: no route decision changes unless the add-on is on for that household).
- **The page.** On a listed household's host only, a `GET` or `HEAD` of Jellyfin web's page (`/web/`,
  `/web/index.html`, in every spelling Jellyfin routes, the `/emby` prefix included) is asked of Jellyfin as a `GET`,
  with `Accept-Encoding: identity` and without `Range`, `If-Range` or any conditional header, so it comes back whole
  and unencoded, and a browser holding an older copy can't be told `304`. A `200` `text/html` answer of at most 1 MiB
  that has a `</head>` gets `<script defer src="/jellypass/tv/jellypass-tv.<hash>.js" data-jellypass-tv></script>`
  just before it.
  - **Never twice:** a page that already has a `data-jellypass-tv` tag is sent as it is.
  - **Headers:** Jellyfin's own (`Content-Type`, any `Content-Security-Policy`, `X-Frame-Options`, `Vary`, …) are kept
    as Jellyfin sent them. `Content-Length` is the new length. `ETag`, `Last-Modified`, `Accept-Ranges`, `Expires`,
    `Age`, `Pragma` and Jellyfin's `Cache-Control` are dropped, because they described the page without the tag. The
    page is sent `Cache-Control`, `CDN-Cache-Control` and `Cloudflare-CDN-Cache-Control: no-store` (as the PWA's page
    is), so neither a browser nor Cloudflare keeps a copy from before or after a change of setting.
  - **Anything else is relayed exactly as Jellyfin sent it:** another status (a `302`, a `500`), another type, an
    encoding Jellyfin used anyway, a page with no `</head>`, a larger page, every other file of Jellyfin web (its HTML
    included), every other path. A `HEAD` gets the `GET`'s headers and no body.
  - **CSP:** Jellyfin sends none for its web client today (none reaches the household host). If one is sent, it is
    relayed unchanged. The script is same-origin, so `script-src 'self'` allows it. A policy that refuses `'self'`
    means the add-on doesn't run, which is the safe outcome.
- **Its files.** `/jellypass/tv/jellypass-tv.<hash>.js` and `.css`, at their exact paths, sent `public,
  max-age=31536000, immutable` with an `ETag` (and a `304` to a matching `If-None-Match`) and `nosniff`. Any other
  `/jellypass/tv` path or method on a listed household's host is a fixed `404 {"error":"not_found"}` that never
  reaches Jellyfin. Unlisted households still relay `/jellypass/tv` to Jellyfin, as before. The script adds the
  stylesheet itself, by its address next to the script's, so the page needs one tag and a later loader needs to add
  only the script.
- **Not on the admin host.** The administrator host never relays to Jellyfin and never serves the add-on. The LAN
  Jellyfin address is untouched too: only household hosts go through the gateway.
- **Why the gateway, not a plugin.** File Transformation or a JavaScript injector plugin would apply to every host,
  the LAN one and the administrator's included, and isn't under JellyPass's tests. The gateway is (study decision D8).

### Tested against

- **The gateway's injection:** the Jellyfin web page that **Jellyfin 10.11.3** serves (`jellyfin/jellyfin:10.11.3`, the
  CI image; `test/real-jellyfin.test.mjs`), as `/web/` and `/web/index.html`, with and without compression asked for.
  Also a simulated page with every header and answer case (`test/tv-addon.test.mjs`).
- **The add-on's use of Jellyfin web:** checked by reading **Jellyfin web 10.11.11**'s built bundle (the one
  jellyfin-tizen 10.11 builds and JellyQuest used: `35c0793`). It covers the Home template, the Home tab's section
  loading, `window.ApiClient`, the focus manager, the scroll manager and `viewshow`. Then it was run in a simulated
  Jellyfin web DOM in the tests.
- **Not yet checked:** Jellyfin web 12.x (the production server runs 12.3.0), and any real TV (see below).

## The add-on

`tv/src/*.ts` and `tv/static/tv.css`, built by `scripts/build-tv.mjs` (part of `pnpm build`) into `dist/tv`.

- **Build.** esbuild bundles `tv/src/main.ts` into one classic script (an IIFE: no modules, no `import`), downlevelled to
  **ES2017**. That is what Chromium 63 parses (Samsung 2019, Tizen 5.0, the oldest measured TV): no `?.`, `??`,
  optional catch binding, object spread or class private syntax. Both files are named `jellypass-tv.<12 hex digits of
  sha256>.<ext>`; the stylesheet is hashed first and its name built into the script. `tsconfig.tv.json` type-checks
  the source with only the ES2017 library, so a later library API (`Object.fromEntries`, `Array.prototype.flat`, …)
  doesn't compile. esbuild is a dev dependency used only here, and its install script is not run
  (`pnpm-workspace.yaml`); its platform package carries the binary.
- **Gates** (`test/tv-addon.test.mjs`):
  - the built script parses with acorn as `ecmaVersion: 2017`, `sourceType: 'script'`;
  - it names no browser API Chromium 63 lacks (`replaceChildren`, `AbortController`, `ResizeObserver`, `queueMicrotask`,
    `structuredClone`, `.flat()`, `.at()`, `focus({preventScroll})`, …). None is polyfilled, because none is used;
  - it uses no `console`, storage, cookies or HTML parsing;
  - the stylesheet uses no flex or grid `gap` (it measures 0 px on M63, which caused JellyQuest's skipping bug), no
    `:focus-visible` (the whole rule would be dropped), `aspect-ratio`, `inset`, logical properties, `:has()` or
    `min()`/`max()`/`clamp()`. Spacing is margins, a poster is a `padding-top: 150%` box, and focus is `:focus`.
- **Jellyfin web coupling** is all in `tv/src/jellyfin-web.ts`, which is the file to check on a Jellyfin web upgrade:
  - `window.ApiClient` (`accessToken()`, `serverAddress()`, `getCurrentUserId()`);
  - Home as `#indexPage` (with `hide` while it is not shown) › `#homeTab` › `.sections.homeSectionsContainer` and its
    `.verticalSection.section0` placeholder, which Jellyfin web writes for every section at once when it loads them;
  - the `viewshow` event that each page dispatches (and which bubbles) as it is shown;
  - the class names the row borrows: `verticalSection` and the section heading's classes, so it lines up with Home's
    own rows, and `focuscontainer-x`.

  If any of it is missing or shaped otherwise, the add-on draws nothing. Every entry point is wrapped so a surprise is
  swallowed, never thrown into Jellyfin web. Nothing is logged, because a message could carry what the page holds.
- **The row.** Once Home is laid out and shown, and Jellyfin web is signed in to **the same origin the script came
  from**, the row is one Home section inserted after Home's first (on a default Home, after **My Media**):
  - the heading **JellyPass: Trending**;
  - up to 20 cards from the first page of `GET /discover/trending`, each a `<button type="button">` with the poster
    (only a URL on the API's `w342` TMDB pattern), the title, the year and the **coarse status** in the app's words:
    "Ready to watch", "Available to get", "Requested", "Can't request". An unknown state is "Can't request", as the
    contract says.

  Everything is set with `textContent`; nothing is parsed as HTML. Jellyfin web redraws Home's sections when its home
  settings change, and a `MutationObserver` (changes gathered for 50 ms) puts the row back. There is never more than one.
- **Remote control.** The add-on runs **no navigation system of its own**. Jellyfin web's focus manager (TV layout)
  moves between focusable elements (any `<button>`) by their place on the screen within the nearest focus container.
  The row's list is a `focuscontainer-x`, so Left and Right stay in the row and Up and Down leave it, as in Home's own
  rows. Jellyfin web's scroll manager scrolls the focused card into view (it listens to `focusin` on a TV). The
  add-on handles no keys: it has no layer of its own, so Back is Jellyfin web's. The focused card gets a 0.3 em
  Jellyfin-cyan ring and a slight scale, drawn with `:focus`. In TV layout (`.layout-tv`) cards are 12.5 em wide.
- **Choosing a card** shows one fixed line under the row: "Coming soon to the TV. To get a title now, use the JellyPass
  app on your phone." It changes nothing else: no navigation, no call.

### API use

- **Where.** Only `https://<the origin the add-on's script came from>/jellypass/app/v1/...`, and only while Jellyfin
  web's `ApiClient.serverAddress()` is that same origin. So a token Jellyfin web holds for one server is only ever sent
  to that server. On LG and in browsers the origin is the household host the page came from. In the later Samsung app
  it is the household host the loader fetched the script from, the same one the member signed in to.
- **How.** `Authorization: MediaBrowser Token="<token>"` and `Accept: application/json`, `credentials: 'omit'`, no
  cookie, no token in a URL, no other header. That is the native-client contract, and it is what a CORS request from
  another origin needs: a later `Access-Control-Allow-Origin: *` plus `Allow-Headers: Authorization` is enough, with no
  credentials mode.
- **The token** is read from `ApiClient.accessToken()` for each request and passed only to that request's header. It is
  never kept in a variable past the call, written to storage, logged or put in the page (tested: no storage use, no
  console call, and the token isn't in the page).
- **Answers.** Read leniently (unknown fields ignored, unknown state as `unavailable`, bad image URLs as no image). Any
  failure (`401`, `404`, `429`, `502`, no network, a body it can't read) or an empty list draws no row. The failure is
  kept like an answer (below), so it is not asked again at once.

### Privacy

The same as the app's. The row shows only Card DTO fields from the allowlist-shaped v1 API, and the server's
guarantees are the server's. A test draws the row in every "other household" world of the app tests (a private grant,
a pending request, a manual grant, a public title outside the household's libraries, large Seerr records) and checks
the row is byte-for-byte the same as with no other household. It also checks the row for the Seerr fixtures' canaries.

As the study noted, Jellyfin web has no CSP of its own and already runs other plugins' scripts on the same origin,
which can read the same token. The add-on adds code to an origin already shared, not a new trust class. It is kept
small, dependency-free and at an exact fingerprinted path.

### Fetch budget

`tv-home-row` in `docs/app-api/fetch-budget.json`: **one call**, `GET /discover/trending`, when Home is first laid out.
The answer (or failure) is kept in memory for the signed-in member:

- Jellyfin web redrawing Home or showing it again **within a minute** asks nothing;
- **staying on Home** asks nothing, however the page changes (no polling);
- **showing Home again after a minute** asks once more, and the old row stays until the new answer replaces it;
- **another member** signing in drops the row at once and asks with their token.

`test/tv-addon.test.mjs` pins all of this against the budget file.

## Rollout

Each step is its own pull request, behind the same settings:

1. **Foundation (this step).** Settings, gateway injection, the build, the Home row (Trending).
2. **Title pages and "Get this".** Choosing a card opens a JellyPass title page inside Jellyfin web: a page or dialog
   container Jellyfin web's focus manager scopes to, with Back closing it (Tizen `10009`, webOS `461`, as Jellyfin
   web maps them). It shows the title's household state and **Play** (to Jellyfin web's own
   `#/details?id=<play.itemId>`, so Jellyfin's TV player plays it), and **Get this** with a season picker for a series.
   It uses the same identical-outcome flow and fixed wording as the PWA, and the same per-screen budget as the PWA's
   title pages.
3. **Search.** A JellyPass search screen reusing Jellyfin web's search field and the TV's own keyboard, with no custom
   keyboard; one call per pause, as the PWA does.
4. **My requests.** The household's requests with their coarse statuses, named ten at a time, as the PWA does.
5. **Samsung loader app (Tizen).**
   - CORS on `/jellypass/app/v1/*` (`*`, no credentials, `Allow-Headers: Authorization`; preflight `204` before any
     token check), with the native-client contract updated, since it reverses "CORS stays off".
   - The add-on's files sent `Cross-Origin-Resource-Policy: cross-origin`, which they may be: they carry nothing
     user-specific.
   - A `jellypass-tizen` build (from `jellyquest-tizen`'s packaging, the overlay dropped) whose only change to
     jellyfin-web is a loader. Once Jellyfin web has its server address, the loader adds
     `<script src="https://<that host>/jellypass/tv/<current name>">`; the current name comes from the household
     host's page, so a JellyPass change needs no resideload.
   - It replaces the Jellyfin app on the households' Samsungs, and JellyQuest is removed from the TVs (operations).

Before step 2, the owner checks step 1 on a real LG TV (below) with one household listed.

## What must be checked on a real TV

On an **LG** (webOS; Jellyfin's LG app loads Jellyfin web from the server inside an iframe), with the add-on on for
that household:

1. **It loads.** The tag is in the page the LG app's iframe loads, the script runs (the row appears), and its
   stylesheet loads. Expected, since other plugins' scripts already run there, but check on the households' webOS
   versions.
2. **Token and API.** The row's one call to `/jellypass/app/v1/discover/trending` returns 200 (same-origin) with
   `ApiClient`'s token.
3. **D-pad.** From **My Media**, Down reaches the row, and Left and Right move one card at a time with no double moves
   and no skipped cards. Down leaves the row to the next Home section and Up returns to it. The focused card's ring is
   visible and the row scrolls to keep it on screen. Back on Home does what it did before.
4. **Choosing a card** (OK) shows the note and nothing else. Playback, the media keys and Back are unaffected, in
   general and right after leaving the row.
5. **Look.** Cards, poster frames and spacing are right: no zero gaps, no collapsed posters, text legible from the
   sofa at 1080p.
6. **Redraws.** Leaving Home and coming back (after playing something, say) keeps one row, and it re-reads after a
   minute. Switching profile shows the new member's row.
7. **Caching.** After the setting is switched off and the app restarted, the row is gone (the page is `no-store`).

On a **Samsung**, nothing appears until step 5, because the sideloaded app bundles its own Jellyfin web. Checking that
nothing changed there is enough for now. In a desktop browser on the household host, the same row appears in Jellyfin
web, which is the easiest first check.

For Chromium 63 itself (Samsung 2019): once step 5 exists, check that the bundle runs (the ES2017 gate covers syntax,
not behaviour), focus is visible, and the cards' layout measures right by geometry (as JellyQuest measured its own).
