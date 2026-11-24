# App Store submission: JellyPass for iPhone and iPad

What to enter in [App Store Connect](https://appstoreconnect.apple.com) for the first public release. The app record,
bundle id (`com.rtc-services.jellypass`) and TestFlight builds already exist ([Release builds](../README.md#release-builds)).
Character limits are Apple's; every text below fits.

Nothing here is secret. The demo household's address and profile are **not** written here: they are the
`MOBILE_SCREENSHOT_ADDRESS` and `MOBILE_SCREENSHOT_PROFILE` repository secrets, typed into App Store Connect by hand.

## Before pressing Submit

- [ ] A release with the **Request** wording and **Failed** filter wording (app 1.6.1) is on TestFlight. The screenshots below show it.
- [ ] The demo household's server is up and stays up until the app is approved, and the demo profile signs in.
- [ ] **Request on the demo household asks for nothing real.** The reviewer will press it. The demo profile's Seerr
      user must have auto-approve off (or the demo household must not reach Seerr at all), so a reviewer's request never
      starts a download.
- [ ] The demo library has only the Blender open films (Sintel, Tears of Steel, Caminandes and the rest), so the
      reviewer and the screenshots see no copyrighted posters beyond the TMDB artwork on Discover rows.
- [ ] jellypass.app's privacy and support pages use the new wording ("Request", not "Get this").
- [ ] Screenshots from the `Mobile screenshots` workflow (iPhone 6.9" and iPad 13", nine each) for the 1.6.1 build.

## App Information

| Field | Value |
|---|---|
| Name (30) | `JellyPass` (if Apple says it is taken: `JellyPass Household`) |
| Subtitle (30) | `Browse and request together` |
| Primary category | Entertainment |
| Secondary category | Utilities |
| Content rights | **Yes**, the app shows third-party content: film and series details and artwork from TMDB (used under TMDB's API terms, with the required credit in Account → About & credits) and streaming availability from JustWatch (credited the same way). |
| Age rating | See [Age rating](#age-rating) |
| Copyright | `2026 RTC Services LLC` |
| Support URL | `https://jellypass.app/support/` |
| Marketing URL | `https://jellypass.app/` |
| Privacy Policy URL | `https://jellypass.app/privacy/` |

Keep "Jellyfin", "Seerr", "Plex" and other product names out of the name, subtitle and keywords (App Review
Guideline 2.3.7 and 5.2.1). The description may say the app works with Jellyfin, as a plain statement of compatibility.

## Version page (1.6.1)

### Promotional text (170)

```
See what your household has, find something new, and request it in one tap. Follow every request until it's ready to watch.
```

### Description (4000)

```
JellyPass is the companion app for households that share a JellyPass media server. See what your household already has, find what's new, request what's missing, and follow each request until it's ready to watch.

You need an account on a JellyPass household server, given to you by the person who runs it. The app doesn't come with any films or shows of its own: it shows your household's library and lets you ask for more.

DISCOVER
• Trending, popular and upcoming films and series, by network and studio
• Every title shows where your household stands: Ready to watch, Available to request, or Requested
• Hide what you're not interested in

REQUEST
• Tap Request on a film or series and your household's server is asked to add it
• Pick the seasons you want, or request all missing seasons at once
• Request a whole film series from its collection page

MY REQUESTS
• Follow everything your household has asked for, and who asked
• Cancel a request you no longer want

PRIVATE BY DESIGN
• No analytics, no tracking, no ads
• Your sign-in stays in the iPhone Keychain, on this device only
• Everything goes only to your own household's server; the developer receives nothing

Works with your household's self-hosted Jellyfin server: Play opens the title in your household's Jellyfin. JellyPass is an unofficial companion app and isn't affiliated with Jellyfin or Seerr.

Film and series details and artwork from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability from JustWatch.
```

### Keywords (100)

```
media server,self-hosted,household,family,request,movies,tv shows,watchlist,library,homelab
```

### Other version fields

| Field | Value |
|---|---|
| Build | The 1.6.1 build from TestFlight |
| Version release | **Manually release this version** (release it when the site and the household server are ready) |
| What's New | Not shown for a first App Store version |

## App Review Information

| Field | Value |
|---|---|
| Sign-in required | Yes |
| User name | The demo profile's name (`MOBILE_SCREENSHOT_PROFILE`) |
| Password | The demo profile's password. If the profile has none, set one for the review so this field is not empty, and say so in the notes |
| Contact | The owner's name, phone and `support@jellypass.app` |

### Notes (4000)

Replace `<ADDRESS>`, `<PROFILE>` and `<PASSWORD>` with the demo household's values before pasting.

```
JellyPass is a companion app for members of a household that shares a self-hosted media server (Jellyfin, with JellyPass in front of it). The household's administrator runs the server and gives each member an account; the app has no sign-up and no content of its own.

We have set up a demo household for review:

1. Open the app. On "Connect to your household", enter the address: <ADDRESS>
2. Tap "Connect to your household", then tap the profile "<PROFILE>" and sign in with the password: <PASSWORD>

What to try:
• Home shows the demo library and Discover rows. The demo library holds only the Blender Foundation's open films (Creative Commons licensed), e.g. Sintel, Tears of Steel and Caminandes.
• Search for "Sintel" and open it: it is Ready to watch. Play opens the title in the household's own Jellyfin web page in Safari.
• Open any title marked "Available to request" and tap Request. This sends a request to the household's own server, where the household's administrator decides whether to add the title to their own server. On this demo household requests are never fulfilled. The request appears under My requests, where it can be cancelled.

About "Request": the app does not download, stream from, or link to any third-party source. A request is a note to the household's administrator, on the household's own server, asking them to add a title to the library they run. It works like a shared wishlist.

The app collects no data: no analytics, tracking or advertising SDKs, and nothing is sent to the developer. Everything goes only to the server address the member enters. Posters are loaded from TMDB's image server under TMDB's API terms (credited in Account > About & credits).

JellyPass is not affiliated with Jellyfin or Seerr; the app says so in Account > About & credits.
```

## App Privacy

**Data Not Collected.** In App Store Connect: App Privacy → Get Started → "No, we do not collect data from this app."

Why that is the right answer under Apple's definition (data "collected" means sent off the device where the developer
or its partners can access it beyond servicing the request in real time):

- The app has no analytics, crash reporting, advertising or tracking SDK (`__tests__/app-config.test.ts` fails if one is
  added), and `NSPrivacyTracking` is false.
- Everything the app sends goes to the household server the member typed in, run by the household's administrator, not
  by the developer. The developer has no access to it.
- Posters load from `image.tmdb.org` as plain image requests, with no account data.

If this ever changes (a crash reporter, a developer-run server), this answer and the privacy policy must change first.

## Age rating

Apple's questionnaire (App Information → Age Rating). Suggested answers; the owner decides:

| Question | Answer | Why |
|---|---|---|
| Parental controls, age assurance | No | |
| Unrestricted web access | No | Links open only allow-listed pages (the household's Jellyfin, TMDB, JustWatch, jellypass.app) in Safari |
| User-generated content, messaging, chat | No | |
| Advertising | No | |
| Gambling, contests, loot boxes | No | |
| Violence (cartoon, realistic), mature or suggestive themes, horror, profanity, alcohol/tobacco/drugs | **Infrequent/Mild** | Discover rows show trending films' posters and synopses from TMDB, which can include R-rated films |
| Sexual content or nudity | None | TMDB's adult titles are not shown |
| Medical or wellness | No | |

With "Infrequent/Mild" for the themes above, Apple's calculator gives about **13+**.

## Pricing and Availability

| Field | Value |
|---|---|
| Price | Free |
| Availability | All countries and regions |
| Distribution | Public (on the App Store, searchable) |
| iPad | Yes (already supported; the 13" screenshots are required) |
| Apple silicon Macs | Off ("Make this app available" unticked): untested |
| Apple Vision Pro | Off |

**EU Digital Services Act:** App Store Connect asks whether you're a trader. RTC Services LLC distributes the app, so
answer **trader** and give the business address, phone and email Apple shows on the EU listing (`support@jellypass.app`
is fine for email). If you'd rather not publish them, untick the EU countries in Availability instead.

## Export compliance

Nothing to answer: `ITSAppUsesNonExemptEncryption` is `false` (standard HTTPS only); see
[Distribution](../README.md#ios-testflight).

## Screenshots

From the `Mobile screenshots` workflow (Actions → Mobile screenshots → Run workflow on `main` after the 1.6.1 merge (#195)),
artifact `screenshots`, in listing order:

| # | File | Shows |
|---|---|---|
| 1 | `01-sintel.png` | A film Ready to watch, with Play |
| 2 | `02-tears-of-steel.png` | A film page |
| 3 | `03-request-metropolis.png` | A public-domain film Available to request, with the Request button |
| 4 | `04-search.png` | Search |
| 5 | `05-my-requests.png` | My requests |
| 6 | `06-llama-drama.png` | A title page |
| 7 | `07-caminandes-collection.png` | A film collection |
| 8 | `08-home.png` | Home. Its banner and Discover posters are TMDB artwork of copyrighted films: optional, leave it out to show only open and public-domain films |
| 9 | `09-sign-in.png` | Connect to your household (check it shows no address you don't want public) |

Upload `iphone-6.9/*` under **iPhone 6.9" Display** and `ipad-13/*` under **iPad 13" Display**. Apple scales them for
smaller devices.
