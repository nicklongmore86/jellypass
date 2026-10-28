import { ABOUT_PATH, renderAbout } from './about.js';
import { Asked } from './asked.js';
import { isHomeShown, isSearchShown } from './jellyfin-web.js';
import { PageHost } from './page-host.js';
import { HomeRow } from './row.js';
import { SearchRow } from './search.js';
import { TITLE_PATH, TitlePage, titleHash } from './title.js';

/**
 * The JellyPass TV add-on's entry (docs/tv-addon.md): one classic script that the household gateway adds to Jellyfin
 * web's page, built by scripts/build-tv.mjs to ES2017 for the TVs' Chromium 63. It waits for Jellyfin web's Home and adds
 * the JellyPass row to it, and one to Jellyfin web's Search page when something is searched for; a card opens the
 * JellyPass title page, a page of Jellyfin web's own (page-host.ts). It handles no key. It calls only the household app API, on the origin this script was loaded from.
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
  });
  const navigate = (hash: string) => {
    location.hash = hash;
  };
  const title = new TitlePage(document, api, base.origin, asked, { changed: () => safely(() => row.update()), navigate });
  const row: HomeRow = new HomeRow(document, api, base.origin, asked, (card) => navigate(titleHash(card.mediaType, card.tmdbId)));
  const search: SearchRow = new SearchRow(document, api, base.origin, asked, (card) => navigate(titleHash(card.mediaType, card.tmdbId)));
  // JellyPass pages at #/jellypass/..., in Jellyfin web's own "page not found" page (tv/src/page-host.ts).
  const host = new PageHost(document, () => location.hash);
  host.register(ABOUT_PATH, renderAbout);
  host.register(TITLE_PATH, (context) => title.render(context));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      safely(() => host.update());
      safely(() => title.update());
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
  window.addEventListener('hashchange', () => safely(() => host.update()));
  safely(() => host.update());
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
