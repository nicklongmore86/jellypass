import { ABOUT_PATH, renderAbout } from './about.js';
import { Asked } from './asked.js';
import { DiscoverData } from './discover-data.js';
import { DiscoverEntry } from './discover-entry.js';
import { DISCOVER_HASH, DISCOVER_PATH, LIST_PATH, SERVICE_PATH, STUDIO_PATH } from './discover-model.js';
import { HidePreference } from './discover-preference.js';
import { SourcePage } from './discover-source.js';
import { DiscoverPage } from './discover.js';
import { HistoryTrail } from './history-trail.js';
import { isHomeShown, isSearchShown } from './jellyfin-web.js';
import { PageHost } from './page-host.js';
import { RequestsPage } from './requests.js';
import { REQUESTS_HASH, REQUESTS_PATH } from './requests-model.js';
import { HomeRow } from './row.js';
import { SearchRow } from './search.js';
import { SessionWatch } from './session-watch.js';
import { TITLE_PATH, TitlePage, titleHash } from './title.js';

/**
 * The JellyPass TV add-on's entry (docs/tv-addon.md): one classic script that the household gateway adds to Jellyfin
 * web's page, built by scripts/build-tv.mjs to ES2017 for the TVs' Chromium 63. It waits for Jellyfin web's Home and adds
 * the JellyPass row to it, and one to Jellyfin web's Search page when something is searched for; a card opens the
 * JellyPass title page, a page of Jellyfin web's own (page-host.ts); a compass button in Jellyfin's header opens the Discover page. It handles no key. It calls only the household app API, on the origin this script was loaded from.
 */

/** The stylesheet's built (fingerprinted) name, next to this script; written in by scripts/build-tv.mjs. */
declare const __JELLYPASS_TV_CSS__: string;

const MARKER = 'data-jellypass-tv';
/** How long page changes are gathered before the row checks Home again, in milliseconds. */
const SETTLE_MS = 50;

function start(): void {
  const scope = window as unknown as Window & { __jellypassTv?: boolean };
  // One add-on per page, whatever loaded it twice.
  if (scope.__jellypassTv) return;
  scope.__jellypassTv = true;
  const script = (document.currentScript ?? document.querySelector(`script[${MARKER}]`)) as HTMLScriptElement | null;
  const source = script?.getAttribute('src');
  if (!source) return;
  let base: URL;
  try {
    base = new URL(source, location.href);
  } catch {
    return;
  }
  const stylesheet = document.createElement('link');
  stylesheet.setAttribute('rel', 'stylesheet');
  stylesheet.setAttribute('href', new URL(__JELLYPASS_TV_CSS__, base.href).href);
  stylesheet.setAttribute(MARKER, '');
  document.head.appendChild(stylesheet);

  const api = { get ApiClient() { return (window as unknown as { ApiClient?: unknown }).ApiClient; }, fetch: (url: string, init: RequestInit) => window.fetch(url, init) };
  // What the member just asked for: in memory only, shared by the row and the title page.
  const asked = new Asked(() => performance.now(), () => Date.now(), () => {
    safely(() => row.overlayExpired());
    safely(() => search.overlayChanged());
    safely(() => title.overlayExpired());
    safely(() => discover.overlayChanged());
    safely(() => sources.overlayChanged());
  });
  const navigate = (hash: string) => {
    location.hash = hash;
  };
  const title = new TitlePage(document, api, base.origin, asked, { changed: () => { safely(() => row.update()); safely(() => discover.overlayChanged()); safely(() => sources.overlayChanged()); }, navigate });
  const row: HomeRow = new HomeRow(document, api, base.origin, asked, (card) => navigate(titleHash(card.mediaType, card.tmdbId)), () => navigate(REQUESTS_HASH));
  // A cancel in My requests puts the title back to Get this: Home's row and the Search row draw from the same overlay.
  const requests = new RequestsPage(document, api, base.origin, asked, { changed: () => { safely(() => row.update()); safely(() => search.overlayChanged()); safely(() => discover.overlayChanged()); safely(() => sources.overlayChanged()); }, navigate }, () => performance.now(), () => Date.now());
  // The Discover page's answers (kept ten minutes, in memory) are timed on the monotonic clock, and the wall clock catches a long sleep.
  const discoverWatch = new SessionWatch(api, base.origin);
  const discoverData = new DiscoverData(api.fetch, base.origin, discoverWatch, () => performance.now(), () => Date.now());
  // "New only" is one choice for the Discover page and the service and studio pages.
  const hide = new HidePreference();
  const sources: SourcePage = new SourcePage(document, discoverWatch, discoverData, asked, { navigate }, hide);
  const discover = new DiscoverPage(document, discoverWatch, discoverData, asked, { navigate, openService: (id, list) => sources.prefer(id, list) }, hide);
  const discoverEntry = new DiscoverEntry(document, discoverWatch, () => navigate(DISCOVER_HASH));
  const search: SearchRow = new SearchRow(document, api, base.origin, asked, (card) => navigate(titleHash(card.mediaType, card.tmdbId)));
  // JellyPass pages at #/jellypass/..., in Jellyfin web's own "page not found" page (tv/src/page-host.ts).
  // Back on a JellyPass page (shown only where Jellyfin's header has none of its own): history when the member came from another page of Jellyfin web, else Home.
  // The trail is the session's: a sign-out, another member or a new token starts it again, so no one inherits Back destinations.
  const trail = new HistoryTrail(location.hash);
  let trailGeneration = discoverWatch.snapshot();
  const trailSession = () => {
    const now = discoverWatch.snapshot();
    if (now === trailGeneration) return;
    trailGeneration = now;
    trail.reset(location.hash);
  };
  const host = new PageHost(document, () => location.hash, () => {
    trailSession();
    if (trail.canGoBack && typeof window.history === 'object' && window.history && typeof window.history.back === 'function') window.history.back();
    else navigate('#/home');
  }, () => discoverWatch.snapshot());
  host.register(ABOUT_PATH, renderAbout);
  host.register(TITLE_PATH, (context) => title.render(context));
  host.register(REQUESTS_PATH, (context) => requests.render(context));
  host.register(DISCOVER_PATH, (context) => discover.render(context));
  host.register(SERVICE_PATH, (context) => sources.renderService(context));
  host.register(STUDIO_PATH, (context) => sources.renderStudio(context));
  host.register(LIST_PATH, (context) => sources.renderList(context));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      safely(trailSession);
      safely(() => host.update());
      safely(() => title.update());
      safely(() => requests.update());
      safely(() => discover.update());
      safely(() => sources.update());
      safely(() => discoverEntry.update());
      safely(() => row.update());
      safely(() => search.update());
    }, SETTLE_MS);
  };
  new MutationObserver(settle).observe(document.body ?? document.documentElement, { childList: true, subtree: true });
  // Every document listener is a capturing, passive one: it observes, and can neither stop nor prevent what Jellyfin web does.
  const listen = (type: string, run: (event: Event) => void) => document.addEventListener(type, run, { capture: true, passive: true });
  listen('viewshow', (event) => {
    if (isHomeShown(event)) safely(() => row.homeShown());
    if (isSearchShown(event)) safely(() => search.shown());
  });
  // The search field being typed in changes no element, so the page's changes alone would not show it.
  listen('input', () => safely(() => search.update()));
  listen('focusin', (event) => safely(() => host.focusIn(event)));
  for (const type of ['keydown', 'pointerdown', 'mousedown', 'touchstart']) {
    listen(type, () => {
      safely(() => host.userInput());
      safely(() => row.userInput());
      safely(() => search.userInput());
    });
  }
  listen('pageshow', (event) => safely(() => host.pageShown(event)));
  // A hash change is seen at once, so Jellyfin web's "Page not found" is hidden before it is drawn.
  window.addEventListener('hashchange', () => {
    safely(trailSession);
    safely(() => trail.changed(location.hash));
    safely(() => host.update());
  });
  safely(() => host.update());
  safely(() => discoverEntry.update());
  row.update();
  search.update();
}

/** Never lets the add-on break Jellyfin web: on any surprise it simply is not there. */
function safely(run: () => void): void {
  try {
    run();
  } catch {
    // Nothing is logged: a message could carry what the page holds.
  }
}

safely(start);
